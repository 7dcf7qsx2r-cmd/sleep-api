import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { requireAuth, type AuthVariables } from '../middleware/auth.js';
import {
  DEFAULT_IOT_PRODUCT_KEY,
  IotBindError,
  bindIotDevice,
  getOwnedIotLatest,
  listBoundIotDevices,
  listOwnedIotMessages,
  unbindIotDevice,
} from '../services/iot.js';

export const iotRoutes = new Hono<{ Variables: AuthVariables }>();

iotRoutes.use('*', requireAuth);

function requireUser(c: { get: (key: 'auth') => { sub: string; type: string } }): string | null {
  const auth = c.get('auth');
  if (auth.type !== 'user') return null;
  return auth.sub;
}

const snParam = z.string().min(3).max(64);

function bindErrorStatus(err: IotBindError): 400 | 404 | 409 {
  if (err.code === 'already_bound') return 409;
  if (err.code === 'not_found' || err.code === 'not_bound') return 404;
  return 400;
}

iotRoutes.post(
  '/devices/bind',
  zValidator(
    'json',
    z.object({
      sn: snParam,
      productKey: z.string().min(1).max(64).optional(),
      alias: z.string().max(40).optional(),
      model: z.string().min(2).max(32).optional(),
    }),
  ),
  async (c) => {
    const userId = requireUser(c);
    if (!userId) return c.json({ error: 'guest_not_allowed', message: '请先登录后再绑定设备' }, 403);
    const body = c.req.valid('json');
    try {
      const device = await bindIotDevice({
        userId,
        sn: body.sn,
        productKey: body.productKey,
        alias: body.alias,
        model: body.model,
      });
      return c.json({ device });
    } catch (err) {
      if (err instanceof IotBindError) {
        return c.json({ error: err.code, message: err.message }, bindErrorStatus(err));
      }
      throw err;
    }
  },
);

iotRoutes.get('/devices', async (c) => {
  const userId = requireUser(c);
  if (!userId) return c.json({ error: 'guest_not_allowed', message: '请先登录' }, 403);
  const devices = await listBoundIotDevices(userId);
  return c.json({ devices });
});

iotRoutes.get('/devices/:sn/latest', async (c) => {
  const userId = requireUser(c);
  if (!userId) return c.json({ error: 'guest_not_allowed', message: '请先登录' }, 403);
  const sn = c.req.param('sn');
  const productKey = c.req.query('productKey') || DEFAULT_IOT_PRODUCT_KEY;
  try {
    const latest = await getOwnedIotLatest(userId, sn, productKey);
    if (!latest) return c.json({ error: 'no_data', message: '暂无上报数据' }, 404);
    return c.json(latest);
  } catch (err) {
    if (err instanceof IotBindError) {
      return c.json({ error: err.code, message: err.message }, bindErrorStatus(err));
    }
    throw err;
  }
});

iotRoutes.get('/devices/:sn/messages', async (c) => {
  const userId = requireUser(c);
  if (!userId) return c.json({ error: 'guest_not_allowed', message: '请先登录' }, 403);
  const sn = c.req.param('sn');
  const productKey = c.req.query('productKey') || DEFAULT_IOT_PRODUCT_KEY;
  const daysRaw = c.req.query('limit') ?? '50';
  const limit = Number.parseInt(daysRaw, 10);
  try {
    const messages = await listOwnedIotMessages(
      userId,
      sn,
      productKey,
      Number.isFinite(limit) ? limit : 50,
    );
    return c.json({ messages });
  } catch (err) {
    if (err instanceof IotBindError) {
      return c.json({ error: err.code, message: err.message }, bindErrorStatus(err));
    }
    throw err;
  }
});

iotRoutes.delete('/devices/:sn', async (c) => {
  const userId = requireUser(c);
  if (!userId) return c.json({ error: 'guest_not_allowed', message: '请先登录' }, 403);
  const sn = c.req.param('sn');
  const productKey = c.req.query('productKey') || DEFAULT_IOT_PRODUCT_KEY;
  try {
    await unbindIotDevice(userId, sn, productKey);
    return c.json({ ok: true });
  } catch (err) {
    if (err instanceof IotBindError) {
      return c.json({ error: err.code, message: err.message }, bindErrorStatus(err));
    }
    throw err;
  }
});
