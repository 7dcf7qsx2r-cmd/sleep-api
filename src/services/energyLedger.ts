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

export type FeedTipErrorCode =
  | 'invalid_amount'
  | 'invalid_idempotency_key'
  | 'post_not_found'
  | 'cannot_tip_self'
  | 'insufficient_energy'
  | 'idempotency_conflict';

export class FeedTipError extends Error {
  constructor(public readonly code: FeedTipErrorCode) {
    super(code);
  }
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
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function resetDailyEarnedIfNeeded(
  client: import('pg').PoolClient,
  userId: string,
  today = todayStr(),
): Promise<void> {
  await client.query(
    `UPDATE energy_accounts
     SET daily_earned = 0,
         daily_earned_date = $2::date,
         version = version + 1,
         updated_at = NOW()
     WHERE user_id = $1
       AND daily_earned_date <> $2::date`,
    [userId, today],
  );
}

async function getEnergyAccountWithClient(
  client: import('pg').PoolClient,
  userId: string,
): Promise<EnergyAccountDto> {
  const row = await client.query<{
    balance: number;
    total_earned: number;
    total_spent: number;
    streak_days: number;
    max_streak_days: number;
    daily_earned: number;
    daily_cap: number;
    last_check_in: string | null;
    version: number;
    updated_at: Date;
  }>(
    `SELECT balance, total_earned, total_spent, streak_days, max_streak_days,
            daily_earned, daily_cap, last_check_in, version, updated_at
     FROM energy_accounts WHERE user_id = $1`,
    [userId],
  );
  const r = row.rows[0]!;
  return {
    balance: r.balance,
    totalEarned: r.total_earned,
    totalSpent: r.total_spent,
    streakDays: r.streak_days,
    maxStreakDays: r.max_streak_days,
    dailyEarned: r.daily_earned,
    dailyCap: r.daily_cap,
    lastCheckIn: r.last_check_in,
    version: r.version,
    updatedAt: r.updated_at.toISOString(),
  };
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
      `SELECT id FROM energy_transactions WHERE user_id = $1 AND source_id = $2`,
      [userId, sourceId],
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

    const account = await getEnergyAccountWithClient(client, userId);
    return { success: true, account };
  });
}

/**
 * Atomically records a feed tip and transfers energy between both accounts.
 * The sender-scoped idempotency key covers the complete operation, including
 * both ledger entries and account updates.
 */
export async function tipFeedPost(input: {
  senderId: string;
  postId: string;
  amount: number;
  idempotencyKey: string;
}): Promise<{
  tip: {
    id: string;
    post_id: string;
    sender_id: string;
    recipient_id: string;
    amount: number;
    idempotency_key: string;
    created_at: Date;
  };
  balance: number;
  duplicate: boolean;
}> {
  if (!Number.isSafeInteger(input.amount) || input.amount <= 0) {
    throw new FeedTipError('invalid_amount');
  }
  if (!input.idempotencyKey.trim() || input.idempotencyKey.length > 128) {
    throw new FeedTipError('invalid_idempotency_key');
  }
  await ensureEnergyAccount(input.senderId);

  const post = await query<{ user_id: string }>(
    `SELECT user_id FROM feed_posts WHERE id = $1`,
    [input.postId],
  );
  const recipientId = post.rows[0]?.user_id;
  if (!recipientId) throw new FeedTipError('post_not_found');
  if (recipientId === input.senderId) throw new FeedTipError('cannot_tip_self');
  await ensureEnergyAccount(recipientId);

  return withClient(async (client) => {
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtext($1))`,
      [`feed_tip:${input.senderId}:${input.idempotencyKey}`],
    );

    const existing = await client.query<{
      id: string;
      post_id: string;
      sender_id: string;
      recipient_id: string;
      amount: number;
      idempotency_key: string;
      created_at: Date;
    }>(
      `SELECT id, post_id, sender_id, recipient_id, amount, idempotency_key, created_at
       FROM feed_tips
       WHERE sender_id = $1 AND idempotency_key = $2`,
      [input.senderId, input.idempotencyKey],
    );
    if (existing.rows[0]) {
      const tip = existing.rows[0];
      if (tip.post_id !== input.postId || tip.amount !== input.amount) {
        throw new FeedTipError('idempotency_conflict');
      }
      const account = await client.query<{ balance: number }>(
        `SELECT balance FROM energy_accounts WHERE user_id = $1`,
        [input.senderId],
      );
      return { tip, balance: account.rows[0]!.balance, duplicate: true };
    }

    const lockedPost = await client.query<{ user_id: string }>(
      `SELECT user_id FROM feed_posts WHERE id = $1 FOR SHARE`,
      [input.postId],
    );
    if (!lockedPost.rows[0]) throw new FeedTipError('post_not_found');
    if (lockedPost.rows[0].user_id !== recipientId) throw new FeedTipError('post_not_found');

    const accounts = await client.query<{ user_id: string; balance: number }>(
      `SELECT user_id, balance
       FROM energy_accounts
       WHERE user_id IN ($1, $2)
       ORDER BY user_id
       FOR UPDATE`,
      [input.senderId, recipientId],
    );
    const senderBalance = accounts.rows.find((row) => row.user_id === input.senderId)?.balance ?? 0;
    if (senderBalance < input.amount) throw new FeedTipError('insufficient_energy');

    const inserted = await client.query<{
      id: string;
      post_id: string;
      sender_id: string;
      recipient_id: string;
      amount: number;
      idempotency_key: string;
      created_at: Date;
    }>(
      `INSERT INTO feed_tips (post_id, sender_id, recipient_id, amount, idempotency_key)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, post_id, sender_id, recipient_id, amount, idempotency_key, created_at`,
      [input.postId, input.senderId, recipientId, input.amount, input.idempotencyKey],
    );
    const tip = inserted.rows[0]!;
    const sourceId = `feed_tip:${tip.id}`;

    await client.query(
      `INSERT INTO energy_transactions
         (user_id, type, amount, description, source_id, related_user_id)
       VALUES
         ($1, 'transfer_out', $3, '星河动态打赏', $4, $2),
         ($2, 'transfer_in', $3, '星河动态获赏', $4, $1)`,
      [input.senderId, recipientId, input.amount, sourceId],
    );
    const updated = await client.query<{ balance: number }>(
      `UPDATE energy_accounts
       SET balance = balance - $2,
           total_spent = total_spent + $2,
           version = version + 1,
           updated_at = NOW()
       WHERE user_id = $1
       RETURNING balance`,
      [input.senderId, input.amount],
    );
    await client.query(
      `UPDATE energy_accounts
       SET balance = balance + $2,
           total_earned = total_earned + $2,
           version = version + 1,
           updated_at = NOW()
       WHERE user_id = $1`,
      [recipientId, input.amount],
    );

    return { tip, balance: updated.rows[0]!.balance, duplicate: false };
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
      `SELECT id FROM energy_transactions WHERE user_id = $1 AND source_id = $2`,
      [userId, sourceId],
    );
    if (dup.rows[0]) {
      const account = await ensureEnergyAccount(userId);
      return { earned: 0, account, duplicate: true };
    }

    await resetDailyEarnedIfNeeded(client, userId);

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

    const account = await getEnergyAccountWithClient(client, userId);
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

  const nextCount = await withClient(async (client) => {
    await client.query(
      `INSERT INTO energy_task_daily (user_id, task_id, usage_date, completed_count)
       VALUES ($1, $2, $3::date, 0)
       ON CONFLICT (user_id, task_id, usage_date) DO NOTHING`,
      [userId, taskId, today],
    );

    const row = await client.query<{ completed_count: number }>(
      `UPDATE energy_task_daily
       SET completed_count = completed_count + 1
       WHERE user_id = $1
         AND task_id = $2
         AND usage_date = $3::date
         AND completed_count < $4
       RETURNING completed_count`,
      [userId, taskId, today, def.dailyLimit],
    );
    return row.rows[0]?.completed_count ?? null;
  });

  if (nextCount == null) {
    const account = await ensureEnergyAccount(userId);
    return { success: false, earned: 0, account };
  }

  const earn = await earnEnergy(
    userId,
    def.reward,
    `完成任务：${def.name}`,
    `task:${taskId}:${today}:${nextCount}`,
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
      `SELECT id FROM energy_transactions WHERE user_id = $1 AND source_id = $2`,
      [userId, sourceId],
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
           daily_earned = 0, daily_earned_date = $4::date,
           version = version + 1, updated_at = NOW()
       WHERE user_id = $1`,
      [userId, streakDays, maxStreak, today],
    );

    if (bonus > 0) {
      const accRow = await client.query<{
        daily_earned: number;
        daily_cap: number;
      }>(
        `SELECT daily_earned, daily_cap FROM energy_accounts WHERE user_id = $1 FOR UPDATE`,
        [userId],
      );
      const dailyEarned = accRow.rows[0]?.daily_earned ?? 0;
      const dailyCap = accRow.rows[0]?.daily_cap ?? 200;
      const earned = Math.max(0, Math.min(bonus, dailyCap - dailyEarned));
      if (earned > 0) {
        await client.query(
          `INSERT INTO energy_transactions (user_id, type, amount, description, source_id)
           VALUES ($1, 'earn', $2, $3, $4)`,
          [userId, earned, `连续打卡${streakDays}天奖励`, sourceId],
        );
        await client.query(
          `UPDATE energy_accounts
           SET balance = balance + $2, total_earned = total_earned + $2,
               daily_earned = daily_earned + $2,
               version = version + 1, updated_at = NOW()
           WHERE user_id = $1`,
          [userId, earned],
        );
      }
    } else {
      await client.query(
        `INSERT INTO energy_transactions (user_id, type, amount, description, source_id)
         VALUES ($1, 'earn', 0, '每日打卡', $2)`,
        [userId, sourceId],
      );
    }

    const account = await getEnergyAccountWithClient(client, userId);
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
