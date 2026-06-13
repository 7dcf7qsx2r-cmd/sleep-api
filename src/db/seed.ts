import bcrypt from 'bcryptjs';
import { closeDb, query } from './client.js';
import { ensureEnergyAccount } from '../services/energy.js';

const PREFAB_USERS = [
  { username: 'demo', password: 'demo123', nickname: '演示用户' },
  { username: 'xiaomian', password: 'xiaomian2026', nickname: '小眠测试' },
];

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
  await closeDb();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
