import { query } from '../db/client.js';

/* ================================================================
   Device Registration
   ================================================================ */

export async function registerDevice(userId: string, platform: 'android' | 'ios', token: string) {
  const result = await query(
    `INSERT INTO push_devices (user_id, platform, token) VALUES ($1, $2, $3)
     ON CONFLICT (user_id, platform, token) DO UPDATE SET created_at = NOW()
     RETURNING *`,
    [userId, platform, token],
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

export interface PushPayload {
  userId: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
}

export async function enqueuePush(payload: PushPayload) {
  const result = await query(
    `INSERT INTO push_queue (user_id, title, body, data_json) VALUES ($1, $2, $3, $4) RETURNING *`,
    [payload.userId, payload.title, payload.body, JSON.stringify(payload.data ?? {})],
  );
  return result.rows[0];
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
