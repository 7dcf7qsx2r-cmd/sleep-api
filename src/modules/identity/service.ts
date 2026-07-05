import type {
  UserDetail,
  UserListItem,
  UserListResult,
  UserStatus,
  RegisterVia,
} from './types.js';
import * as repo from './repository.js';

export async function listUsersForAdmin(params: {
  q?: string;
  status?: UserStatus;
  registerVia?: RegisterVia;
  page: number;
  pageSize: number;
}): Promise<UserListResult> {
  const page = Math.max(1, params.page);
  const pageSize = Math.min(100, Math.max(1, params.pageSize));

  const [total, rows] = await Promise.all([
    repo.countUsers(params),
    repo.listUsers({ ...params, page, pageSize }),
  ]);

  const items: UserListItem[] = rows.map((row) => ({
    id: row.id,
    username: row.username,
    nickname: row.nickname,
    phone: row.phone,
    phoneMasked: repo.maskPhoneSafe(row.phone),
    registerVia: repo.detectRegisterVia(row),
    status: row.status as UserStatus,
    energyBalance: row.balance ?? 0,
    orderCount: Number.parseInt(row.order_count, 10),
    totalSpentRmb: Number.parseFloat(row.total_spent_rmb ?? '0'),
    createdAt: row.created_at.toISOString(),
  }));

  return { items, total, page, pageSize };
}

export async function getUserDetailForAdmin(userId: string): Promise<UserDetail | null> {
  const user = await repo.findUserById(userId);
  if (!user) return null;

  const [energy, transactions, orders, orderStats] = await Promise.all([
    repo.findEnergyAccount(userId),
    repo.listEnergyTransactions(userId, 10),
    repo.listUserOrders(userId, 10),
    repo.countUserOrders(userId),
  ]);

  return {
    id: user.id,
    username: user.username,
    nickname: user.nickname,
    phone: user.phone,
    phoneMasked: repo.maskPhoneSafe(user.phone),
    registerVia: repo.detectRegisterVia(user),
    status: user.status as UserStatus,
    bannedAt: user.banned_at?.toISOString() ?? null,
    bannedReason: user.banned_reason,
    wechatBound: Boolean(user.wechat_openid),
    createdAt: user.created_at.toISOString(),
    energy: energy
      ? {
          balance: energy.balance,
          totalEarned: energy.total_earned,
          totalSpent: energy.total_spent,
          streakDays: energy.streak_days,
        }
      : null,
    recentEnergyTransactions: transactions.map((t) => ({
      id: t.id,
      type: t.type,
      amount: t.amount,
      description: t.description,
      createdAt: t.created_at.toISOString(),
    })),
    orderCount: orderStats.count,
    totalSpentRmb: orderStats.totalSpentRmb,
    recentOrders: orders.map((o) => ({
      id: o.id,
      productId: o.product_id,
      paymentMethod: o.payment_method,
      energySpent: o.energy_spent,
      rmbAmount: o.rmb_amount != null ? Number.parseFloat(o.rmb_amount) : null,
      status: o.status,
      createdAt: o.created_at.toISOString(),
    })),
  };
}

export async function setUserStatusForAdmin(
  userId: string,
  status: UserStatus,
  reason?: string,
) {
  return repo.updateUserStatus(userId, status, reason);
}

export async function getUserStatsSummary() {
  const row = await queryStats();
  return row;
}

async function queryStats() {
  const { query } = await import('../../db/client.js');
  const row = await query<{
    total_users: string;
    active_users: string;
    banned_users: string;
    phone_users: string;
    wechat_users: string;
    today_new: string;
  }>(
    `SELECT
       COUNT(*)::text AS total_users,
       COUNT(*) FILTER (WHERE status = 'active')::text AS active_users,
       COUNT(*) FILTER (WHERE status = 'banned')::text AS banned_users,
       COUNT(*) FILTER (WHERE phone IS NOT NULL)::text AS phone_users,
       COUNT(*) FILTER (WHERE wechat_openid IS NOT NULL)::text AS wechat_users,
       COUNT(*) FILTER (WHERE created_at >= CURRENT_DATE)::text AS today_new
     FROM users
     WHERE deleted_at IS NULL`,
  );
  const s = row.rows[0]!;
  return {
    totalUsers: Number.parseInt(s.total_users, 10),
    activeUsers: Number.parseInt(s.active_users, 10),
    bannedUsers: Number.parseInt(s.banned_users, 10),
    phoneUsers: Number.parseInt(s.phone_users, 10),
    wechatUsers: Number.parseInt(s.wechat_users, 10),
    todayNew: Number.parseInt(s.today_new, 10),
  };
}
