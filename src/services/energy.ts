import { query } from '../db/client.js';
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
