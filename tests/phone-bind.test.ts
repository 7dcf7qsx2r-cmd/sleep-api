/**
 * 微信账号绑定手机号：空号直接绑；占用则提示合并，禁止静默覆盖。
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = mkdtempSync(join(tmpdir(), 'sleep-api-phone-bind-'));
process.env.USE_PGLITE = '1';
process.env.PGLITE_DATA_DIR = dataDir;

let closeDb: typeof import('../src/db/client.js').closeDb;
let query: typeof import('../src/db/client.js').query;
let bindPhoneToUser: typeof import('../src/services/phoneBind.js').bindPhoneToUser;
let loginOrRegisterByPhone: typeof import('../src/services/auth.js').loginOrRegisterByPhone;
let loginOrRegisterByWeChat: typeof import('../src/services/auth.js').loginOrRegisterByWeChat;
let getUserAccountProfile: typeof import('../src/services/auth.js').getUserAccountProfile;
let getEnergyAccount: typeof import('../src/services/energy.js').getEnergyAccount;

const WECHAT_USER = '00000000-0000-4000-8000-0000000000a1';
const PHONE_USER = '00000000-0000-4000-8000-0000000000b2';
const OTHER_WX = '00000000-0000-4000-8000-0000000000c3';
const PHONE = '+8613800138000';
const OTHER_PHONE = '+8613800138001';

async function insertUser(params: {
  id: string;
  username: string;
  phone?: string | null;
  wechatOpenid?: string | null;
  nickname?: string;
}) {
  await query(
    `INSERT INTO users (id, username, password_hash, phone, wechat_openid, status)
     VALUES ($1, $2, 'x', $3, $4, 'active')`,
    [params.id, params.username, params.phone ?? null, params.wechatOpenid ?? null],
  );
  if (params.nickname) {
    await query(
      `INSERT INTO user_profiles (user_id, nickname) VALUES ($1, $2)`,
      [params.id, params.nickname],
    );
  }
}

before(async () => {
  ({ closeDb, query } = await import('../src/db/client.js'));
  ({ bindPhoneToUser } = await import('../src/services/phoneBind.js'));
  ({ loginOrRegisterByPhone, loginOrRegisterByWeChat, getUserAccountProfile } = await import('../src/services/auth.js'));
  ({ getEnergyAccount } = await import('../src/services/energy.js'));

  for (const sql of [
    `CREATE TABLE users (
      id UUID PRIMARY KEY,
      username TEXT NOT NULL,
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
      avatar_url TEXT
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
    `CREATE TABLE energy_transactions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id),
      type TEXT NOT NULL,
      amount INT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      source_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
  ]) {
    await query(sql);
  }
});

after(async () => {
  await closeDb();
  rmSync(dataDir, { recursive: true, force: true });
});

test('空号直接绑到当前微信账号，短信登录进同一 userId', async () => {
  await insertUser({
    id: WECHAT_USER,
    username: 'wx_bind_free',
    wechatOpenid: 'openid-free',
    nickname: '微信甲',
  });

  const bound = await bindPhoneToUser({ userId: WECHAT_USER, phone: PHONE });
  assert.equal(bound.ok, true);
  if (!bound.ok) return;
  assert.equal(bound.status, 'bound');

  const sms = await loginOrRegisterByPhone(PHONE);
  assert.equal(sms.userId, WECHAT_USER);
  assert.equal(sms.isNewUser, false);

  const wx = await loginOrRegisterByWeChat({ openid: 'openid-free' });
  assert.equal(wx.userId, WECHAT_USER);

  const profile = await getUserAccountProfile(WECHAT_USER);
  assert.equal(profile?.wechatBound, true);
  assert.ok(profile?.phone?.includes('****'));
});

test('号码已被占用时不静默覆盖，需确认才合并', async () => {
  await insertUser({
    id: PHONE_USER,
    username: 'phone_only',
    phone: OTHER_PHONE,
    nickname: '手机乙',
  });
  const wechatId = '00000000-0000-4000-8000-0000000000d4';
  await insertUser({
    id: wechatId,
    username: 'wx_conflict',
    wechatOpenid: 'openid-conflict',
    nickname: '微信丙',
  });

  await query(
    `INSERT INTO data_blobs (owner_type, owner_id, domain, data, version)
     VALUES ('user', $1, 'profile', '{"from":"phone"}'::jsonb, 1)`,
    [PHONE_USER],
  );
  await query(
    `INSERT INTO data_blobs (owner_type, owner_id, domain, data, version)
     VALUES ('user', $1, 'sleep_nights', '{"from":"wechat"}'::jsonb, 1)`,
    [wechatId],
  );
  await query(
    `INSERT INTO energy_accounts (user_id, balance, total_earned)
     VALUES ($1, 80, 80), ($2, 20, 20)`,
    [PHONE_USER, wechatId],
  );

  const preview = await bindPhoneToUser({ userId: wechatId, phone: OTHER_PHONE });
  assert.equal(preview.ok, false);
  if (preview.ok) return;
  assert.equal(preview.error, 'phone_taken');
  assert.equal(preview.needsMerge, true);
  assert.equal(preview.otherAccount.nickname, '手机乙');

  const stillPhone = await query<{ id: string; phone: string | null }>(
    `SELECT id, phone FROM users WHERE id = $1`,
    [PHONE_USER],
  );
  assert.equal(stillPhone.rows[0]?.phone, OTHER_PHONE);
  const stillWx = await query<{ phone: string | null }>(
    `SELECT phone FROM users WHERE id = $1`,
    [wechatId],
  );
  assert.equal(stillWx.rows[0]?.phone, null);

  const merged = await bindPhoneToUser({
    userId: wechatId,
    phone: OTHER_PHONE,
    confirmMerge: true,
  });
  assert.equal(merged.ok, true);
  if (!merged.ok) return;
  assert.equal(merged.status, 'merged');
  assert.equal(merged.mergedFromUserId, PHONE_USER);

  const sms = await loginOrRegisterByPhone(OTHER_PHONE);
  assert.equal(sms.userId, wechatId);

  const retired = await query<{ deleted_at: Date | null; phone: string | null }>(
    `SELECT deleted_at, phone FROM users WHERE id = $1`,
    [PHONE_USER],
  );
  assert.ok(retired.rows[0]?.deleted_at);
  assert.equal(retired.rows[0]?.phone, null);

  const phoneBlob = await query<{ data: { from?: string } }>(
    `SELECT data FROM data_blobs WHERE owner_id = $1 AND domain = 'profile'`,
    [wechatId],
  );
  assert.equal(phoneBlob.rows[0]?.data.from, 'phone');

  const nights = await query<{ data: { from?: string } }>(
    `SELECT data FROM data_blobs WHERE owner_id = $1 AND domain = 'sleep_nights'`,
    [wechatId],
  );
  assert.equal(nights.rows[0]?.data.from, 'wechat');

  const energy = await getEnergyAccount(wechatId);
  assert.equal(energy?.balance, 100);
});

test('占用号已绑其他微信时拒绝合并', async () => {
  const takenPhone = '+8613800138002';
  await insertUser({
    id: OTHER_WX,
    username: 'wx_other',
    phone: takenPhone,
    wechatOpenid: 'openid-other',
    nickname: '微信丁',
  });
  const current = '00000000-0000-4000-8000-0000000000e5';
  await insertUser({
    id: current,
    username: 'wx_current',
    wechatOpenid: 'openid-current',
  });

  const refused = await bindPhoneToUser({
    userId: current,
    phone: takenPhone,
    confirmMerge: true,
  });
  assert.equal(refused.ok, false);
  if (refused.ok) return;
  assert.equal(refused.error, 'phone_bound_to_wechat');

  const sms = await loginOrRegisterByPhone(takenPhone);
  assert.equal(sms.userId, OTHER_WX);
});

test('当前账号已绑其他手机号时拒绝换绑', async () => {
  const userId = '00000000-0000-4000-8000-0000000000f6';
  await insertUser({
    id: userId,
    username: 'already',
    phone: '+8613800138003',
    wechatOpenid: 'openid-already',
  });
  const result = await bindPhoneToUser({ userId, phone: '+8613800138004' });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error, 'already_bound_other');
});
