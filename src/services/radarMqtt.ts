import { config } from '../config.js';

export const BR_MATTRESS_PRODUCT_KEY = 'br_mattress';
export const BR_MATTRESS_PRODUCT_NAME = '小眠智能床垫-薄';

const SN_RE = /^[A-Z0-9][A-Z0-9_-]{5,63}$/;

export type RadarMqttKind = 'realtime' | 'sleep_report';

export function radarDeviceSn(raw: Record<string, unknown>, mac: string): string | null {
  const fromSn = typeof raw.sn === 'string' ? raw.sn.trim().toUpperCase() : '';
  if (fromSn && SN_RE.test(fromSn) && /[0-9]/.test(fromSn)) return fromSn;
  const fromMac = mac.replace(/[^0-9A-Fa-f]/g, '').toUpperCase();
  if (fromMac && SN_RE.test(fromMac) && /[0-9]/.test(fromMac)) return fromMac;
  return null;
}

export function radarMqttTopic(kind: RadarMqttKind, sn: string): string {
  const id = sn.trim().toUpperCase();
  return kind === 'realtime'
    ? `/sys/${BR_MATTRESS_PRODUCT_KEY}/${id}/thing/property/post`
    : `/sys/${BR_MATTRESS_PRODUCT_KEY}/${id}/thing/event/sleep_report/post`;
}

export type RadarMqttPublisher = (input: {
  sn: string;
  topic: string;
  payload: unknown;
}) => Promise<void>;

let publisher: RadarMqttPublisher | null = null;

export function setRadarMqttPublisher(fn: RadarMqttPublisher | null): void {
  publisher = fn;
}

async function publishViaControl(input: { sn: string; topic: string; payload: unknown }): Promise<void> {
  const base = config.mqttControl.url.replace(/\/$/, '');
  const token = config.mqttControl.adminToken;
  if (!base || !token) return;
  const res = await fetch(`${base}/v1/ingest`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      productKey: BR_MATTRESS_PRODUCT_KEY,
      productName: BR_MATTRESS_PRODUCT_NAME,
      sn: input.sn,
      topic: input.topic,
      payload: input.payload,
    }),
    signal: AbortSignal.timeout(4000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`mqtt ingest ${res.status} ${text.slice(0, 160)}`);
  }
}

/** 厂家原文转发到 MQTT 平台。单条失败只记日志，不影响推送接口的成功响应。 */
export async function forwardRadarUploads(
  kind: RadarMqttKind,
  records: Array<{ mac: string; raw?: Record<string, unknown> }>,
): Promise<number> {
  const send = publisher ?? publishViaControl;
  let forwarded = 0;
  for (const record of records) {
    const payload = record.raw ?? { mac: record.mac };
    const sn = radarDeviceSn(payload, record.mac);
    if (!sn) continue;
    try {
      await send({ sn, topic: radarMqttTopic(kind, sn), payload });
      forwarded += 1;
    } catch (err) {
      console.warn('[radar] mqtt forward failed', sn, err instanceof Error ? err.message : err);
    }
  }
  return forwarded;
}
