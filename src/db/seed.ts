import bcrypt from 'bcryptjs';
import { closeDb, query } from './client.js';
import { ensureEnergyAccount } from '../services/energy.js';

const PREFAB_USERS = [
  { username: 'demo', password: 'demo123', nickname: '演示用户' },
  { username: 'xiaomian', password: 'xiaomian2026', nickname: '小眠测试' },
];

const ADMIN_ROLE = {
  name: 'super_admin',
  permissions: ['*'],
};

const DEFAULT_ADMIN = {
  username: process.env.ADMIN_DEFAULT_USERNAME ?? 'admin',
  password: process.env.ADMIN_DEFAULT_PASSWORD ?? 'admin123',
  displayName: '超级管理员',
};

async function ensureAdminRole(): Promise<string> {
  const existing = await query<{ id: string }>(
    'SELECT id FROM admin_roles WHERE name = $1',
    [ADMIN_ROLE.name],
  );
  if (existing.rows[0]) return existing.rows[0].id;

  const inserted = await query<{ id: string }>(
    `INSERT INTO admin_roles (name, permissions_json)
     VALUES ($1, $2::jsonb)
     RETURNING id`,
    [ADMIN_ROLE.name, JSON.stringify(ADMIN_ROLE.permissions)],
  );
  return inserted.rows[0]!.id;
}

async function seedAdminUser(roleId: string) {
  const existing = await query<{ id: string }>(
    'SELECT id FROM admin_users WHERE username = $1',
    [DEFAULT_ADMIN.username],
  );
  if (existing.rows[0]) {
    console.log(`Skip existing admin: ${DEFAULT_ADMIN.username}`);
    return;
  }
  const hash = await bcrypt.hash(DEFAULT_ADMIN.password, 10);
  await query(
    `INSERT INTO admin_users (username, password_hash, display_name, role_id)
     VALUES ($1, $2, $3, $4)`,
    [DEFAULT_ADMIN.username, hash, DEFAULT_ADMIN.displayName, roleId],
  );
  console.log(`Created admin: ${DEFAULT_ADMIN.username} / ${DEFAULT_ADMIN.password}`);
}

async function main() {
  for (const u of PREFAB_USERS) {
    const hash = await bcrypt.hash(u.password, 10);
    const existing = await query<{ id: string }>(
      'SELECT id FROM users WHERE username = $1',
      [u.username],
    );
    if (existing.rows[0]) {
      console.log(`Skip existing user: ${u.username}`);
      continue;
    }
    const inserted = await query<{ id: string }>(
      `INSERT INTO users (username, password_hash)
       VALUES ($1, $2)
       RETURNING id`,
      [u.username, hash],
    );
    const userId = inserted.rows[0]!.id;
    await query(
      `INSERT INTO user_profiles (user_id, nickname)
       VALUES ($1, $2)
       ON CONFLICT (user_id) DO NOTHING`,
      [userId, u.nickname],
    );
    await ensureEnergyAccount(userId);
    console.log(`Created user: ${u.username} / ${u.password}`);
  }

  const roleId = await ensureAdminRole();
  await seedAdminUser(roleId);

  await closeDb();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
