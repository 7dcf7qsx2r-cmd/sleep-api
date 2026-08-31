/**
 * 账号注销：软删用户、清空登录标识与云端 blob，原手机号可重新注册。
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = mkdtempSync(join(tmpdir(), 'sleep-api-account-delete-'));
process.env.USE_PGLITE = '1';
process.env.PGLITE_DATA_DIR = dataDir;

let closeDb: typeof import('../src/db/client.js').closeDb;
let query: typeof import('../src/db/client.js').query;
let deleteUserAccount: typeof import('../src/services/auth.js').deleteUserAccount;
let getUserAccountProfile: typeof import('../src/services/auth.js').getUserAccountProfile;

const USER_ID = '00000000-0000-4000-8000-0000000000d1';
const PHONE = '+8613800138099';

before(async () => {
  ({ closeDb, query } = await import('../src/db/client.js'));
  ({ deleteUserAccount, getUserAccountProfile } = await import('../src/services/auth.js'));

  for (const sql of [
    `CREATE TABLE users (
      id UUID PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL DEFAULT 'x',
      phone TEXT,
      wechat_openid TEXT,
      wechat_unionid TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      deleted_at TIMESTAMPTZ,
      merged_into_user_id UUID
    )`,
    `CREATE UNIQUE INDEX idx_users_phone ON users (phone) WHERE phone IS NOT NULL AND deleted_at IS NULL`,
    `CREATE UNIQUE INDEX idx_users_wechat_openid ON users (wechat_openid) WHERE wechat_openid IS NOT NULL AND deleted_at IS NULL`,
    `CREATE TABLE user_profiles (
      user_id UUID PRIMARY KEY REFERENCES users(id),
      nickname TEXT,
      avatar_url TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE TABLE data_blobs (
      owner_type TEXT NOT NULL,
      owner_id UUID NOT NULL,
      domain TEXT NOT NULL,
      data JSONB NOT NULL DEFAULT '{}',
      version INT NOT NULL DEFAULT 1,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (owner_type, owner_id, domain)
    )`,
    `CREATE TABLE energy_accounts (
      user_id UUID PRIMARY KEY REFERENCES users(id),
      balance INT NOT NULL DEFAULT 0,
      total_earned INT NOT NULL DEFAULT 0,
      total_spent INT NOT NULL DEFAULT 0,
      streak_days INT NOT NULL DEFAULT 0,
      max_streak_days INT NOT NULL DEFAULT 0,
      daily_earned INT NOT NULL DEFAULT 0,
      daily_cap INT NOT NULL DEFAULT 200,
      daily_earned_date DATE NOT NULL DEFAULT CURRENT_DATE,
      last_check_in DATE,
      version INT NOT NULL DEFAULT 1,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
  ]) {
    await query(sql);
  }

  await query(
    `INSERT INTO users (id, username, password_hash, phone, wechat_openid, wechat_unionid, status)
     VALUES ($1, 'keep_me', 'hash', $2, 'openid-del', 'union-del', 'active')`,
    [USER_ID, PHONE],
  );
  await query(
    `INSERT INTO user_profiles (user_id, nickname, avatar_url) VALUES ($1, '待注销', 'https://example.com/a.png')`,
    [USER_ID],
  );
  await query(
    `INSERT INTO data_blobs (owner_type, owner_id, domain, data)
     VALUES ('user', $1, 'profile', '{"nickname":"待注销"}')`,
    [USER_ID],
  );
});

after(async () => {
  await closeDb();
  rmSync(dataDir, { recursive: true, force: true });
});

test('注销后不可再取到账号资料，手机号可重新注册', async () => {
  const ok = await deleteUserAccount(USER_ID);
  assert.equal(ok, true);

  const profile = await getUserAccountProfile(USER_ID);
  assert.equal(profile, null);

  const user = await query<{
    deleted_at: Date | string | null;
    phone: string | null;
    wechat_openid: string | null;
    wechat_unionid: string | null;
    username: string;
  }>(
    `SELECT deleted_at, phone, wechat_openid, wechat_unionid, username FROM users WHERE id = $1`,
    [USER_ID],
  );
  const row = user.rows[0]!;
  assert.ok(row.deleted_at, 'deleted_at set');
  assert.equal(row.phone, null);
  assert.equal(row.wechat_openid, null);
  assert.equal(row.wechat_unionid, null);
  assert.match(row.username, /^deleted_/);

  const blobs = await query(
    `SELECT 1 FROM data_blobs WHERE owner_type = 'user' AND owner_id = $1`,
    [USER_ID],
  );
  assert.equal(blobs.rows.length, 0);

  const nick = await query<{ nickname: string | null; avatar_url: string | null }>(
    `SELECT nickname, avatar_url FROM user_profiles WHERE user_id = $1`,
    [USER_ID],
  );
  assert.equal(nick.rows[0]?.nickname, '已注销用户');
  assert.equal(nick.rows[0]?.avatar_url, null);

  const reused = await query(
    `INSERT INTO users (id, username, password_hash, phone, status)
     VALUES ('00000000-0000-4000-8000-0000000000d2', 'new_phone_user', 'x', $1, 'active')
     RETURNING id`,
    [PHONE],
  );
  assert.equal(reused.rows[0]?.id, '00000000-0000-4000-8000-0000000000d2');

  const secondDelete = await deleteUserAccount(USER_ID);
  assert.equal(secondDelete, false);
});
