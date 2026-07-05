import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import { query } from '../db/client.js';
import { signToken } from '../lib/jwt.js';
import { maskPhone } from '../lib/phone.js';
import { ensureEnergyAccount } from './energy.js';

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
     WHERE username = $1 AND deleted_at IS NULL AND password_hash IS NOT NULL`,
    [username],
  );
  const user = row.rows[0];
  if (!user) return null;

  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return null;

  const token = await signToken({ sub: user.id, type: 'user' });
  return { userId: user.id, username: user.username, token };
}

export async function loginOrRegisterByPhone(phone: string) {
  const existing = await query<{ id: string; username: string | null; phone: string }>(
    `SELECT id, username, phone FROM users WHERE phone = $1 AND deleted_at IS NULL`,
    [phone],
  );

  if (existing.rows[0]) {
    const user = existing.rows[0];
    const token = await signToken({ sub: user.id, type: 'user' });
    return {
      userId: user.id,
      username: user.username ?? maskPhone(phone),
      phone: user.phone,
      isNewUser: false,
      token,
    };
  }

  const suffix = phone.replace(/\D/g, '').slice(-4);
  const username = `u${suffix}${crypto.randomInt(100, 999)}`;
  const passwordHash = await bcrypt.hash(crypto.randomUUID(), 10);
  const nickname = `小眠用户${suffix}`;

  const inserted = await query<{ id: string }>(
    `INSERT INTO users (username, password_hash, phone)
     VALUES ($1, $2, $3)
     RETURNING id`,
    [username, passwordHash, phone],
  );
  const userId = inserted.rows[0]!.id;

  await query(
    `INSERT INTO user_profiles (user_id, nickname)
     VALUES ($1, $2)
     ON CONFLICT (user_id) DO NOTHING`,
    [userId, nickname],
  );
  await ensureEnergyAccount(userId);

  const token = await signToken({ sub: userId, type: 'user' });
  return {
    userId,
    username,
    phone,
    isNewUser: true,
    token,
  };
}

export async function loginOrRegisterByWeChat(params: {
  openid: string;
  unionid?: string;
  nickname?: string;
  avatarUrl?: string;
}) {
  const { openid, unionid, nickname, avatarUrl } = params;

  const existing = await query<{ id: string; username: string | null }>(
    `SELECT id, username FROM users
     WHERE deleted_at IS NULL
       AND (
         ($1::text IS NOT NULL AND wechat_unionid = $1)
         OR wechat_openid = $2
       )
     LIMIT 1`,
    [unionid ?? null, openid],
  );

  if (existing.rows[0]) {
    const user = existing.rows[0];
    await upsertWeChatProfile(user.id, nickname, avatarUrl);
    const profile = await getUserAccountProfile(user.id);
    const token = await signToken({ sub: user.id, type: 'user' });
    return {
      userId: user.id,
      username: user.username ?? profile?.nickname ?? '微信用户',
      nickname: profile?.nickname ?? nickname ?? null,
      avatarUrl: profile?.avatarUrl ?? avatarUrl ?? null,
      isNewUser: false,
      token,
    };
  }

  const suffix = openid.slice(-6);
  const username = `wx${suffix}${crypto.randomInt(100, 999)}`;
  const passwordHash = await bcrypt.hash(crypto.randomUUID(), 10);
  const displayName = nickname?.trim() || `微信用户${suffix}`;

  const inserted = await query<{ id: string }>(
    `INSERT INTO users (username, password_hash, wechat_openid, wechat_unionid)
     VALUES ($1, $2, $3, $4)
     RETURNING id`,
    [username, passwordHash, openid, unionid ?? null],
  );
  const userId = inserted.rows[0]!.id;

  await upsertWeChatProfile(userId, displayName, avatarUrl);
  await ensureEnergyAccount(userId);

  const token = await signToken({ sub: userId, type: 'user' });
  return {
    userId,
    username,
    nickname: displayName,
    avatarUrl: avatarUrl ?? null,
    isNewUser: true,
    token,
  };
}

export async function getUserAccountProfile(userId: string) {
  const row = await query<{
    id: string;
    username: string;
    phone: string | null;
    nickname: string | null;
    avatar_url: string | null;
  }>(
    `SELECT u.id, u.username, u.phone, p.nickname, p.avatar_url
     FROM users u
     LEFT JOIN user_profiles p ON p.user_id = u.id
     WHERE u.id = $1 AND u.deleted_at IS NULL`,
    [userId],
  );
  const user = row.rows[0];
  if (!user) return null;
  return {
    userId: user.id,
    username: user.username,
    nickname: user.nickname,
    avatarUrl: user.avatar_url,
    phone: user.phone ? maskPhone(user.phone.startsWith('+') ? user.phone : `+86${user.phone.replace(/\D/g, '')}`) : null,
  };
}

async function upsertWeChatProfile(
  userId: string,
  nickname?: string,
  avatarUrl?: string,
): Promise<void> {
  const trimmedNick = nickname?.trim();
  const trimmedAvatar = avatarUrl?.trim();
  if (!trimmedNick && !trimmedAvatar) return;

  await query(
    `INSERT INTO user_profiles (user_id, nickname, avatar_url)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_id) DO UPDATE SET
       nickname = COALESCE(NULLIF(EXCLUDED.nickname, ''), user_profiles.nickname),
       avatar_url = COALESCE(NULLIF(EXCLUDED.avatar_url, ''), user_profiles.avatar_url),
       updated_at = NOW()`,
    [userId, trimmedNick ?? null, trimmedAvatar ?? null],
  );
}
