import { query } from '../db/client.js';
import { isValidIotSn, normalizeIotSn } from './iot.js';

const ONLINE_MS = 3 * 60 * 1000;

export const IOT_WATCH_PRODUCT_LABEL: Record<string, string> = {
  cis_ib: '智能床垫',
  cis_iswb: '智能撑腰垫',
  cis_ip: '智能枕',
};

export interface IotWatchDevice {
  sn: string;
  productKey: string;
  label: string;
  lastAt: string;
  online: boolean;
}

export interface IotWatchMessage {
  id: string;
  productKey: string;
  sn: string;
  topic: string;
  shortTopic: string;
  receivedAt: string;
  summary: string;
  highlight: 'idle' | 'occupied' | 'command' | 'ota' | 'sleep' | 'other';
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function paramsOf(raw: unknown): Record<string, unknown> {
  const root = asRecord(raw);
  if (!root) return {};
  return asRecord(root.params) ?? root;
}

export function shortTopic(topic: string, sn: string, productKey: string): string {
  return topic
    .replace(`/sys/${productKey}/${sn}/`, '')
    .replace(`${productKey}/${sn}/`, '');
}

export function compactIotParams(params: Record<string, unknown>): string {
  const bits: string[] = [];
  const status = asRecord(params.deviceStatus);
  if (params.airbagsPerson != null) bits.push(`person=${JSON.stringify(params.airbagsPerson)}`);
  if (params.HR != null) bits.push(`HR=${JSON.stringify(params.HR)}`);
  if (params.heartData != null) bits.push(`heartData=${JSON.stringify(params.heartData)}`);
  if (status) {
    if (status.person != null) bits.push(`person=${String(status.person)}`);
    if (status.heart != null) bits.push(`heart=${String(status.heart)}`);
    if (status.breathing != null) bits.push(`breath=${String(status.breathing)}`);
  }
  if (params.airbagsPressure != null) bits.push(`P=${JSON.stringify(params.airbagsPressure)}`);
  if (params.pressureLeft != null || params.pressureRight != null) {
    bits.push(`P=[${String(params.pressureLeft)},${String(params.pressureRight)}]`);
  } else if (status && (status.pressureLeft != null || status.pressureRight != null)) {
    bits.push(`P=[${String(status.pressureLeft)},${String(status.pressureRight)}]`);
  }
  if (params.heatData != null) bits.push(`heat=${JSON.stringify(params.heatData)}`);
  if (status && (status.heatingStatus != null || status.heatingTemp != null)) {
    bits.push(`heat=${String(status.heatingStatus ?? '-')}/${String(status.heatingTemp ?? '-')}`);
  }
  if (params.airbagsMode != null) bits.push(`mode=${JSON.stringify(params.airbagsMode)}`);
  if (status?.workMode != null) bits.push(`work=${String(status.workMode)}`);
  if (status?.snoreStatus != null) bits.push(`snore=${String(status.snoreStatus)}`);
  if (params.sleepMaxPressure != null) bits.push(`sleepMax=${String(params.sleepMaxPressure)}`);
  const sleep = asRecord(params.SleepReportNew)?.ISWBSleepReport
    ?? asRecord(params.SleepReportNew)?.iswbSleepReport
    ?? asRecord(params.SleepReportNew)?.ibNew
    ?? params.ISWBSleepReport
    ?? params.ibNew;
  if (sleep != null) bits.push(`sleep=${JSON.stringify(sleep)}`);
  if (typeof params.firmwareVer === 'string' && params.firmwareVer) {
    bits.push(`fw=${params.firmwareVer}`);
  }
  for (const key of Object.keys(params)) {
    if (key.startsWith('set') || key === 'socketStatus') {
      bits.push(`${key}=${JSON.stringify(params[key])}`);
    }
  }
  return bits.join('  ');
}

export function highlightIotParams(
  topic: string,
  params: Record<string, unknown>,
): IotWatchMessage['highlight'] {
  if (topic.includes('ota')) return 'ota';
  if (topic.includes('service')) return 'command';
  if (params.SleepReportNew != null || params.ISWBSleepReport != null || params.ibNew != null) {
    return 'sleep';
  }
  const person = params.airbagsPerson;
  if (Array.isArray(person) && person.some((v) => v === 1 || v === 0)) return 'occupied';
  const hr = params.HR;
  if (Array.isArray(hr) && hr.some((v) => typeof v === 'number' && v > 0)) return 'occupied';
  const heart = params.heartData;
  if (Array.isArray(heart) && heart.some((v) => typeof v === 'number' && v > 0)) return 'occupied';
  const status = asRecord(params.deviceStatus);
  if (status) {
    if (status.person === 1) return 'occupied';
    if (typeof status.heart === 'number' && status.heart > 0) return 'occupied';
    if (typeof status.breathing === 'number' && status.breathing > 0) return 'occupied';
    return 'idle';
  }
  if (params.airbagsPerson != null || params.HR != null || params.heartData != null) return 'idle';
  return 'other';
}

export interface IotWatchSearchHit {
  sn: string;
  productKey: string;
  label: string;
  alias: string | null;
  lastAt: string | null;
  online: boolean;
  bound: boolean;
  userId: string | null;
  nickname: string | null;
  username: string | null;
  phone: string | null;
  wechatOpenId: string | null;
  wechatUnionId: string | null;
}

export function normalizeWatchSearchQuery(raw: string): { like: string; digits: string } {
  const like = raw.trim();
  const digits = like.replace(/\D/g, '');
  return { like, digits };
}

export async function searchWatchBindings(rawQuery: string, limit = 40): Promise<IotWatchSearchHit[]> {
  const clamped = Math.min(Math.max(Math.floor(limit), 1), 80);
  const { like, digits } = normalizeWatchSearchQuery(rawQuery);
  const likePat = like ? `%${like}%` : '';
  const digitPat = digits.length >= 4 ? `%${digits}%` : '';

  const { rows } = await query<{
    sn: string;
    product_key: string;
    alias: string | null;
    last_at: Date | null;
    user_id: string | null;
    username: string | null;
    phone: string | null;
    wechat_openid: string | null;
    wechat_unionid: string | null;
    nickname: string | null;
  }>(
    `SELECT
        COALESCE(b.sn, l.sn) AS sn,
        COALESCE(b.product_key, l.product_key, '') AS product_key,
        b.alias,
        l.last_at,
        b.user_id,
        u.username,
        u.phone,
        u.wechat_openid,
        u.wechat_unionid,
        p.nickname
     FROM iot_device_bindings b
     FULL OUTER JOIN (
       SELECT sn, MAX(product_key) AS product_key, MAX(received_at) AS last_at
       FROM iot_messages_latest
       GROUP BY sn
     ) l ON l.sn = b.sn
     LEFT JOIN users u ON u.id = b.user_id AND u.deleted_at IS NULL
     LEFT JOIN user_profiles p ON p.user_id = u.id
     WHERE ($1 = '' OR (
       COALESCE(b.sn, l.sn) ILIKE $2
       OR COALESCE(b.alias, '') ILIKE $2
       OR COALESCE(b.model, '') ILIKE $2
       OR COALESCE(u.username, '') ILIKE $2
       OR COALESCE(p.nickname, '') ILIKE $2
       OR COALESCE(u.phone, '') ILIKE $2
       OR COALESCE(u.wechat_openid, '') ILIKE $2
       OR COALESCE(u.wechat_unionid, '') ILIKE $2
       OR ($3 <> '' AND regexp_replace(COALESCE(u.phone, ''), '\\D', '', 'g') LIKE $3)
     ))
     ORDER BY l.last_at DESC NULLS LAST, COALESCE(b.sn, l.sn)
     LIMIT $4`,
    [like, likePat, digitPat, clamped],
  );

  const now = Date.now();
  return rows.map((row) => ({
    sn: row.sn,
    productKey: row.product_key,
    label: IOT_WATCH_PRODUCT_LABEL[row.product_key] ?? row.product_key ?? '设备',
    alias: row.alias,
    lastAt: row.last_at ? row.last_at.toISOString() : null,
    online: row.last_at ? now - row.last_at.getTime() < ONLINE_MS : false,
    bound: Boolean(row.user_id),
    userId: row.user_id,
    nickname: row.nickname,
    username: row.username,
    phone: row.phone,
    wechatOpenId: row.wechat_openid,
    wechatUnionId: row.wechat_unionid,
  }));
}

export async function listWatchDevices(limit = 40): Promise<IotWatchDevice[]> {
  const clamped = Math.min(Math.max(Math.floor(limit), 1), 80);
  const { rows } = await query<{ sn: string; product_key: string; last_at: Date }>(
    `SELECT sn, MAX(product_key) AS product_key, MAX(received_at) AS last_at
     FROM iot_messages_latest
     GROUP BY sn
     ORDER BY last_at DESC
     LIMIT $1`,
    [clamped],
  );
  const now = Date.now();
  return rows.map((row) => ({
    sn: row.sn,
    productKey: row.product_key,
    label: IOT_WATCH_PRODUCT_LABEL[row.product_key] ?? row.product_key,
    lastAt: row.last_at.toISOString(),
    online: now - row.last_at.getTime() < ONLINE_MS,
  }));
}

export async function listWatchMessages(params: {
  sn: string;
  afterId?: string;
  limit?: number;
}): Promise<IotWatchMessage[]> {
  const sn = normalizeIotSn(params.sn);
  if (!isValidIotSn(sn)) {
    throw new Error('invalid_sn');
  }
  const limit = Math.min(Math.max(Math.floor(params.limit ?? 80), 1), 200);
  const afterId = params.afterId?.trim() || '0';
  if (!/^\d+$/.test(afterId)) {
    throw new Error('invalid_after_id');
  }

  const { rows } = await query<{
    id: string | number | bigint;
    product_key: string;
    sn: string;
    topic: string;
    raw_json: unknown;
    received_at: Date;
  }>(
    afterId === '0'
      ? `SELECT id, product_key, sn, topic, raw_json, received_at
         FROM (
           SELECT id, product_key, sn, topic, raw_json, received_at
           FROM iot_messages
           WHERE sn = $1
           ORDER BY id DESC
           LIMIT $2
         ) recent
         ORDER BY id ASC`
      : `SELECT id, product_key, sn, topic, raw_json, received_at
         FROM iot_messages
         WHERE sn = $1 AND id > $2::bigint
         ORDER BY id ASC
         LIMIT $3`,
    afterId === '0' ? [sn, limit] : [sn, afterId, limit],
  );

  return rows.map((row) => {
    const payload = paramsOf(row.raw_json);
    const topic = row.topic;
    return {
      id: String(row.id),
      productKey: row.product_key,
      sn: row.sn,
      topic,
      shortTopic: shortTopic(topic, row.sn, row.product_key),
      receivedAt: row.received_at.toISOString(),
      summary: compactIotParams(payload),
      highlight: highlightIotParams(topic, payload),
    };
  });
}
