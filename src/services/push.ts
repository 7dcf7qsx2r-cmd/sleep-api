import { query } from '../db/client.js';
import { sendViaProvider, type PushProviderName } from './pushProviders.js';

/* ================================================================
   Device Registration
   ================================================================ */

export interface PushDeviceMeta {
  provider?: PushProviderName;
  vendor?: string | null;
  osVersion?: string | null;
  appVersion?: string | null;
}

export async function registerDevice(userId: string, platform: 'android' | 'ios', token: string, meta: PushDeviceMeta = {}) {
  // 同一推送标识换账号登录时，只归属最新登录的账号（CB-PSH-01）
  await query(
    `DELETE FROM push_devices WHERE token = $1 AND platform = $2 AND user_id <> $3`,
    [token, platform, userId],
  );
  const result = await query(
    `INSERT INTO push_devices (user_id, platform, token, provider, vendor, os_version, app_version, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
     ON CONFLICT (user_id, platform, token) DO UPDATE SET
       provider = EXCLUDED.provider, vendor = EXCLUDED.vendor, os_version = EXCLUDED.os_version,
       app_version = EXCLUDED.app_version, updated_at = NOW()
     RETURNING id, platform, provider, vendor, os_version, app_version, updated_at`,
    [userId, platform, token, meta.provider ?? 'fcm', meta.vendor ?? null, meta.osVersion ?? null, meta.appVersion ?? null],
  );
  return result.rows[0];
}

export async function unregisterDevice(userId: string, platform: 'android' | 'ios', token: string) {
  await query(
    `DELETE FROM push_devices WHERE user_id = $1 AND platform = $2 AND token = $3`,
    [userId, platform, token],
  );
}

export async function getUserDevices(userId: string) {
  const result = await query(
    `SELECT platform, token FROM push_devices WHERE user_id = $1`,
    [userId],
  );
  return result.rows as { platform: string; token: string }[];
}

/* ================================================================
   Push Queue
   ================================================================ */

/** 离床与安全类不受夜间时段和每日上限限制（CB-NTF-03、CB-PSH-06）。 */
export type PushCategory = 'leave_bed_silent' | 'leave_bed_sound' | 'safety' | 'settlement' | 'device_check' | 'plan' | 'general';

export const PUSH_CATEGORY_RULES: Record<PushCategory, { ttlSec: number; maxRetries: number; exempt: boolean; silent: boolean; channelId: string }> = {
  leave_bed_silent: { ttlSec: 60, maxRetries: 0, exempt: true, silent: true, channelId: 'cbti-night-silent' },
  leave_bed_sound: { ttlSec: 60, maxRetries: 0, exempt: true, silent: false, channelId: 'cbti-night-sound' },
  safety: { ttlSec: 3600, maxRetries: 2, exempt: true, silent: false, channelId: 'safety' },
  settlement: { ttlSec: 18 * 3600, maxRetries: 2, exempt: false, silent: false, channelId: 'cbti-plan' },
  device_check: { ttlSec: 6 * 3600, maxRetries: 2, exempt: false, silent: false, channelId: 'cbti-plan' },
  plan: { ttlSec: 12 * 3600, maxRetries: 2, exempt: false, silent: false, channelId: 'cbti-plan' },
  general: { ttlSec: 24 * 3600, maxRetries: 2, exempt: false, silent: false, channelId: 'default' },
};

export interface PushPayload {
  userId: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
  category?: PushCategory;
  /** 同一事件服务端推送与本地提示共用，按用户去重（CB-PSH-05） */
  eventId?: string;
  expiresAt?: Date;
}

export async function enqueuePush(payload: PushPayload) {
  const category = payload.category ?? 'general';
  const expiresAt = payload.expiresAt ?? new Date(Date.now() + PUSH_CATEGORY_RULES[category].ttlSec * 1000);
  const data = { ...(payload.data ?? {}), category, ...(payload.eventId ? { eventId: payload.eventId } : {}) };
  const result = await query(
    `INSERT INTO push_queue (user_id, title, body, data_json, category, event_id, expires_at, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending')
     ON CONFLICT (user_id, event_id) WHERE event_id IS NOT NULL DO NOTHING
     RETURNING *`,
    [payload.userId, payload.title, payload.body, JSON.stringify(data), category, payload.eventId ?? null, expiresAt],
  );
  return result.rows[0] ?? null;
}

/* ================================================================
   Dispatcher（PRD 10.2）
   ================================================================ */

export type PushGateDecision = { action: 'send' } | { action: 'defer'; until: Date } | { action: 'drop'; reason: string };

export type PushGate = (input: { userId: string; category: PushCategory; now: Date; sentTodayNonExempt: number }) => Promise<PushGateDecision>;

let pushGate: PushGate = async () => ({ action: 'send' });

/** 计划模式的调度规则由 cbti 模块注册，避免推送服务反向依赖计划。 */
export function setPushGate(gate: PushGate): void {
  pushGate = gate;
}

interface QueueRow {
  id: string;
  user_id: string;
  title: string;
  body: string;
  data_json: Record<string, unknown> | null;
  category: PushCategory;
  event_id: string | null;
  expires_at: Date | string | null;
  attempts: number;
  created_at: Date | string;
}

async function claimDuePushes(now: Date, batchSize: number): Promise<QueueRow[]> {
  const { rows } = await query<QueueRow>(
    `UPDATE push_queue SET status = 'sending', attempts = attempts + 1
     WHERE id IN (
       SELECT id FROM push_queue
       WHERE status = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= $1)
       ORDER BY created_at ASC LIMIT $2
     ) AND status = 'pending'
     RETURNING id, user_id, title, body, data_json, category, event_id, expires_at, attempts, created_at`,
    [now, batchSize],
  );
  return rows;
}

async function finishPush(id: string, status: string, fields: { error?: string | null; provider?: string | null; vendor?: string | null; deliveredMs?: number | null; nextAttemptAt?: Date | null } = {}) {
  const terminal = status !== 'pending';
  await query(
    `UPDATE push_queue SET status = $2, error = $3, provider = COALESCE($4, provider), vendor = COALESCE($5, vendor),
       delivered_ms = COALESCE($6, delivered_ms), next_attempt_at = $7,
       sent_at = CASE WHEN $8 THEN NOW() ELSE sent_at END
     WHERE id = $1`,
    [id, status, fields.error ?? null, fields.provider ?? null, fields.vendor ?? null, fields.deliveredMs ?? null, fields.nextAttemptAt ?? null, terminal],
  );
}

async function sentTodayNonExempt(userId: string): Promise<number> {
  const exempt = Object.entries(PUSH_CATEGORY_RULES).filter(([, r]) => r.exempt).map(([k]) => k);
  const { rows } = await query<{ n: string | number }>(
    `SELECT COUNT(*) AS n FROM push_queue
     WHERE user_id = $1 AND status = 'sent' AND NOT (category = ANY($2))
       AND (sent_at AT TIME ZONE 'Asia/Shanghai')::date = (NOW() AT TIME ZONE 'Asia/Shanghai')::date`,
    [userId, exempt],
  );
  return Number(rows[0]?.n ?? 0);
}

export async function dispatchPushQueue(now = new Date(), batchSize = 50): Promise<{ sent: number; failed: number; expired: number; deferred: number; dropped: number; skipped: number }> {
  const stats = { sent: 0, failed: 0, expired: 0, deferred: 0, dropped: 0, skipped: 0 };
  const rows = await claimDuePushes(now, batchSize);
  for (const row of rows) {
    const category = (row.category in PUSH_CATEGORY_RULES ? row.category : 'general') as PushCategory;
    const rule = PUSH_CATEGORY_RULES[category];
    if (row.expires_at && new Date(row.expires_at).getTime() < now.getTime()) {
      await finishPush(row.id, 'expired');
      stats.expired += 1;
      continue;
    }
    const gate = await pushGate({ userId: row.user_id, category, now, sentTodayNonExempt: rule.exempt ? 0 : await sentTodayNonExempt(row.user_id) });
    if (gate.action === 'defer') {
      await query(`UPDATE push_queue SET status = 'pending', attempts = attempts - 1, next_attempt_at = $2 WHERE id = $1`, [row.id, gate.until]);
      stats.deferred += 1;
      continue;
    }
    if (gate.action === 'drop') {
      await finishPush(row.id, 'dropped', { error: gate.reason });
      stats.dropped += 1;
      continue;
    }

    const { rows: devices } = await query<{ platform: 'android' | 'ios'; token: string; provider: PushProviderName | null; vendor: string | null }>(
      `SELECT platform, token, provider, vendor FROM push_devices WHERE user_id = $1 ORDER BY updated_at DESC`,
      [row.user_id],
    );
    if (devices.length === 0) {
      await finishPush(row.id, 'no_device');
      stats.skipped += 1;
      continue;
    }
    const message = {
      title: row.title,
      body: row.body,
      data: { ...(row.data_json ?? {}), pushId: row.id },
      ttlSec: Math.max(1, Math.round(((row.expires_at ? new Date(row.expires_at).getTime() : now.getTime() + rule.ttlSec * 1000) - now.getTime()) / 1000)),
      silent: rule.silent,
      channelId: rule.channelId,
    };
    let ok: (typeof devices)[number] | null = null;
    const errors: string[] = [];
    let allSkipped = true;
    for (const device of devices) {
      const result = await sendViaProvider({ provider: device.provider ?? 'fcm', token: device.token, platform: device.platform }, message);
      if (result.status === 'sent') { ok = device; allSkipped = false; break; }
      if (result.status === 'failed') { allSkipped = false; errors.push(result.error); } else errors.push(result.reason);
    }
    if (ok) {
      await finishPush(row.id, 'sent', {
        provider: ok.provider ?? 'fcm',
        vendor: ok.vendor,
        deliveredMs: now.getTime() - new Date(row.created_at).getTime(),
      });
      stats.sent += 1;
    } else if (allSkipped) {
      await finishPush(row.id, 'skipped', { error: errors.join('; ').slice(0, 500) });
      stats.skipped += 1;
    } else if (row.attempts <= rule.maxRetries) {
      await finishPush(row.id, 'pending', { error: errors.join('; ').slice(0, 500), nextAttemptAt: new Date(now.getTime() + 60_000 * row.attempts) });
      stats.failed += 1;
    } else {
      await finishPush(row.id, 'failed', { error: errors.join('; ').slice(0, 500) });
      stats.failed += 1;
    }
  }
  return stats;
}

let dispatchRunning = false;

export function startPushDispatchLoop(intervalMs = 5_000): void {
  const tick = () => {
    if (dispatchRunning) return;
    dispatchRunning = true;
    void dispatchPushQueue()
      .catch((err) => console.error('[push-dispatch]', err))
      .finally(() => { dispatchRunning = false; });
  };
  setInterval(tick, intervalMs);
}

/** CB-PSH-08：按通道、厂商、类别统计送达率和延迟（delivered_ms 为入队到通道受理）。 */
export async function pushDeliveryStats(sinceDays = 14) {
  const { rows } = await query<{ provider: string | null; vendor: string | null; category: string; status: string; n: string | number; avg_ms: number | null; p90_ms: number | null }>(
    `SELECT provider, vendor, category, status, COUNT(*) AS n,
            AVG(delivered_ms) AS avg_ms,
            PERCENTILE_CONT(0.9) WITHIN GROUP (ORDER BY delivered_ms) AS p90_ms
     FROM push_queue
     WHERE created_at >= NOW() - ($1::text || ' days')::interval
     GROUP BY provider, vendor, category, status
     ORDER BY category, provider, vendor, status`,
    [String(sinceDays)],
  );
  return rows.map((r) => ({
    provider: r.provider,
    vendor: r.vendor,
    category: r.category,
    status: r.status,
    count: Number(r.n),
    avgMs: r.avg_ms == null ? null : Math.round(Number(r.avg_ms)),
    p90Ms: r.p90_ms == null ? null : Math.round(Number(r.p90_ms)),
  }));
}

export async function dequeuePushes(batchSize = 50) {
  const result = await query(
    `SELECT * FROM push_queue WHERE sent_at IS NULL ORDER BY created_at ASC LIMIT $1`,
    [batchSize],
  );
  return result.rows;
}

export async function markPushSent(pushId: string, error?: string) {
  if (error) {
    await query(
      `UPDATE push_queue SET sent_at = NOW(), error = $2 WHERE id = $1`,
      [pushId, error],
    );
  } else {
    await query(
      `UPDATE push_queue SET sent_at = NOW(), error = NULL WHERE id = $1`,
      [pushId],
    );
  }
}

/* ================================================================
   FCM Sender (Legacy Server Key + HTTP v1)
   ================================================================ */

const FCM_LEGACY_ENDPOINT = 'https://fcm.googleapis.com/fcm/send';
const FCM_V1_ENDPOINT = 'https://fcm.googleapis.com/v1/projects/{projectId}/messages:send';

function isLegacyKey(key: string): boolean {
  // Legacy keys start with AIza... (older) or are ~175 chars long
  // V1 OAuth2 access tokens are typically much longer JWTs
  return key.length < 300;
}

function getFcmV1Endpoint(projectId: string) {
  return FCM_V1_ENDPOINT.replace('{projectId}', projectId);
}

/**
 * Send FCM push notification.
 * Automatically detects Legacy Server Key vs HTTP v1 OAuth2 token.
 *
 * Legacy: serverKey is the Firebase Cloud Messaging server key
 * V1:     serverKey is an OAuth2 access token, projectId is required
 */
export async function sendFcmToToken(
  serverKey: string,
  projectId: string,
  token: string,
  title: string,
  body: string,
  data?: Record<string, unknown>,
) {
  if (!serverKey) {
    throw new Error('FCM_SERVER_KEY not configured');
  }

  // Build common payload data
  const dataEntries = data
    ? Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)]))
    : undefined;

  if (isLegacyKey(serverKey)) {
    // ===== Legacy FCM API =====
    const payload = {
      to: token,
      notification: { title, body },
      data: dataEntries,
      priority: 'high',
    };

    const res = await fetch(FCM_LEGACY_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `key=${serverKey}`,
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`FCM Legacy error ${res.status}: ${text}`);
    }
    return res.json();
  }

  // ===== HTTP v1 API =====
  if (!projectId) {
    throw new Error('FCM_PROJECT_ID required for HTTP v1');
  }

  const message = {
    message: {
      token,
      notification: { title, body },
      data: dataEntries,
    },
  };

  const res = await fetch(getFcmV1Endpoint(projectId), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${serverKey}`,
    },
    body: JSON.stringify(message),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`FCM v1 error ${res.status}: ${text}`);
  }

  return res.json();
}

export async function sendPushToUser(
  serverKey: string,
  projectId: string,
  userId: string,
  title: string,
  body: string,
  data?: Record<string, unknown>,
) {
  const devices = await getUserDevices(userId);
  if (devices.length === 0) return { sent: 0, reason: 'no_devices' };

  const results = [];
  for (const device of devices) {
    try {
      await sendFcmToToken(serverKey, projectId, device.token, title, body, data);
      results.push({ platform: device.platform, ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      results.push({ platform: device.platform, ok: false, error: message });
    }
  }

  const okCount = results.filter((r) => r.ok).length;
  return { sent: okCount, total: devices.length, details: results };
}
