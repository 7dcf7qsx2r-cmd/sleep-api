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
