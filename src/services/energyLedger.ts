import { query, pool } from '../db/client.js';
import { getTaskDef, ENERGY_TASKS } from '../config/energyTasks.js';
import {
  ensureEnergyAccount,
  getEnergyAccount,
  type EnergyAccountDto,
} from './energy.js';

export interface EnergyTransactionDto {
  id: string;
  type: string;
  amount: number;
  description: string;
  sourceId: string | null;
  createdAt: string;
}

function streakBonus(streakDays: number): number {
  if (streakDays < 4) return 0;
  if (streakDays < 8) return 10;
  if (streakDays < 15) return 20;
  if (streakDays < 31) return 35;
  return 50;
}

function todayStr(): string {
  return new Date().toISOString().split('T')[0]!;
}

async function withClient<T>(fn: (client: import('pg').PoolClient) => Promise<T>): Promise<T> {
  if (!pool) throw new Error('PG pool not available in PGlite mode');
  const client = await pool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

export async function listTransactions(userId: string, limit = 50): Promise<EnergyTransactionDto[]> {
  const row = await query<{
    id: string;
    type: string;
    amount: number;
    description: string;
    source_id: string | null;
    created_at: Date;
  }>(
    `SELECT id, type, amount, description, source_id, created_at
     FROM energy_transactions
     WHERE user_id = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [userId, limit],
  );
  return row.rows.map((r) => ({
    id: r.id,
    type: r.type,
    amount: r.amount,
    description: r.description,
    sourceId: r.source_id,
    createdAt: r.created_at.toISOString(),
  }));
}

export async function getTaskProgress(userId: string) {
  const today = todayStr();
  const counts = await query<{ task_id: string; completed_count: number }>(
    `SELECT task_id, completed_count FROM energy_task_daily
     WHERE user_id = $1 AND usage_date = $2::date`,
    [userId, today],
  );
  const map = new Map(counts.rows.map((r) => [r.task_id, r.completed_count]));
  return ENERGY_TASKS.map((t) => {
    const completedCount = map.get(t.id) ?? 0;
    return {
      id: t.id,
      name: t.name,
      reward: t.reward,
      dailyLimit: t.dailyLimit,
      completedCount,
      isCompleted: completedCount >= t.dailyLimit,
    };
  });
}

export async function spendEnergy(
  userId: string,
  amount: number,
  description: string,
  sourceId: string,
): Promise<{ success: boolean; account: EnergyAccountDto; duplicate?: boolean }> {
  if (amount <= 0) {
    const account = await ensureEnergyAccount(userId);
    return { success: false, account };
  }

  return withClient(async (client) => {
    const dup = await client.query(
      `SELECT id FROM energy_transactions WHERE source_id = $1`,
      [sourceId],
    );
    if (dup.rows[0]) {
      const account = await ensureEnergyAccount(userId);
      return { success: true, account, duplicate: true };
    }

    const acc = await client.query<{ balance: number }>(
      `SELECT balance FROM energy_accounts WHERE user_id = $1 FOR UPDATE`,
      [userId],
    );
    const balance = acc.rows[0]?.balance ?? 0;
    if (balance < amount) {
      const account = await ensureEnergyAccount(userId);
      return { success: false, account };
    }

    await client.query(
      `INSERT INTO energy_transactions (user_id, type, amount, description, source_id)
       VALUES ($1, 'spend', $2, $3, $4)`,
      [userId, amount, description, sourceId],
    );
    await client.query(
      `UPDATE energy_accounts
       SET balance = balance - $2, total_spent = total_spent + $2,
           version = version + 1, updated_at = NOW()
       WHERE user_id = $1`,
      [userId, amount],
    );

    const account = (await getEnergyAccount(userId))!;
    return { success: true, account };
  });
}

export async function earnEnergy(
  userId: string,
  amount: number,
  description: string,
  sourceId: string,
): Promise<{ earned: number; account: EnergyAccountDto; duplicate?: boolean }> {
  if (amount <= 0) {
    const account = await ensureEnergyAccount(userId);
    return { earned: 0, account };
  }

  return withClient(async (client) => {
    const dup = await client.query(
      `SELECT id FROM energy_transactions WHERE source_id = $1`,
      [sourceId],
    );
    if (dup.rows[0]) {
      const account = await ensureEnergyAccount(userId);
      return { earned: 0, account, duplicate: true };
    }

    const accRow = await client.query<{
      daily_earned: number;
      daily_cap: number;
    }>(
      `SELECT daily_earned, daily_cap FROM energy_accounts WHERE user_id = $1 FOR UPDATE`,
      [userId],
    );
    let earn = amount;
    const dailyEarned = accRow.rows[0]?.daily_earned ?? 0;
    const dailyCap = accRow.rows[0]?.daily_cap ?? 200;
    if (dailyEarned + earn > dailyCap) {
      earn = dailyCap - dailyEarned;
    }
    if (earn <= 0) {
      const account = await ensureEnergyAccount(userId);
      return { earned: 0, account };
    }

    await client.query(
      `INSERT INTO energy_transactions (user_id, type, amount, description, source_id)
       VALUES ($1, 'earn', $2, $3, $4)`,
      [userId, earn, description, sourceId],
    );
    await client.query(
      `UPDATE energy_accounts
       SET balance = balance + $2, total_earned = total_earned + $2,
           daily_earned = daily_earned + $2,
           version = version + 1, updated_at = NOW()
       WHERE user_id = $1`,
      [userId, earn],
    );

    const account = (await getEnergyAccount(userId))!;
    return { earned: earn, account };
  });
}

export async function completeTask(
  userId: string,
  taskId: string,
): Promise<{ success: boolean; earned: number; account: EnergyAccountDto }> {
  const def = getTaskDef(taskId);
  if (!def) {
    const account = await ensureEnergyAccount(userId);
    return { success: false, earned: 0, account };
  }

  const today = todayStr();

  await query(
    `INSERT INTO energy_task_daily (user_id, task_id, usage_date, completed_count)
     VALUES ($1, $2, $3::date, 0)
     ON CONFLICT (user_id, task_id, usage_date) DO NOTHING`,
    [userId, taskId, today],
  );

  const row = await query<{ completed_count: number }>(
    `SELECT completed_count FROM energy_task_daily
     WHERE user_id = $1 AND task_id = $2 AND usage_date = $3::date`,
    [userId, taskId, today],
  );
  const count = row.rows[0]?.completed_count ?? 0;
  if (count >= def.dailyLimit) {
    const account = await ensureEnergyAccount(userId);
    return { success: false, earned: 0, account };
  }

  await query(
    `UPDATE energy_task_daily SET completed_count = completed_count + 1
     WHERE user_id = $1 AND task_id = $2 AND usage_date = $3::date`,
    [userId, taskId, today],
  );

  const earn = await earnEnergy(
    userId,
    def.reward,
    `完成任务：${def.name}`,
    `task:${taskId}:${today}:${count + 1}`,
  );
  return {
    success: earn.earned > 0,
    earned: earn.earned,
    account: earn.account,
  };
}

export async function checkIn(userId: string): Promise<{
  isNewDay: boolean;
  streakBonus: number;
  account: EnergyAccountDto;
}> {
  const today = todayStr();
  const sourceId = `checkin:${today}`;

  const accountBefore = await ensureEnergyAccount(userId);
  if (accountBefore.lastCheckIn === today) {
    return { isNewDay: false, streakBonus: 0, account: accountBefore };
  }

  return withClient(async (client) => {
    const dup = await client.query(
      `SELECT id FROM energy_transactions WHERE source_id = $1`,
      [sourceId],
    );
    if (dup.rows[0]) {
      const account = await ensureEnergyAccount(userId);
      return { isNewDay: false, streakBonus: 0, account };
    }

    const acc = await client.query<{
      streak_days: number;
      max_streak_days: number;
      last_check_in: string | null;
    }>(
      `SELECT streak_days, max_streak_days, last_check_in FROM energy_accounts
       WHERE user_id = $1 FOR UPDATE`,
      [userId],
    );
    const row = acc.rows[0]!;
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayStr = yesterday.toISOString().split('T')[0]!;

    let streakDays = row.streak_days;
    if (row.last_check_in === yesterdayStr) {
      streakDays += 1;
    } else if (row.last_check_in !== today) {
      streakDays = 1;
    }
    const maxStreak = Math.max(row.max_streak_days, streakDays);
    const bonus = streakBonus(streakDays);

    await client.query(
      `UPDATE energy_accounts
       SET streak_days = $2, max_streak_days = $3, last_check_in = $4::date,
           daily_earned = 0, version = version + 1, updated_at = NOW()
       WHERE user_id = $1`,
      [userId, streakDays, maxStreak, today],
    );

    if (bonus > 0) {
      await earnEnergy(userId, bonus, `连续打卡${streakDays}天奖励`, sourceId);
    } else {
      await client.query(
        `INSERT INTO energy_transactions (user_id, type, amount, description, source_id)
         VALUES ($1, 'earn', 0, '每日打卡', $2)`,
        [userId, sourceId],
      );
    }

    const account = (await getEnergyAccount(userId))!;
    return { isNewDay: true, streakBonus: bonus, account };
  });
}

export async function claimReward(
  userId: string,
  claimType: string,
  sourceId: string,
  amount: number,
  description: string,
): Promise<{ earned: number; account: EnergyAccountDto }> {
  const fullSourceId = `claim:${claimType}:${sourceId}`;
  const result = await earnEnergy(userId, amount, description, fullSourceId);
  return { earned: result.earned, account: result.account };
}
