import { Hono } from 'hono';
import { config } from '../config.js';
import { query } from '../db/client.js';

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
    },
    app: '请在浏览器打开 http://localhost:8081 使用小眠 App',
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
