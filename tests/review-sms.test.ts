/**
 * 应用商店审核号：固定手机号+验证码，不走腾讯云短信、不影响其他号码。
 * 运行：npx tsx --test tests/review-sms.test.ts
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = mkdtempSync(join(tmpdir(), 'sleep-api-review-sms-'));
process.env.USE_PGLITE = '1';
process.env.PGLITE_DATA_DIR = dataDir;
process.env.JWT_SECRET = 'review-sms-tests-only-secret-32chars';
process.env.SMS_MOCK = '';
process.env.TENCENT_SMS_SECRET_ID = '';
process.env.REVIEW_SMS_PHONES = '13800138000';
process.env.REVIEW_SMS_CODE = '888888';

const [
  { authRoutes },
  { closeDb, query },
  { verifyCode },
] = await Promise.all([
  import('../src/routes/auth.js'),
  import('../src/db/client.js'),
  import('../src/services/sms/codeStore.js'),
]);

before(async () => {
  for (const sql of [
    `CREATE TABLE users (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      phone TEXT,
      wechat_openid TEXT,
      wechat_unionid TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      deleted_at TIMESTAMPTZ,
      merged_into_user_id UUID
    )`,
    `CREATE UNIQUE INDEX idx_users_phone ON users (phone) WHERE phone IS NOT NULL AND deleted_at IS NULL`,
    `CREATE TABLE user_profiles (
      user_id UUID PRIMARY KEY REFERENCES users(id),
      nickname TEXT,
      avatar_url TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
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
    `CREATE TABLE sms_verification_codes (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      phone TEXT NOT NULL,
      code_hash TEXT NOT NULL,
      purpose TEXT NOT NULL DEFAULT 'login',
      expires_at TIMESTAMPTZ NOT NULL,
      used_at TIMESTAMPTZ,
      attempt_count INT NOT NULL DEFAULT 0,
      request_ip TEXT,
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

test('审核号无需点发送即可用固定验证码登录', async () => {
  assert.equal(await verifyCode('+8613800138000', '888888'), true);
  assert.equal(await verifyCode('+8613800138000', '000000'), false);
  assert.equal(await verifyCode('+8613900139000', '888888'), false);

  const login = await authRoutes.request('/sms/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone: '13800138000', code: '888888' }),
  });
  assert.equal(login.status, 200);
  const body = await login.json() as { token?: string; subjectType?: string };
  assert.ok(body.token);
  assert.equal(body.subjectType, 'user');
});

test('审核号可点获取验证码且不要求腾讯云短信', async () => {
  const send = await authRoutes.request('/sms/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone: '13800138000' }),
  });
  assert.equal(send.status, 200);
  const sent = await send.json() as { ok?: boolean };
  assert.equal(sent.ok, true);

  const other = await authRoutes.request('/sms/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone: '13900139000' }),
  });
  assert.equal(other.status, 503);
});
