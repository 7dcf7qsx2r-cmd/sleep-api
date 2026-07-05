import { query } from '../../db/client.js';
import { maskPhone } from '../../lib/phone.js';
import type { RegisterVia, UserStatus } from './types.js';

interface UserListRow {
  id: string;
  username: string;
  phone: string | null;
  wechat_openid: string | null;
  status: string;
  created_at: Date;
  nickname: string | null;
  balance: number | null;
  order_count: string;
  total_spent_rmb: string | null;
}

export function detectRegisterVia(row: {
  phone: string | null;
  wechat_openid: string | null;
}): RegisterVia {
  if (row.phone) return 'phone';
  if (row.wechat_openid) return 'wechat';
  return 'password';
}

export function maskPhoneSafe(phone: string | null): string | null {
  if (!phone) return null;
  return maskPhone(phone.startsWith('+') ? phone : `+86${phone.replace(/\D/g, '')}`);
}

export async function countUsers(filters: {
  q?: string;
  status?: UserStatus;
  registerVia?: RegisterVia;
}): Promise<number> {
  const { clause, params } = buildUserFilterClause(filters, 1);
  const row = await query<{ count: string }>(
    `SELECT COUNT(*)::text AS count
     FROM users u
     LEFT JOIN user_profiles p ON p.user_id = u.id
     WHERE u.deleted_at IS NULL ${clause}`,
    params,
  );
  return Number.parseInt(row.rows[0]?.count ?? '0', 10);
}

export async function listUsers(filters: {
  q?: string;
  status?: UserStatus;
  registerVia?: RegisterVia;
  page: number;
  pageSize: number;
}): Promise<UserListRow[]> {
  const offset = (filters.page - 1) * filters.pageSize;
  const { clause, params } = buildUserFilterClause(filters, 1);
  const limitIdx = params.length + 1;
  const offsetIdx = params.length + 2;

  const row = await query<UserListRow>(
    `SELECT
       u.id,
       u.username,
       u.phone,
       u.wechat_openid,
       u.status,
       u.created_at,
       p.nickname,
       ea.balance,
       (SELECT COUNT(*)::text FROM shop_orders o WHERE o.user_id = u.id) AS order_count,
       (SELECT COALESCE(SUM(o.rmb_amount), 0)::text FROM shop_orders o WHERE o.user_id = u.id) AS total_spent_rmb
     FROM users u
     LEFT JOIN user_profiles p ON p.user_id = u.id
     LEFT JOIN energy_accounts ea ON ea.user_id = u.id
     WHERE u.deleted_at IS NULL ${clause}
     ORDER BY u.created_at DESC
     LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
    [...params, filters.pageSize, offset],
  );
  return row.rows;
}

function buildUserFilterClause(
  filters: { q?: string; status?: UserStatus; registerVia?: RegisterVia },
  startIdx: number,
): { clause: string; params: unknown[] } {
  const params: unknown[] = [];
  let clause = '';
  let idx = startIdx;

  if (filters.status) {
    clause += ` AND u.status = $${idx++}`;
    params.push(filters.status);
  }

  if (filters.registerVia === 'phone') {
    clause += ` AND u.phone IS NOT NULL`;
  } else if (filters.registerVia === 'wechat') {
    clause += ` AND u.wechat_openid IS NOT NULL AND u.phone IS NULL`;
  } else if (filters.registerVia === 'password') {
    clause += ` AND u.phone IS NULL AND u.wechat_openid IS NULL`;
  }

  if (filters.q?.trim()) {
    const q = `%${filters.q.trim()}%`;
    clause += ` AND (
      u.username ILIKE $${idx}
      OR u.phone ILIKE $${idx}
      OR p.nickname ILIKE $${idx}
      OR u.id::text ILIKE $${idx}
    )`;
    params.push(q);
    idx += 1;
  }

  return { clause, params };
}

export async function findUserById(userId: string) {
  const row = await query<{
    id: string;
    username: string;
    phone: string | null;
    wechat_openid: string | null;
    wechat_unionid: string | null;
    status: string;
    banned_at: Date | null;
    banned_reason: string | null;
    created_at: Date;
    nickname: string | null;
  }>(
    `SELECT u.id, u.username, u.phone, u.wechat_openid, u.wechat_unionid,
            u.status, u.banned_at, u.banned_reason, u.created_at,
            p.nickname
     FROM users u
     LEFT JOIN user_profiles p ON p.user_id = u.id
     WHERE u.id = $1 AND u.deleted_at IS NULL`,
    [userId],
  );
  return row.rows[0] ?? null;
}

export async function findEnergyAccount(userId: string) {
  const row = await query<{
    balance: number;
    total_earned: number;
    total_spent: number;
    streak_days: number;
  }>(
    `SELECT balance, total_earned, total_spent, streak_days
     FROM energy_accounts WHERE user_id = $1`,
    [userId],
  );
  return row.rows[0] ?? null;
}

export async function listEnergyTransactions(userId: string, limit = 10) {
  const row = await query<{
    id: string;
    type: string;
    amount: number;
    description: string;
    created_at: Date;
  }>(
    `SELECT id, type, amount, description, created_at
     FROM energy_transactions
     WHERE user_id = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [userId, limit],
  );
  return row.rows;
}

export async function listUserOrders(userId: string, limit = 10) {
  const row = await query<{
    id: string;
    product_id: string;
    payment_method: string;
    energy_spent: number | null;
    rmb_amount: string | null;
    status: string;
    created_at: Date;
  }>(
    `SELECT id, product_id, payment_method, energy_spent, rmb_amount, status, created_at
     FROM shop_orders
     WHERE user_id = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [userId, limit],
  );
  return row.rows;
}

export async function countUserOrders(userId: string) {
  const row = await query<{ count: string; total: string | null }>(
    `SELECT COUNT(*)::text AS count, COALESCE(SUM(rmb_amount), 0)::text AS total
     FROM shop_orders WHERE user_id = $1`,
    [userId],
  );
  return {
    count: Number.parseInt(row.rows[0]?.count ?? '0', 10),
    totalSpentRmb: Number.parseFloat(row.rows[0]?.total ?? '0'),
  };
}

export async function updateUserStatus(
  userId: string,
  status: UserStatus,
  reason?: string,
): Promise<{ before: UserStatus; after: UserStatus } | null> {
  const existing = await findUserById(userId);
  if (!existing) return null;

  const before = existing.status as UserStatus;
  if (status === 'banned') {
    await query(
      `UPDATE users SET status = $2, banned_at = NOW(), banned_reason = $3 WHERE id = $1`,
      [userId, status, reason ?? null],
    );
  } else {
    await query(
      `UPDATE users SET status = $2, banned_at = NULL, banned_reason = NULL WHERE id = $1`,
      [userId, status],
    );
  }
  return { before, after: status };
}
