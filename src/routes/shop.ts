import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { requireAuth, type AuthVariables } from '../middleware/auth.js';
import {
  confirmAlipayPayment,
  createAlipayAppPayment,
  getAlipayPayment,
  handleAlipayNotify,
  listProducts,
  listUserOrders,
  purchaseSandboxRmb,
  purchaseWithEnergy,
} from '../services/shop.js';

export const shopRoutes = new Hono<{ Variables: AuthVariables }>();

shopRoutes.get('/products', async (c) => c.json({ products: await listProducts() }));

shopRoutes.post('/alipay/notify', async (c) => {
  const raw = await c.req.parseBody();
  const payload: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === 'string') payload[key] = value;
  }
  const result = await handleAlipayNotify(payload);
  if (!result.ok) {
    console.warn('[alipay] notify rejected', result.error);
    return c.text('fail', 400);
  }
  return c.text('success');
});

shopRoutes.use('*', requireAuth);

shopRoutes.get('/orders', async (c) => {
  const auth = c.get('auth');
  if (auth.type !== 'user') return c.json({ error: 'guest_forbidden' }, 403);
  const orders = await listUserOrders(auth.sub);
  return c.json({ orders });
});

const addressSchema = z.object({
  receiverName: z.string().min(1).max(64),
  phone: z.string().min(1).max(32),
  region: z.string().min(1).max(120),
  detail: z.string().min(1).max(200),
});

shopRoutes.post(
  '/purchase',
  zValidator(
    'json',
    z.object({
      productId: z.string().max(32),
      quantity: z.number().int().positive().max(99).optional(),
      paymentMethod: z.enum(['energy', 'sandbox_wechat']),
      address: addressSchema.optional(),
    }),
  ),
  async (c) => {
    const auth = c.get('auth');
    if (auth.type !== 'user') return c.json({ error: 'guest_forbidden' }, 403);
    const { productId, paymentMethod, quantity, address } = c.req.valid('json');

    if (paymentMethod === 'energy') {
      const result = await purchaseWithEnergy(auth.sub, productId, quantity ?? 1, address);
      if (!result.success) {
        return c.json(result, result.error === 'insufficient_balance' ? 400 : 404);
      }
      return c.json(result);
    }

    const result = await purchaseSandboxRmb(auth.sub, productId, quantity ?? 1, address);
    if (!result.success) return c.json(result, 404);
    return c.json(result);
  },
);

shopRoutes.post(
  '/alipay/create',
  zValidator(
    'json',
    z.object({
      items: z.array(z.object({
        productId: z.string().max(32),
        quantity: z.number().int().positive().max(99).optional(),
      })).min(1).max(20),
      address: addressSchema.optional(),
    }),
  ),
  async (c) => {
    const auth = c.get('auth');
    if (auth.type !== 'user') return c.json({ error: 'guest_forbidden' }, 403);
    const { items, address } = c.req.valid('json');
    const result = await createAlipayAppPayment(auth.sub, items, address);
    if (!result.success) {
      const status = result.error === 'alipay_not_configured' ? 503 : 400;
      return c.json(result, status);
    }
    return c.json(result);
  },
);

shopRoutes.post(
  '/alipay/confirm',
  zValidator('json', z.object({ outTradeNo: z.string().min(8).max(64) })),
  async (c) => {
    const auth = c.get('auth');
    if (auth.type !== 'user') return c.json({ error: 'guest_forbidden' }, 403);
    const { outTradeNo } = c.req.valid('json');
    const result = await confirmAlipayPayment(auth.sub, outTradeNo);
    if (!result.success) {
      return c.json(result, result.error === 'order_not_found' ? 404 : 400);
    }
    return c.json(result);
  },
);

shopRoutes.get('/alipay/payments/:outTradeNo', async (c) => {
  const auth = c.get('auth');
  if (auth.type !== 'user') return c.json({ error: 'guest_forbidden' }, 403);
  const payment = await getAlipayPayment(auth.sub, c.req.param('outTradeNo'));
  if (!payment) return c.json({ error: 'order_not_found' }, 404);
  return c.json(payment);
});
