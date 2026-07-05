import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import { query } from '../../db/client.js';
import { config } from '../../config.js';
import { sendVerificationSms, isSmsConfigured } from './tencentSms.js';

export class SmsRateLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SmsRateLimitError';
  }
}

function generateCode(): string {
  if (config.sms.mock && config.sms.mockCode) return config.sms.mockCode;
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
}

export async function issueAndSendCode(phone: string, ip?: string): Promise<{ expiresIn: number }> {
  if (!isSmsConfigured()) {
    throw new Error('SMS service not configured');
  }

  const intervalSec = config.sms.sendIntervalSec;
  const recent = await query<{ created_at: string }>(
    `SELECT created_at FROM sms_verification_codes
     WHERE phone = $1 AND created_at > NOW() - ($2 || ' seconds')::interval
     ORDER BY created_at DESC LIMIT 1`,
    [phone, String(intervalSec)],
  );
  if (recent.rows[0]) {
    throw new SmsRateLimitError(`请 ${intervalSec} 秒后再试`);
  }

  const daily = await query<{ cnt: string }>(
    `SELECT COUNT(*)::text AS cnt FROM sms_verification_codes
     WHERE phone = $1 AND created_at > NOW() - interval '1 day'`,
    [phone],
  );
  if (Number(daily.rows[0]?.cnt ?? 0) >= config.sms.dailyLimitPerPhone) {
    throw new SmsRateLimitError('今日验证码发送次数已达上限');
  }

  if (ip) {
    const ipLimit = await query<{ cnt: string }>(
      `SELECT COUNT(*)::text AS cnt FROM sms_verification_codes
       WHERE request_ip = $1 AND created_at > NOW() - interval '1 hour'`,
      [ip],
    );
    if (Number(ipLimit.rows[0]?.cnt ?? 0) >= config.sms.hourlyLimitPerIp) {
      throw new SmsRateLimitError('请求过于频繁，请稍后再试');
    }
  }

  const code = generateCode();
  const codeHash = await bcrypt.hash(code, 10);
  const expiresAt = new Date(Date.now() + config.sms.codeTtlSec * 1000);

  await query(
    `INSERT INTO sms_verification_codes (phone, code_hash, purpose, expires_at, request_ip)
     VALUES ($1, $2, 'login', $3, $4)`,
    [phone, codeHash, expiresAt.toISOString(), ip ?? null],
  );

  await sendVerificationSms(phone, code);
  return { expiresIn: config.sms.codeTtlSec };
}

export async function verifyCode(phone: string, code: string): Promise<boolean> {
  const row = await query<{
    id: string;
    code_hash: string;
    expires_at: string;
    used_at: string | null;
    attempt_count: number;
  }>(
    `SELECT id, code_hash, expires_at, used_at, attempt_count
     FROM sms_verification_codes
     WHERE phone = $1 AND purpose = 'login' AND used_at IS NULL
     ORDER BY created_at DESC LIMIT 1`,
    [phone],
  );

  const rec = row.rows[0];
  if (!rec) return false;
  if (rec.used_at) return false;
  if (new Date(rec.expires_at).getTime() < Date.now()) return false;
  if (rec.attempt_count >= config.sms.maxAttempts) return false;

  const ok = await bcrypt.compare(code, rec.code_hash);
  await query(
    `UPDATE sms_verification_codes
     SET attempt_count = attempt_count + 1,
         used_at = CASE WHEN $2 THEN NOW() ELSE used_at END
     WHERE id = $1`,
    [rec.id, ok],
  );
  return ok;
}
