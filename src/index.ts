import { serve } from '@hono/node-server';
import * as Sentry from '@sentry/node';
import { config } from './config.js';
import { createApp } from './app.js';

if (config.sentryDsn) {
  Sentry.init({
    dsn: config.sentryDsn,
    environment: config.nodeEnv,
    tracesSampleRate: 0.1,
  });
}

const app = createApp();

serve({
  fetch: app.fetch,
  port: config.port,
}, (info) => {
  console.log(`sleep-api listening on http://localhost:${info.port}`);
  if (!config.deepseekApiKey) {
    console.warn('[sleep-api] DEEPSEEK_API_KEY not set — AI routes will return fallbacks');
  }
});
