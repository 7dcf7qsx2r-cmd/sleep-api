import { createSign, createVerify } from 'node:crypto';

export interface AlipayConfig {
  appId: string;
  appPrivateKey: string;
  alipayPublicKey: string;
  notifyUrl: string;
  gateway: string;
}

export type AlipayNotifyPayload = Record<string, string>;

function pemBlock(kind: 'PRIVATE KEY' | 'PUBLIC KEY', raw: string): string {
  const trimmed = raw.trim().replace(/\\n/g, '\n');
  if (trimmed.includes('BEGIN ')) return trimmed;
  const body = trimmed.replace(/\s+/g, '').match(/.{1,64}/g)?.join('\n') ?? trimmed;
  return `-----BEGIN ${kind}-----\n${body}\n-----END ${kind}-----`;
}

export function isAlipayConfigured(cfg: AlipayConfig): boolean {
  return Boolean(cfg.appId && cfg.appPrivateKey && cfg.alipayPublicKey && cfg.notifyUrl);
}

export function shanghaiTimestamp(date = new Date()): string {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(date).replace('T', ' ');
}

export function buildSignedContent(params: Record<string, string>, omit: string[] = ['sign']): string {
  const skip = new Set(omit);
  return Object.keys(params)
    .filter((key) => !skip.has(key) && params[key] !== undefined && params[key] !== '')
    .sort()
    .map((key) => `${key}=${params[key]}`)
    .join('&');
}

export function signRsa2(content: string, privateKey: string): string {
  const signer = createSign('RSA-SHA256');
  signer.update(content, 'utf8');
  return signer.sign(pemBlock('PRIVATE KEY', privateKey), 'base64');
}

export function verifyRsa2(content: string, signature: string, publicKey: string): boolean {
  const verifier = createVerify('RSA-SHA256');
  verifier.update(content, 'utf8');
  try {
    return verifier.verify(pemBlock('PUBLIC KEY', publicKey), signature, 'base64');
  } catch {
    return false;
  }
}

export function signRequestParams(params: Record<string, string>, privateKey: string): Record<string, string> {
  const signed = { ...params };
  signed.sign = signRsa2(buildSignedContent(signed), privateKey);
  return signed;
}

export function toOrderString(params: Record<string, string>): string {
  return Object.keys(params)
    .sort()
    .map((key) => `${key}=${encodeURIComponent(params[key])}`)
    .join('&');
}

export function buildAppPayParams(cfg: AlipayConfig, biz: {
  outTradeNo: string;
  totalAmount: string;
  subject: string;
  body?: string;
}): Record<string, string> {
  return signRequestParams({
    app_id: cfg.appId,
    method: 'alipay.trade.app.pay',
    charset: 'utf-8',
    sign_type: 'RSA2',
    timestamp: shanghaiTimestamp(),
    version: '1.0',
    notify_url: cfg.notifyUrl,
    biz_content: JSON.stringify({
      out_trade_no: biz.outTradeNo,
      total_amount: biz.totalAmount,
      subject: biz.subject,
      body: biz.body ?? biz.subject,
      product_code: 'QUICK_MSECURITY_PAY',
      timeout_express: '30m',
    }),
  }, cfg.appPrivateKey);
}

export function verifyAlipayNotify(payload: AlipayNotifyPayload, alipayPublicKey: string): boolean {
  const sign = payload.sign;
  if (!sign) return false;
  const content = buildSignedContent(payload, ['sign', 'sign_type']);
  return verifyRsa2(content, sign, alipayPublicKey);
}

export function isPaidTradeStatus(status: string | undefined): boolean {
  return status === 'TRADE_SUCCESS' || status === 'TRADE_FINISHED';
}

export async function queryAlipayTrade(cfg: AlipayConfig, outTradeNo: string): Promise<{
  tradeStatus?: string;
  tradeNo?: string;
  totalAmount?: string;
  code?: string;
  msg?: string;
}> {
  const params = signRequestParams({
    app_id: cfg.appId,
    method: 'alipay.trade.query',
    charset: 'utf-8',
    sign_type: 'RSA2',
    timestamp: shanghaiTimestamp(),
    version: '1.0',
    biz_content: JSON.stringify({ out_trade_no: outTradeNo }),
  }, cfg.appPrivateKey);

  const body = new URLSearchParams(params);
  const res = await fetch(cfg.gateway, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
    body,
  });
  const json = await res.json() as {
    alipay_trade_query_response?: {
      code?: string;
      msg?: string;
      trade_status?: string;
      trade_no?: string;
      total_amount?: string;
    };
  };
  const data = json.alipay_trade_query_response ?? {};
  return {
    tradeStatus: data.trade_status,
    tradeNo: data.trade_no,
    totalAmount: data.total_amount,
    code: data.code,
    msg: data.msg,
  };
}
