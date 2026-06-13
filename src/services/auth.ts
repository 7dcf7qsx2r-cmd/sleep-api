import bcrypt from 'bcryptjs';
import { query } from '../db/client.js';
import { signToken } from '../lib/jwt.js';

export async function createGuestSession(deviceId?: string) {
  const row = await query<{ id: string }>(
    `INSERT INTO guest_sessions (device_id) VALUES ($1) RETURNING id`,
    [deviceId ?? null],
  );
  const guestId = row.rows[0]!.id;
  const token = await signToken({ sub: guestId, type: 'guest' });
  return { guestId, token };
}

export async function loginWithPassword(username: string, password: string) {
  const row = await query<{ id: string; password_hash: string; username: string }>(
    `SELECT id, password_hash, username FROM users
     WHERE username = $1 AND deleted_at IS NULL`,
    [username],
  );
  const user = row.rows[0];
  if (!user) return null;

  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return null;

  const token = await signToken({ sub: user.id, type: 'user' });
  return { userId: user.id, username: user.username, token };
}
