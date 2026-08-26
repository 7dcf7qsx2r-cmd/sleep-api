import { query } from '../db/client.js';

export const DEFAULT_IOT_PRODUCT_KEY = 'xiaomian_mvp';

export const CIS_MODELS = ['CIS-IB', 'CIS-ISWB', 'CIS-IP'] as const;
export type CisModel = (typeof CIS_MODELS)[number];

export function normalizeCisModel(input?: string | null): CisModel | null {
  if (!input) return null;
  const compact = input.trim().toUpperCase().replace(/\s+/g, '-').replace(/-+/g, '-');
  if (compact === 'CIS-IB' || compact === 'CISIB') return 'CIS-IB';
  if (compact === 'CIS-ISWB' || compact === 'CISISWB') return 'CIS-ISWB';
  if (compact === 'CIS-IP' || compact === 'CISIP') return 'CIS-IP';
  return null;
}

export function normalizeIotSn(input: string): string {
  return input.trim().toUpperCase();
}

export function isValidIotSn(input: string): boolean {
  const sn = normalizeIotSn(input);
  return /^[A-Z0-9][A-Z0-9_-]{5,63}$/.test(sn) && /[0-9]/.test(sn);
}

export class IotBindError extends Error {
  constructor(
    public readonly code: 'invalid_sn' | 'invalid_model' | 'already_bound' | 'not_found' | 'not_bound',
    message: string,
  ) {
    super(message);
    this.name = 'IotBindError';
  }
}

export interface IotBinding {
  productKey: string;
  sn: string;
  alias: string | null;
  model: CisModel | null;
  boundAt: string;
  lastSeenAt: string | null;
  online: boolean;
}

export interface IotLatestMessage {
  productKey: string;
  sn: string;
  topic: string;
  raw: unknown;
  receivedAt: string;
}

const ONLINE_MS = 3 * 60 * 1000;

function isOnline(lastSeenAt: Date | null): boolean {
  if (!lastSeenAt) return false;
  return Date.now() - lastSeenAt.getTime() < ONLINE_MS;
}

export async function bindIotDevice(input: {
  userId: string;
  sn: string;
  productKey?: string;
  alias?: string;
  model?: string;
}): Promise<IotBinding> {
  const sn = normalizeIotSn(input.sn);
  if (!isValidIotSn(sn)) {
    throw new IotBindError('invalid_sn', '设备 SN 无效，请填写机身序列号');
  }
  const productKey = (input.productKey?.trim() || DEFAULT_IOT_PRODUCT_KEY);
  const alias = input.alias?.trim() || null;
  let model: CisModel | null = null;
  if (input.model != null && input.model.trim() !== '') {
    model = normalizeCisModel(input.model);
    if (!model) {
      throw new IotBindError('invalid_model', '设备型号无效');
    }
  }

  const existing = await query<{ user_id: string }>(
    `SELECT user_id FROM iot_device_bindings WHERE product_key = $1 AND sn = $2`,
    [productKey, sn],
  );
  const owner = existing.rows[0]?.user_id;
  if (owner && owner !== input.userId) {
    throw new IotBindError('already_bound', '该设备已绑定其他账号');
  }

  await query(
    `INSERT INTO iot_device_bindings (product_key, sn, user_id, alias, model, bound_at)
     VALUES ($1, $2, $3, $4, $5, NOW())
     ON CONFLICT (product_key, sn) DO UPDATE SET
       user_id = EXCLUDED.user_id,
       alias = COALESCE(EXCLUDED.alias, iot_device_bindings.alias),
       model = COALESCE(EXCLUDED.model, iot_device_bindings.model),
       bound_at = NOW()`,
    [productKey, sn, input.userId, alias, model],
  );

  const listed = await listBoundIotDevices(input.userId);
  const bound = listed.find((d) => d.sn === sn && d.productKey === productKey);
  return bound ?? {
    productKey,
    sn,
    alias,
    model,
    boundAt: new Date().toISOString(),
    lastSeenAt: null,
    online: false,
  };
}

export async function unbindIotDevice(userId: string, sn: string, productKey = DEFAULT_IOT_PRODUCT_KEY): Promise<void> {
  const id = normalizeIotSn(sn);
  const { rowCount } = await query(
    `DELETE FROM iot_device_bindings
     WHERE user_id = $1 AND sn = $2 AND product_key = $3`,
    [userId, id, productKey],
  );
  if (rowCount === 0) {
    throw new IotBindError('not_bound', '未绑定该设备');
  }
}

export async function listBoundIotDevices(userId: string): Promise<IotBinding[]> {
  const { rows } = await query<{
    product_key: string;
    sn: string;
    alias: string | null;
    model: string | null;
    bound_at: Date;
    last_seen_at: Date | null;
  }>(
    `SELECT b.product_key, b.sn, b.alias, b.model, b.bound_at, d.last_seen_at
     FROM iot_device_bindings b
     LEFT JOIN iot_devices d ON d.sn = b.sn
     WHERE b.user_id = $1
     ORDER BY b.bound_at DESC`,
    [userId],
  );
  return rows.map((r) => ({
    productKey: r.product_key,
    sn: r.sn,
    alias: r.alias,
    model: normalizeCisModel(r.model),
    boundAt: r.bound_at.toISOString(),
    lastSeenAt: r.last_seen_at?.toISOString() ?? null,
    online: isOnline(r.last_seen_at),
  }));
}

async function assertOwned(userId: string, sn: string, productKey: string): Promise<void> {
  const { rows } = await query<{ user_id: string }>(
    `SELECT user_id FROM iot_device_bindings WHERE product_key = $1 AND sn = $2`,
    [productKey, sn],
  );
  if (!rows[0]) throw new IotBindError('not_found', '未绑定该设备');
  if (rows[0].user_id !== userId) throw new IotBindError('not_found', '未绑定该设备');
}

export async function getOwnedIotLatest(
  userId: string,
  sn: string,
  productKey = DEFAULT_IOT_PRODUCT_KEY,
): Promise<IotLatestMessage | null> {
  const id = normalizeIotSn(sn);
  await assertOwned(userId, id, productKey);
  const { rows } = await query<{
    product_key: string;
    sn: string;
    topic: string;
    raw_json: unknown;
    received_at: Date;
  }>(
    `SELECT product_key, sn, topic, raw_json, received_at
     FROM iot_messages_latest
     WHERE sn = $1
     ORDER BY
       CASE WHEN topic LIKE '%/up/realtime' THEN 0 ELSE 1 END,
       received_at DESC
     LIMIT 1`,
    [id],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    productKey: row.product_key,
    sn: row.sn,
    topic: row.topic,
    raw: row.raw_json,
    receivedAt: row.received_at.toISOString(),
  };
}

export async function listOwnedIotMessages(
  userId: string,
  sn: string,
  productKey = DEFAULT_IOT_PRODUCT_KEY,
  limit = 50,
): Promise<IotLatestMessage[]> {
  const id = normalizeIotSn(sn);
  await assertOwned(userId, id, productKey);
  const clamped = Math.min(Math.max(Math.floor(limit), 1), 200);
  const { rows } = await query<{
    product_key: string;
    sn: string;
    topic: string;
    raw_json: unknown;
    received_at: Date;
  }>(
    `SELECT product_key, sn, topic, raw_json, received_at
     FROM iot_messages
     WHERE sn = $1
     ORDER BY received_at DESC
     LIMIT $2`,
    [id, clamped],
  );
  return rows.map((row) => ({
    productKey: row.product_key,
    sn: row.sn,
    topic: row.topic,
    raw: row.raw_json,
    receivedAt: row.received_at.toISOString(),
  }));
}
