import crypto from 'node:crypto';
import { config } from '../config.js';
import { query } from '../db/client.js';

export function privacyHash(value: string): string {
  return crypto
    .createHmac('sha256', config.jwtSecret)
    .update(value.trim().toLowerCase())
    .digest('hex');
}

export async function consumeFixedWindow(params: {
  action: string;
  key: string;
  limit: number;
  windowMs: number;
}): Promise<{ allowed: boolean; retryAfterSec: number }> {
  if (params.limit <= 0) return { allowed: true, retryAfterSec: 0 };

  const now = Date.now();
  const windowStartMs = Math.floor(now / params.windowMs) * params.windowMs;
  const windowStart = new Date(windowStartMs);
  const expiresAt = new Date(windowStartMs + params.windowMs);
  const keyHash = privacyHash(params.key);

  const result = await query<{ request_count: number }>(
    `INSERT INTO rate_limit_buckets
      (key_hash, action, window_start, request_count, expires_at)
     VALUES ($1, $2, $3, 1, $4)
     ON CONFLICT (key_hash, action, window_start) DO UPDATE
     SET request_count = rate_limit_buckets.request_count + 1
     WHERE rate_limit_buckets.request_count < $5
     RETURNING request_count`,
    [keyHash, params.action, windowStart.toISOString(), expiresAt.toISOString(), params.limit],
  );

  return {
    allowed: result.rows.length === 1,
    retryAfterSec: Math.max(1, Math.ceil((expiresAt.getTime() - now) / 1_000)),
  };
}

export async function pruneExpiredRateLimits(): Promise<void> {
  await query(`DELETE FROM rate_limit_buckets WHERE expires_at < NOW()`);
}
