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
  sentryDsn: process.env.SENTRY_DSN ?? '',
  quota: {
    guestChat: intEnv('QUOTA_GUEST_CHAT', 15),
    guestInterpret: intEnv('QUOTA_GUEST_INTERPRET', 2),
    userChat: intEnv('QUOTA_USER_CHAT', 80),
    userInterpret: intEnv('QUOTA_USER_INTERPRET', 10),
  },
};
