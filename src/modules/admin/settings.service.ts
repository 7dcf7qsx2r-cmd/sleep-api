import bcrypt from 'bcryptjs';
import { query } from '../../db/client.js';

export const ADMIN_PERMISSIONS = [
  { key: '*', label: '超级管理员' },
  { key: 'dashboard:read', label: '查看经营总览' },
  { key: 'users:read', label: '查看用户' },
  { key: 'users:write', label: '管理用户状态' },
  { key: 'products:read', label: '查看商品' },
  { key: 'products:write', label: '编辑商品' },
  { key: 'products:publish', label: '上下架商品' },
  { key: 'orders:read', label: '查看订单' },
  { key: 'orders:refund', label: '处理退款' },
  { key: 'experts:read', label: '查看专家' },
  { key: 'experts:write', label: '编辑专家' },
  { key: 'experts:review', label: '审核专家' },
  { key: 'content:read', label: '查看内容' },
  { key: 'content:write', label: '编辑内容' },
  { key: 'content:publish', label: '发布内容' },
  { key: 'growth:read', label: '查看增长数据' },
  { key: 'growth:write', label: '编辑增长活动' },
  { key: 'growth:settle', label: '佣金结算' },
  { key: 'settings:admin', label: '管理系统设置' },
  { key: 'audit:read', label: '查看审计日志' },
];

interface AdminRoleRow {
  id: string;
  name: string;
  permissions_json: unknown;
  created_at: Date;
}

interface AdminUserRow {
  id: string;
  username: string;
  display_name: string;
  role_id: string;
  role_name: string;
  permissions_json: unknown;
  status: 'active' | 'disabled';
  last_login_at: Date | null;
  created_at: Date;
}

function parsePermissions(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((p): p is string => typeof p === 'string');
}

function mapRole(row: AdminRoleRow) {
  return {
    id: row.id,
    name: row.name,
    permissions: parsePermissions(row.permissions_json),
    createdAt: row.created_at.toISOString(),
  };
}

function mapAdminUser(row: AdminUserRow) {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name || row.username,
    roleId: row.role_id,
    roleName: row.role_name,
    permissions: parsePermissions(row.permissions_json),
    status: row.status,
    lastLoginAt: row.last_login_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
  };
}

export async function listAdminRoles() {
  const result = await query<AdminRoleRow>(
    `SELECT id, name, permissions_json, created_at
     FROM admin_roles
     ORDER BY created_at ASC`,
  );
  return result.rows.map(mapRole);
}

export async function getAdminRole(roleId: string) {
  const result = await query<AdminRoleRow>(
    `SELECT id, name, permissions_json, created_at
     FROM admin_roles
     WHERE id = $1`,
    [roleId],
  );
  const row = result.rows[0];
  return row ? mapRole(row) : null;
}

export async function createAdminRole(params: { name: string; permissions: string[] }) {
  const result = await query<AdminRoleRow>(
    `INSERT INTO admin_roles (name, permissions_json)
     VALUES ($1, $2::jsonb)
     RETURNING id, name, permissions_json, created_at`,
    [params.name, JSON.stringify(params.permissions)],
  );
  return mapRole(result.rows[0]!);
}

export async function updateAdminRole(roleId: string, params: { name: string; permissions: string[] }) {
  const before = await getAdminRole(roleId);
  if (!before) return null;
  const result = await query<AdminRoleRow>(
    `UPDATE admin_roles
     SET name = $2, permissions_json = $3::jsonb
     WHERE id = $1
     RETURNING id, name, permissions_json, created_at`,
    [roleId, params.name, JSON.stringify(params.permissions)],
  );
  return { before, after: mapRole(result.rows[0]!) };
}

export async function listAdminUsers() {
  const result = await query<AdminUserRow>(
    `SELECT au.id, au.username, au.display_name, au.role_id, au.status,
            au.last_login_at, au.created_at,
            ar.name AS role_name, ar.permissions_json
     FROM admin_users au
     JOIN admin_roles ar ON ar.id = au.role_id
     ORDER BY au.created_at DESC`,
  );
  return result.rows.map(mapAdminUser);
}

export async function getAdminUser(adminUserId: string) {
  const result = await query<AdminUserRow>(
    `SELECT au.id, au.username, au.display_name, au.role_id, au.status,
            au.last_login_at, au.created_at,
            ar.name AS role_name, ar.permissions_json
     FROM admin_users au
     JOIN admin_roles ar ON ar.id = au.role_id
     WHERE au.id = $1`,
    [adminUserId],
  );
  const row = result.rows[0];
  return row ? mapAdminUser(row) : null;
}

export async function createAdminUser(params: {
  username: string;
  password: string;
  displayName: string;
  roleId: string;
}) {
  const passwordHash = await bcrypt.hash(params.password, 10);
  const result = await query<{ id: string }>(
    `INSERT INTO admin_users (username, password_hash, display_name, role_id)
     VALUES ($1, $2, $3, $4)
     RETURNING id`,
    [params.username, passwordHash, params.displayName, params.roleId],
  );
  return getAdminUser(result.rows[0]!.id);
}

export async function updateAdminUser(adminUserId: string, params: {
  displayName: string;
  roleId: string;
  status: 'active' | 'disabled';
  password?: string;
}) {
  const before = await getAdminUser(adminUserId);
  if (!before) return null;

  if (params.password) {
    const passwordHash = await bcrypt.hash(params.password, 10);
    await query(
      `UPDATE admin_users
       SET display_name = $2, role_id = $3, status = $4, password_hash = $5
       WHERE id = $1`,
      [adminUserId, params.displayName, params.roleId, params.status, passwordHash],
    );
  } else {
    await query(
      `UPDATE admin_users
       SET display_name = $2, role_id = $3, status = $4
       WHERE id = $1`,
      [adminUserId, params.displayName, params.roleId, params.status],
    );
  }

  const after = await getAdminUser(adminUserId);
  return after ? { before, after } : null;
}
