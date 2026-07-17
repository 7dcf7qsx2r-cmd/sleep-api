import 'dotenv/config';

function intEnv(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v) return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

const databaseUrl = process.env.DATABASE_URL ?? 'postgres://sleep:sleep@localhost:5432/sleep_api';

export const config = {
  port: intEnv('PORT', 8787),
  nodeEnv: process.env.NODE_ENV ?? 'development',
  databaseUrl,
  usePglite:
    process.env.USE_PGLITE === '1' ||
    process.env.USE_PGLITE === 'true' ||
    databaseUrl === 'pglite',
  pgliteDataDir: process.env.PGLITE_DATA_DIR ?? 'data/pglite',
  jwtSecret: process.env.JWT_SECRET ?? 'dev-only-jwt-secret-change-me',
  jwtExpiresIn: process.env.JWT_EXPIRES_IN ?? '30d',
  deepseekApiKey: process.env.DEEPSEEK_API_KEY ?? '',
  deepseekApiUrl: process.env.DEEPSEEK_API_URL ?? 'https://api.deepseek.com/v1/chat/completions',
  deepseekModel: process.env.DEEPSEEK_MODEL ?? 'deepseek-chat',
  siliconflowApiKey: process.env.SILICONFLOW_API_KEY ?? '',
  sentryDsn: process.env.SENTRY_DSN ?? '',
  /** 厂商推送雷达数据时的 Bearer Token；留空则不校验（开发环境） */
  radarPushSecret: process.env.RADAR_PUSH_SECRET ?? '',
  sms: {
    secretId: process.env.TENCENT_SMS_SECRET_ID ?? '',
    secretKey: process.env.TENCENT_SMS_SECRET_KEY ?? '',
    sdkAppId: process.env.TENCENT_SMS_SDK_APP_ID ?? '',
    signName: process.env.TENCENT_SMS_SIGN_NAME ?? '',
    templateId: process.env.TENCENT_SMS_TEMPLATE_ID ?? '',
    region: process.env.TENCENT_SMS_REGION ?? 'ap-guangzhou',
    mock: process.env.SMS_MOCK === '1' || process.env.SMS_MOCK === 'true',
    mockCode: process.env.SMS_MOCK_CODE ?? '123456',
    codeTtlSec: intEnv('SMS_CODE_TTL_SEC', 300),
    sendIntervalSec: intEnv('SMS_SEND_INTERVAL_SEC', 60),
    dailyLimitPerPhone: intEnv('SMS_DAILY_LIMIT_PER_PHONE', 10),
    hourlyLimitPerIp: intEnv('SMS_HOURLY_LIMIT_PER_IP', 20),
    maxAttempts: intEnv('SMS_MAX_VERIFY_ATTEMPTS', 5),
  },
  /** 微信开放平台 · 移动应用 OAuth */
  wechat: {
    appId: process.env.WECHAT_APP_ID ?? '',
    appSecret: process.env.WECHAT_APP_SECRET ?? '',
  },
  /** 微信小程序 · wx.login → jscode2session */
  wechatMp: {
    appId: process.env.WECHAT_MP_APP_ID ?? '',
    appSecret: process.env.WECHAT_MP_APP_SECRET ?? '',
  },
  quota: {
    guestChat: intEnv('QUOTA_GUEST_CHAT', 15),
    guestInterpret: intEnv('QUOTA_GUEST_INTERPRET', 2),
    userChat: intEnv('QUOTA_USER_CHAT', 80),
    userInterpret: intEnv('QUOTA_USER_INTERPRET', 10),
  },
};
