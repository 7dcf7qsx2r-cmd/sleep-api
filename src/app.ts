import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { healthRoutes } from './routes/health.js';
import { authRoutes } from './routes/auth.js';
import { aiRoutes } from './routes/ai.js';
import { syncRoutes } from './routes/sync.js';
import { energyRoutes } from './routes/energy.js';
import { shopRoutes } from './routes/shop.js';
import { socialRoutes } from './routes/social.js';
import { pushRoutes } from './routes/push.js';

export function createApp() {
  const app = new Hono();

  app.use('*', logger());
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

  app.notFound((c) => c.json({ error: 'not_found' }, 404));
  app.onError((err, c) => {
    console.error(err);
    return c.json({ error: 'internal_error', message: err.message }, 500);
  });

  return app;
}
