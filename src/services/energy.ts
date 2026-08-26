import { query, type SqlQuery } from '../db/client.js';
import { SHANGHAI_TODAY_SQL, toDateOnly } from '../utils/civilDate.js';

export interface EnergyAccountDto {
  balance: number;
  totalEarned: number;
  totalSpent: number;
  streakDays: number;
  maxStreakDays: number;
  dailyEarned: number;
  dailyCap: number;
  lastCheckIn: string | null;
  version: number;
  updatedAt: string;
}

const DEFAULT_ACCOUNT = {
  balance: 0,
  totalEarned: 0,
  totalSpent: 0,
  streakDays: 0,
  maxStreakDays: 0,
  dailyEarned: 0,
  dailyCap: 200,
};

export async function ensureEnergyAccount(userId: string): Promise<EnergyAccountDto> {
  const existing = await getEnergyAccount(userId);
  if (existing) return existing;

  const row = await query<{
    balance: number;
    total_earned: number;
    total_spent: number;
    streak_days: number;
    max_streak_days: number;
    daily_earned: number;
    daily_cap: number;
    daily_earned_date: string | null;
    last_check_in: string | null;
    version: number;
    updated_at: Date;
  }>(
    `INSERT INTO energy_accounts (
      user_id, balance, total_earned, total_spent, streak_days, max_streak_days,
      daily_earned, daily_cap, daily_earned_date, version
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, ${SHANGHAI_TODAY_SQL}, 1)
    ON CONFLICT (user_id) DO NOTHING
    RETURNING balance, total_earned, total_spent, streak_days, max_streak_days,
              daily_earned, daily_cap, daily_earned_date::text AS daily_earned_date,
              last_check_in::text AS last_check_in, version, updated_at`,
    [
      userId,
      DEFAULT_ACCOUNT.balance,
      DEFAULT_ACCOUNT.totalEarned,
      DEFAULT_ACCOUNT.totalSpent,
      DEFAULT_ACCOUNT.streakDays,
      DEFAULT_ACCOUNT.maxStreakDays,
      DEFAULT_ACCOUNT.dailyEarned,
      DEFAULT_ACCOUNT.dailyCap,
    ],
  );

  if (row.rows[0]) {
    return mapRow(row.rows[0]);
  }
  return (await getEnergyAccount(userId))!;
}

export async function getEnergyAccount(userId: string): Promise<EnergyAccountDto | null> {
  await query(
    `UPDATE energy_accounts
     SET daily_earned = 0,
         daily_earned_date = ${SHANGHAI_TODAY_SQL},
         version = version + 1,
         updated_at = NOW()
     WHERE user_id = $1
       AND (daily_earned_date IS NULL OR daily_earned_date <> ${SHANGHAI_TODAY_SQL})`,
    [userId],
  );
  const row = await query<{
    balance: number;
    total_earned: number;
    total_spent: number;
    streak_days: number;
    max_streak_days: number;
    daily_earned: number;
    daily_cap: number;
    daily_earned_date: string | null;
    last_check_in: string | null;
    version: number;
    updated_at: Date;
  }>(
    `SELECT balance, total_earned, total_spent, streak_days, max_streak_days,
            daily_earned, daily_cap, daily_earned_date::text AS daily_earned_date,
            last_check_in::text AS last_check_in, version, updated_at
     FROM energy_accounts WHERE user_id = $1`,
    [userId],
  );
  const r = row.rows[0];
  if (!r) return null;
  return mapRow(r);
}

/** 把来源账号能量加进当前账号，不清空来源以外的现有余额 */
export async function absorbEnergyFromUser(
  fromUserId: string,
  toUserId: string,
  q: SqlQuery = query,
): Promise<number> {
  const source = await q<{ balance: number }>(
    `SELECT balance FROM energy_accounts WHERE user_id = $1`,
    [fromUserId],
  );
  const amount = source.rows[0]?.balance ?? 0;
  if (!source.rows[0]) return 0;

  await q(
    `INSERT INTO energy_accounts (
      user_id, balance, total_earned, total_spent, streak_days, max_streak_days,
      daily_earned, daily_cap, daily_earned_date, version
    )
    SELECT $1, 0, 0, 0, 0, 0, 0, daily_cap, daily_earned_date, 1
    FROM energy_accounts WHERE user_id = $2
    ON CONFLICT (user_id) DO NOTHING`,
    [toUserId, fromUserId],
  );

  await q(
    `UPDATE energy_accounts AS t
     SET balance = t.balance + s.balance,
         total_earned = t.total_earned + s.total_earned,
         total_spent = t.total_spent + s.total_spent,
         streak_days = GREATEST(t.streak_days, s.streak_days),
         max_streak_days = GREATEST(t.max_streak_days, s.max_streak_days),
         last_check_in = CASE
           WHEN s.last_check_in IS NULL THEN t.last_check_in
           WHEN t.last_check_in IS NULL THEN s.last_check_in
           WHEN s.last_check_in > t.last_check_in THEN s.last_check_in
           ELSE t.last_check_in
         END,
         version = t.version + 1,
         updated_at = NOW()
     FROM energy_accounts AS s
     WHERE t.user_id = $1 AND s.user_id = $2`,
    [toUserId, fromUserId],
  );

  if (amount > 0) {
    await q(
      `INSERT INTO energy_transactions (user_id, type, amount, description, source_id)
       VALUES ($1, 'grant', $2, '账号合并转入', $3)`,
      [toUserId, amount, `account-merge:${fromUserId}`],
    );
  }

  await q(
    `UPDATE energy_accounts
     SET balance = 0, version = version + 1, updated_at = NOW()
     WHERE user_id = $1`,
    [fromUserId],
  );
  return amount;
}

function mapRow(r: {
  balance: number;
  total_earned: number;
  total_spent: number;
  streak_days: number;
  max_streak_days: number;
  daily_earned: number;
  daily_cap: number;
  daily_earned_date?: string | null;
  last_check_in: string | null;
  version: number;
  updated_at: Date;
}): EnergyAccountDto {
  return {
    balance: r.balance,
    totalEarned: r.total_earned,
    totalSpent: r.total_spent,
    streakDays: r.streak_days,
    maxStreakDays: r.max_streak_days,
    dailyEarned: r.daily_earned,
    dailyCap: r.daily_cap,
    lastCheckIn: toDateOnly(r.last_check_in),
    version: r.version,
    updatedAt: r.updated_at.toISOString(),
  };
}
