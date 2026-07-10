import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { requireAuth, type AuthVariables } from '../middleware/auth.js';
import {
  listProducts,
  listUserOrders,
  purchaseSandboxRmb,
  purchaseWithEnergy,
} from '../services/shop.js';

export const shopRoutes = new Hono<{ Variables: AuthVariables }>();

shopRoutes.get('/products', async (c) => c.json({ products: await listProducts() }));

shopRoutes.use('*', requireAuth);

shopRoutes.get('/orders', async (c) => {
  const auth = c.get('auth');
  if (auth.type !== 'user') return c.json({ error: 'guest_forbidden' }, 403);
  const orders = await listUserOrders(auth.sub);
  return c.json({ orders });
});

shopRoutes.post(
  '/purchase',
  zValidator(
    'json',
    z.object({
      productId: z.string().max(32),
      quantity: z.number().int().positive().max(99).optional(),
      paymentMethod: z.enum(['energy', 'sandbox_wechat']),
    }),
  ),
  async (c) => {
    const auth = c.get('auth');
    if (auth.type !== 'user') return c.json({ error: 'guest_forbidden' }, 403);
    const { productId, paymentMethod, quantity } = c.req.valid('json');

    if (paymentMethod === 'energy') {
      const result = await purchaseWithEnergy(auth.sub, productId, quantity ?? 1);
      if (!result.success) {
        return c.json(result, result.error === 'insufficient_balance' ? 400 : 404);
      }
      return c.json(result);
    }

    const result = await purchaseSandboxRmb(auth.sub, productId);
    if (!result.success) return c.json(result, 404);
    return c.json(result);
  },
);
