import { query } from '../db/client.js';
import { validateCisServiceCommand } from './iotCommands.js';
import { IotDownlinkError, publishIotDownlink } from './iotDownlink.js';

export const DEFAULT_IOT_PRODUCT_KEY = 'xiaomian_mvp';

export const CIS_PRODUCT_KEYS = {
  'CIS-IB': 'cis_ib',
  'CIS-ISWB': 'cis_iswb',
  'CIS-IP': 'cis_ip',
} as const;

export function productKeyForCisModel(model?: string | null): string | null {
  const normalized = normalizeCisModel(model);
  return normalized ? CIS_PRODUCT_KEYS[normalized] : null;
}

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
    public readonly code:
      | 'invalid_sn'
      | 'invalid_model'
      | 'already_bound'
      | 'not_found'
      | 'not_bound'
      | 'invalid_command'
      | 'unavailable',
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
  sleepRaw?: unknown;
  sleepReceivedAt?: string;
  configRaw?: unknown;
  configReceivedAt?: string;
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
  let model: CisModel | null = null;
  if (input.model != null && input.model.trim() !== '') {
    model = normalizeCisModel(input.model);
    if (!model) {
      throw new IotBindError('invalid_model', '设备型号无效');
    }
  }
  const registered = await query<{ product_key: string }>(
    `SELECT product_key FROM iot_devices WHERE sn = $1`,
    [sn],
  );
  const existing = await query<{ user_id: string; product_key: string; model: string | null }>(
    `SELECT user_id, product_key, model FROM iot_device_bindings WHERE sn = $1`,
    [sn],
  );
  const owner = existing.rows[0]?.user_id;
  if (owner && owner !== input.userId) {
    throw new IotBindError('already_bound', '该设备已绑定其他账号');
  }
  if (!model && existing.rows[0]?.model) {
    model = normalizeCisModel(existing.rows[0].model);
  }
  const productKey = (
    productKeyForCisModel(model)
    || input.productKey?.trim()
    || existing.rows[0]?.product_key
    || registered.rows[0]?.product_key
    || DEFAULT_IOT_PRODUCT_KEY
  );
  const alias = input.alias?.trim() || null;

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
  await query(
    `DELETE FROM iot_device_bindings
     WHERE user_id = $1 AND sn = $2 AND product_key <> $3`,
    [input.userId, sn, productKey],
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

export async function unbindIotDevice(userId: string, sn: string, _productKey?: string): Promise<void> {
  const id = normalizeIotSn(sn);
  const { rowCount } = await query(
    `DELETE FROM iot_device_bindings
     WHERE user_id = $1 AND sn = $2`,
    [userId, id],
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

async function assertOwned(userId: string, sn: string, productKey?: string): Promise<void> {
  if (productKey) {
    const { rows } = await query<{ user_id: string }>(
      `SELECT user_id FROM iot_device_bindings WHERE product_key = $1 AND sn = $2`,
      [productKey, sn],
    );
    if (rows[0]?.user_id === userId) return;
  }
  const { rows } = await query<{ user_id: string }>(
    `SELECT user_id FROM iot_device_bindings WHERE sn = $1`,
    [sn],
  );
  if (!rows[0] || rows[0].user_id !== userId) {
    throw new IotBindError('not_found', '未绑定该设备');
  }
}

function iotParams(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  if (obj.params && typeof obj.params === 'object' && !Array.isArray(obj.params)) {
    return obj.params as Record<string, unknown>;
  }
  return obj;
}

function payloadHasSleepReport(raw: unknown): boolean {
  const params = iotParams(raw);
  return params != null && (params.SleepReportNew != null || params.sleepReportNew != null);
}

function payloadHasConfig(raw: unknown): boolean {
  const params = iotParams(raw);
  return params != null && params.characteristic != null;
}

async function getLatestParamRaw(
  sn: string,
  sqlFilter: string,
): Promise<{ raw: unknown; receivedAt: string } | null> {
  const { rows } = await query<{ raw_json: unknown; received_at: Date }>(
    `SELECT raw_json, received_at
     FROM iot_messages
     WHERE sn = $1 AND (${sqlFilter})
     ORDER BY received_at DESC
     LIMIT 1`,
    [sn],
  );
  const row = rows[0];
  if (!row) return null;
  return { raw: row.raw_json, receivedAt: row.received_at.toISOString() };
}

function getLatestSleepRaw(sn: string) {
  return getLatestParamRaw(
    sn,
    `raw_json->'params'->'SleepReportNew' IS NOT NULL
     OR raw_json->'params'->'sleepReportNew' IS NOT NULL`,
  );
}

function getLatestConfigRaw(sn: string) {
  return getLatestParamRaw(sn, `raw_json->'params'->'characteristic' IS NOT NULL`);
}

export async function getOwnedIotLatest(
  userId: string,
  sn: string,
  productKey?: string,
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
       CASE
         WHEN topic LIKE '%/thing/property/post' THEN 0
         WHEN topic LIKE '%/up/realtime' THEN 1
         ELSE 2
       END,
       received_at DESC
     LIMIT 1`,
    [id],
  );
  const row = rows[0];
  if (!row) return null;
  const receivedAt = row.received_at.toISOString();
  const [sleep, config] = await Promise.all([
    payloadHasSleepReport(row.raw_json)
      ? Promise.resolve({ raw: row.raw_json, receivedAt })
      : getLatestSleepRaw(id),
    payloadHasConfig(row.raw_json)
      ? Promise.resolve({ raw: row.raw_json, receivedAt })
      : getLatestConfigRaw(id),
  ]);
  return {
    productKey: row.product_key,
    sn: row.sn,
    topic: row.topic,
    raw: row.raw_json,
    receivedAt,
    ...(sleep ? { sleepRaw: sleep.raw, sleepReceivedAt: sleep.receivedAt } : {}),
    ...(config ? { configRaw: config.raw, configReceivedAt: config.receivedAt } : {}),
  };
}

export async function listOwnedIotMessages(
  userId: string,
  sn: string,
  productKey?: string,
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

export async function invokeOwnedIotCommand(input: {
  userId: string;
  sn: string;
  productKey?: string;
  service: string;
  params: Record<string, unknown>;
}): Promise<{ topic: string; service: string; payload: unknown }> {
  const sn = normalizeIotSn(input.sn);
  if (!isValidIotSn(sn)) {
    throw new IotBindError('invalid_sn', '设备 SN 无效');
  }
  const service = input.service.trim();
  if (!service) {
    throw new IotBindError('invalid_command', '缺少服务名');
  }
  await assertOwned(input.userId, sn, input.productKey);
  const { rows } = await query<{ product_key: string; model: string | null }>(
    `SELECT product_key, model FROM iot_device_bindings
     WHERE sn = $1 AND user_id = $2
     ORDER BY CASE WHEN product_key IN ('cis_ib', 'cis_iswb', 'cis_ip') THEN 0 ELSE 1 END
     LIMIT 1`,
    [sn, input.userId],
  );
  const binding = rows[0];
  if (!binding) {
    throw new IotBindError('not_found', '未绑定该设备');
  }
  const fromModel = productKeyForCisModel(binding.model);
  const fromInput = input.productKey === 'cis_ib' || input.productKey === 'cis_iswb' || input.productKey === 'cis_ip'
    ? input.productKey
    : null;
  if (fromInput && fromModel && fromInput !== fromModel) {
    throw new IotBindError('invalid_command', '设备型号不匹配');
  }
  const productKey = fromModel || fromInput || binding.product_key;
  const validated = validateCisServiceCommand(productKey, service, input.params);
  if (!validated.ok) {
    throw new IotBindError('invalid_command', validated.message);
  }
  try {
    const published = await publishIotDownlink({
      productKey,
      sn,
      payload: validated.payload,
    });
    return { topic: published.topic, service, payload: validated.payload };
  } catch (err) {
    if (err instanceof IotDownlinkError) {
      throw new IotBindError(err.code === 'unavailable' ? 'unavailable' : 'invalid_command', err.message);
    }
    throw err;
  }
}
