import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { createGuestSession, loginWithPassword } from '../services/auth.js';
import { copyBlobsFromGuestToUser } from '../services/dataBlob.js';
import { ensureEnergyAccount } from '../services/energy.js';
import { verifyToken } from '../lib/jwt.js';

export const authRoutes = new Hono();

authRoutes.post(
  '/guest',
  zValidator(
    'json',
    z.object({
      deviceId: z.string().max(128).optional(),
    }),
  ),
  async (c) => {
    const { deviceId } = c.req.valid('json');
    const session = await createGuestSession(deviceId);
    return c.json({
      token: session.token,
      guestId: session.guestId,
      subjectType: 'guest',
      expiresIn: process.env.JWT_EXPIRES_IN ?? '30d',
    });
  },
);

authRoutes.post(
  '/login',
  zValidator(
    'json',
    z.object({
      username: z.string().min(1).max(64),
      password: z.string().min(1).max(128),
    }),
  ),
  async (c) => {
    const { username, password } = c.req.valid('json');
    const result = await loginWithPassword(username, password);
    if (!result) {
      return c.json({ error: 'invalid_credentials', message: '用户名或密码错误' }, 401);
    }
    await ensureEnergyAccount(result.userId);
    return c.json({
      token: result.token,
      userId: result.userId,
      username: result.username,
      subjectType: 'user',
      expiresIn: process.env.JWT_EXPIRES_IN ?? '30d',
    });
  },
);

authRoutes.post(
  '/merge-guest',
  zValidator(
    'json',
    z.object({
      guestToken: z.string().min(10),
    }),
  ),
  async (c) => {
    const guestPayload = await verifyToken(c.req.valid('json').guestToken);
    if (!guestPayload || guestPayload.type !== 'guest') {
      return c.json({ error: 'invalid_guest_token' }, 400);
    }

    const header = c.req.header('Authorization');
    const userToken = header?.startsWith('Bearer ') ? header.slice(7) : null;
    if (!userToken) {
      return c.json({ error: 'unauthorized' }, 401);
    }
    const userPayload = await verifyToken(userToken);
    if (!userPayload || userPayload.type !== 'user') {
      return c.json({ error: 'user_token_required' }, 401);
    }

    await copyBlobsFromGuestToUser(guestPayload.sub, userPayload.sub);
    await ensureEnergyAccount(userPayload.sub);

    return c.json({
      merged: true,
      userId: userPayload.sub,
      guestId: guestPayload.sub,
    });
  },
);
