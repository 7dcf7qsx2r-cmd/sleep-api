import bcrypt from 'bcryptjs';
import { query } from '../../db/client.js';
import { signAdminToken } from '../../lib/adminJwt.js';

export interface AdminSession {
  token: string;
  admin: {
    id: string;
    username: string;
    displayName: string;
    role: string;
    permissions: string[];
  };
}

interface AdminRow {
  id: string;
  username: string;
  password_hash: string;
  display_name: string;
  status: string;
  role_name: string;
  permissions_json: string[] | unknown;
}

function parsePermissions(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((p): p is string => typeof p === 'string');
}

export async function loginAdmin(username: string, password: string): Promise<AdminSession | null> {
  const row = await query<AdminRow>(
    `SELECT au.id, au.username, au.password_hash, au.display_name, au.status,
            ar.name AS role_name, ar.permissions_json
     FROM admin_users au
     JOIN admin_roles ar ON ar.id = au.role_id
     WHERE au.username = $1`,
    [username],
  );
  const admin = row.rows[0];
  if (!admin || admin.status !== 'active') return null;

  const ok = await bcrypt.compare(password, admin.password_hash);
  if (!ok) return null;

  const permissions = parsePermissions(admin.permissions_json);

  await query(`UPDATE admin_users SET last_login_at = NOW() WHERE id = $1`, [admin.id]);

  const token = await signAdminToken({
    sub: admin.id,
    role: admin.role_name,
    permissions,
  });

  return {
    token,
    admin: {
      id: admin.id,
      username: admin.username,
      displayName: admin.display_name || admin.username,
      role: admin.role_name,
      permissions,
    },
  };
}

export async function getAdminById(adminId: string) {
  const row = await query<AdminRow>(
    `SELECT au.id, au.username, au.password_hash, au.display_name, au.status,
            ar.name AS role_name, ar.permissions_json
     FROM admin_users au
     JOIN admin_roles ar ON ar.id = au.role_id
     WHERE au.id = $1 AND au.status = 'active'`,
    [adminId],
  );
  const admin = row.rows[0];
  if (!admin) return null;
  return {
    id: admin.id,
    username: admin.username,
    displayName: admin.display_name || admin.username,
    role: admin.role_name,
    permissions: parsePermissions(admin.permissions_json),
  };
}
