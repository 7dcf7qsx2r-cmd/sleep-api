import { Hono } from 'hono';
import { config } from '../config.js';
import { query } from '../db/client.js';
import { getVoiceProviderStatus } from '../services/providerCircuit.js';
import { getConcurrencySnapshot } from '../services/concurrency.js';

export const healthRoutes = new Hono();

healthRoutes.get('/', (c) =>
  c.json({
    service: 'sleep-api',
    status: 'running',
    endpoints: {
      health: '/health',
      auth: '/auth/guest · /auth/login · /auth/sms/send · /auth/sms/login · /auth/wechat/login · /auth/wechat/mp/login',
      sync: '/sync/bootstrap · /sync/:domain',
      ai: '/ai/chat · /ai/dream/interpret',
      energy: '/energy/account · /energy/spend · /energy/tasks',
      shop: '/shop/products · /shop/purchase',
      radar: '/api/radar/datapost · /api/radar/latest · /api/radar/report',
      iot: '/iot/devices · /iot/devices/bind',
    },
    app: '请使用小眠 App 或官网 Web 版本',
  }),
);

healthRoutes.get('/health', async (c) => {
  let dbOk = false;
  try {
    await query('SELECT 1');
    dbOk = true;
  } catch {
    dbOk = false;
  }
  return c.json({
    status: dbOk ? 'ok' : 'degraded',
    env: config.nodeEnv,
    db: dbOk,
    dbBackend: config.usePglite ? 'pglite' : 'postgres',
    deepseekConfigured: Boolean(config.deepseekApiKey),
    siliconflowConfigured: Boolean(config.siliconflowApiKey),
    smsConfigured: Boolean(config.sms.mock) || Boolean(
      config.sms.secretId && config.sms.sdkAppId && config.sms.signName && config.sms.templateId,
    ),
    wechatConfigured: Boolean(config.wechat.appId && config.wechat.appSecret),
    wechatMpConfigured: Boolean(config.wechatMp.appId && config.wechatMp.appSecret),
  });
});

/** 只读取本地配置与熔断状态，不向供应商发起计费请求。 */
healthRoutes.get('/health/providers', (c) => {
  const voice = getVoiceProviderStatus();
  c.header('Cache-Control', 'no-store');
  return c.json({
    status: voice.stt.status === 'available' && voice.tts.status === 'available'
      ? 'ok'
      : 'degraded',
    voice,
    concurrency: getConcurrencySnapshot(),
    source: 'local_config_and_circuit_state',
    billingRequests: 0,
    checkedAt: new Date().toISOString(),
  });
});
