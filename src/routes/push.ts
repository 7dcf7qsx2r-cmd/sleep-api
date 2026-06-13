import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { requireAuth, type AuthVariables } from '../middleware/auth.js';
import { registerDevice, unregisterDevice } from '../services/push.js';

export const pushRoutes = new Hono<{ Variables: AuthVariables }>();

pushRoutes.use('*', requireAuth);

pushRoutes.post(
  '/register',
  zValidator(
    'json',
    z.object({
      platform: z.enum(['android', 'ios']),
      token: z.string().min(10),
    }),
  ),
  async (c) => {
    const auth = c.get('auth');
    if (auth.type !== 'user') return c.json({ error: 'guest_not_allowed' }, 403);
    const body = c.req.valid('json');
    const device = await registerDevice(auth.sub, body.platform, body.token);
    return c.json({ ok: true, device });
  },
);

pushRoutes.post(
  '/unregister',
  zValidator(
    'json',
    z.object({
      platform: z.enum(['android', 'ios']),
      token: z.string().min(10),
    }),
  ),
  async (c) => {
    const auth = c.get('auth');
    if (auth.type !== 'user') return c.json({ error: 'guest_not_allowed' }, 403);
    const body = c.req.valid('json');
    await unregisterDevice(auth.sub, body.platform, body.token);
    return c.json({ ok: true });
  },
);
