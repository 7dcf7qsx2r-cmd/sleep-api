import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { serveStatic } from '@hono/node-server/serve-static';
import { healthRoutes } from './routes/health.js';
import { authRoutes } from './routes/auth.js';
import { aiRoutes } from './routes/ai.js';
import { syncRoutes } from './routes/sync.js';
import { energyRoutes } from './routes/energy.js';
import { shopRoutes } from './routes/shop.js';
import { socialRoutes } from './routes/social.js';
import { gardenRoutes } from './routes/garden.js';
import { pushRoutes } from './routes/push.js';
import { radarRoutes } from './routes/radar.js';
import { adminRoutes } from './routes/admin/index.js';
import { expertRoutes } from './routes/experts.js';
import { contentRoutes } from './routes/content.js';
import { reportRoutes } from './routes/report.js';
import { config } from './config.js';

function isAllowedOrigin(origin: string): boolean {
  if (config.allowedOrigins.includes(origin)) return true;
  if (config.nodeEnv !== 'production') {
    return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin);
  }
  return false;
}

export function createApp() {
  const app = new Hono();

  app.use('*', logger());
  app.use('/uploads/*', serveStatic({ root: './' }));
  app.use(
    '*',
    cors({
      origin: (origin) => isAllowedOrigin(origin) ? origin : undefined,
      allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowHeaders: ['Content-Type', 'Authorization'],
      credentials: false,
    }),
  );

  app.route('/', healthRoutes);
  app.route('/auth', authRoutes);
  app.route('/ai', aiRoutes);
  app.route('/sync', syncRoutes);
  app.route('/energy', energyRoutes);
  app.route('/shop', shopRoutes);
  app.route('/social', socialRoutes);
  app.route('/social/garden', gardenRoutes);
  app.route('/push', pushRoutes);
  app.route('/api/radar', radarRoutes);
  app.route('/experts', expertRoutes);
  app.route('/content', contentRoutes);
  app.route('/report', reportRoutes);
  app.route('/admin', adminRoutes);

  app.notFound((c) => c.json({ error: 'not_found' }, 404));
  app.onError((err, c) => {
    console.error('[sleep-api] unhandled', {
      name: err.name,
      method: c.req.method,
      path: c.req.path,
    });
    return c.json({ error: 'internal_error', message: '服务器暂时不可用' }, 500);
  });

  return app;
}
