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
import { pushRoutes } from './routes/push.js';
import { radarRoutes } from './routes/radar.js';
import { adminRoutes } from './routes/admin/index.js';
import { expertRoutes } from './routes/experts.js';
import { contentRoutes } from './routes/content.js';

export function createApp() {
  const app = new Hono();

  app.use('*', logger());
  app.use('/uploads/*', serveStatic({ root: './' }));
  app.use(
    '*',
    cors({
      origin: (origin) => {
        if (!origin) return '*';
        if (
          origin.startsWith('http://localhost:') ||
          origin.startsWith('http://127.0.0.1:') ||
          origin.startsWith('exp://')
        ) {
          return origin;
        }
        if (origin.includes('xmianai.com')) {
          return origin;
        }
        return origin;
      },
      allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowHeaders: ['Content-Type', 'Authorization'],
    }),
  );

  app.route('/', healthRoutes);
  app.route('/auth', authRoutes);
  app.route('/ai', aiRoutes);
  app.route('/sync', syncRoutes);
  app.route('/energy', energyRoutes);
  app.route('/shop', shopRoutes);
  app.route('/social', socialRoutes);
  app.route('/push', pushRoutes);
  app.route('/api/radar', radarRoutes);
  app.route('/experts', expertRoutes);
  app.route('/content', contentRoutes);
  app.route('/admin', adminRoutes);

  app.notFound((c) => c.json({ error: 'not_found' }, 404));
  app.onError((err, c) => {
    console.error(err);
    return c.json({ error: 'internal_error', message: err.message }, 500);
  });

  return app;
}
