import { createHash, randomUUID } from 'node:crypto';
import { config } from '../config.js';

export type PushProviderName = 'getui' | 'jpush' | 'fcm';

export interface PushTarget {
  provider: PushProviderName;
  token: string;
  platform: 'android' | 'ios';
}

export interface PushMessage {
  title: string;
  body: string;
  data: Record<string, unknown>;
  /** 超过即作废（离床类 60 秒） */
  ttlSec: number;
  /** 静默提醒：无声无震动，走低重要性渠道 */
  silent: boolean;
  /** Android 通知渠道 ID，与 App 注册的渠道一致 */
  channelId: string;
}

export type PushSendResult = { status: 'sent' } | { status: 'skipped'; reason: string } | { status: 'failed'; error: string };

export interface PushProvider {
  name: PushProviderName;
  configured(): boolean;
  send(target: PushTarget, message: PushMessage): Promise<PushSendResult>;
}

function stringData(data: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(Object.entries(data).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]));
}

async function postJson(url: string, headers: Record<string, string>, body: unknown, timeoutMs = 8_000): Promise<{ ok: boolean; status: number; json: unknown; text: string }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json;charset=utf-8', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let json: unknown = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON 响应保留原文 */ }
  return { ok: res.ok, status: res.status, json, text };
}

/* ---------------- 个推 RestAPI v2 ---------------- */

let getuiToken: { value: string; expiresAt: number } | null = null;

async function getuiAuth(): Promise<string> {
  if (getuiToken && getuiToken.expiresAt > Date.now() + 60_000) return getuiToken.value;
  const { getuiAppId, getuiAppKey, getuiMasterSecret } = config.push;
  const timestamp = String(Date.now());
  const sign = createHash('sha256').update(`${getuiAppKey}${timestamp}${getuiMasterSecret}`).digest('hex');
  const res = await postJson(`https://restapi.getui.com/v2/${getuiAppId}/auth`, {}, { sign, timestamp, appkey: getuiAppKey });
  const data = (res.json as { code?: number; data?: { token?: string; expire_time?: string } } | null);
  if (!res.ok || data?.code !== 0 || !data.data?.token) throw new Error(`getui auth ${res.status}: ${res.text.slice(0, 200)}`);
  getuiToken = { value: data.data.token, expiresAt: Number(data.data.expire_time ?? Date.now() + 3600_000) };
  return getuiToken.value;
}

const getuiProvider: PushProvider = {
  name: 'getui',
  configured: () => Boolean(config.push.getuiAppId && config.push.getuiAppKey && config.push.getuiMasterSecret),
  async send(target, message) {
    const token = await getuiAuth();
    const notification = {
      title: message.title,
      body: message.body,
      click_type: 'payload',
      payload: JSON.stringify(message.data),
      channel_id: message.channelId,
      channel_level: message.silent ? 1 : 4,
    };
    const res = await postJson(
      `https://restapi.getui.com/v2/${config.push.getuiAppId}/push/single/cid`,
      { token },
      {
        request_id: randomUUID().replace(/-/g, '').slice(0, 32),
        settings: { ttl: message.ttlSec * 1000 },
        audience: { cid: [target.token] },
        push_message: { notification },
        push_channel: {
          android: { ups: { notification: { title: message.title, body: message.body, click_type: 'startapp' } } },
          ios: {
            type: 'notify',
            payload: JSON.stringify(message.data),
            aps: { alert: { title: message.title, body: message.body }, sound: message.silent ? '' : 'default' },
          },
        },
      },
    );
    const data = res.json as { code?: number; msg?: string } | null;
    if (res.ok && data?.code === 0) return { status: 'sent' };
    if (data?.code === 10001) getuiToken = null;
    return { status: 'failed', error: `getui ${res.status} ${data?.code ?? ''} ${data?.msg ?? res.text.slice(0, 200)}` };
  },
};

/* ---------------- 极光 JPush v3 ---------------- */

const jpushProvider: PushProvider = {
  name: 'jpush',
  configured: () => Boolean(config.push.jpushAppKey && config.push.jpushMasterSecret),
  async send(target, message) {
    const auth = Buffer.from(`${config.push.jpushAppKey}:${config.push.jpushMasterSecret}`).toString('base64');
    const extras = stringData(message.data);
    const res = await postJson(
      'https://api.jpush.cn/v3/push',
      { Authorization: `Basic ${auth}` },
      {
        platform: [target.platform],
        audience: { registration_id: [target.token] },
        notification: {
          android: {
            alert: message.body,
            title: message.title,
            extras,
            channel_id: message.channelId,
            priority: message.silent ? -1 : 1,
            alert_type: message.silent ? 0 : 7,
          },
          ios: {
            alert: { title: message.title, body: message.body },
            sound: message.silent ? '' : 'default',
            extras,
          },
        },
        options: { time_to_live: message.ttlSec, apns_production: config.push.apnsProduction },
      },
    );
    if (res.ok) return { status: 'sent' };
    return { status: 'failed', error: `jpush ${res.status} ${res.text.slice(0, 200)}` };
  },
};

/* ---------------- FCM（海外 / 旧客户端） ---------------- */

const fcmProvider: PushProvider = {
  name: 'fcm',
  configured: () => Boolean(config.push.fcmServerKey),
  async send(target, message) {
    const { sendFcmToToken } = await import('./push.js');
    try {
      await sendFcmToToken(config.push.fcmServerKey, config.push.fcmProjectId, target.token, message.title, message.body, message.data);
      return { status: 'sent' };
    } catch (err) {
      return { status: 'failed', error: err instanceof Error ? err.message : String(err) };
    }
  },
};

const PROVIDERS: Record<PushProviderName, PushProvider> = {
  getui: getuiProvider,
  jpush: jpushProvider,
  fcm: fcmProvider,
};

let overrides: Partial<Record<PushProviderName, PushProvider>> = {};

/** 测试注入。 */
export function setPushProviderOverrides(next: Partial<Record<PushProviderName, PushProvider>>): void {
  overrides = next;
}

export async function sendViaProvider(target: PushTarget, message: PushMessage): Promise<PushSendResult> {
  const provider = overrides[target.provider] ?? PROVIDERS[target.provider];
  if (!provider) return { status: 'skipped', reason: `unknown_provider_${target.provider}` };
  if (!provider.configured()) return { status: 'skipped', reason: `${provider.name}_not_configured` };
  try {
    return await provider.send(target, message);
  } catch (err) {
    return { status: 'failed', error: err instanceof Error ? err.message : String(err) };
  }
}
