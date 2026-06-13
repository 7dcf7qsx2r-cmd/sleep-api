import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { requireAuth, type AuthVariables } from '../middleware/auth.js';
import { ensureEnergyAccount } from '../services/energy.js';
import {
  checkIn,
  completeTask,
  claimReward,
  getTaskProgress,
  listTransactions,
  spendEnergy,
} from '../services/energyLedger.js';

export const energyRoutes = new Hono<{ Variables: AuthVariables }>();

energyRoutes.use('*', requireAuth);

function requireUser(c: { get: (key: 'auth') => { sub: string; type: string } }) {
  const auth = c.get('auth');
  if (auth.type !== 'user') return null;
  return auth.sub;
}

energyRoutes.get('/account', async (c) => {
  const userId = requireUser(c);
  if (!userId) return c.json({ error: 'guest_forbidden', message: '登录后查看能量账户' }, 403);
  const account = await ensureEnergyAccount(userId);
  return c.json(account);
});

energyRoutes.get('/transactions', async (c) => {
  const userId = requireUser(c);
  if (!userId) return c.json({ error: 'guest_forbidden' }, 403);
  const limit = Number(c.req.query('limit') ?? 50);
  const txs = await listTransactions(userId, Math.min(limit, 100));
  return c.json({ transactions: txs });
});

energyRoutes.get('/tasks', async (c) => {
  const userId = requireUser(c);
  if (!userId) return c.json({ error: 'guest_forbidden' }, 403);
  const tasks = await getTaskProgress(userId);
  return c.json({ tasks });
});

energyRoutes.post('/tasks/:taskId/complete', async (c) => {
  const userId = requireUser(c);
  if (!userId) return c.json({ error: 'guest_forbidden' }, 403);
  const result = await completeTask(userId, c.req.param('taskId'));
  return c.json(result);
});

energyRoutes.post('/check-in', async (c) => {
  const userId = requireUser(c);
  if (!userId) return c.json({ error: 'guest_forbidden' }, 403);
  const result = await checkIn(userId);
  return c.json(result);
});

energyRoutes.post(
  '/spend',
  zValidator(
    'json',
    z.object({
      amount: z.number().int().positive(),
      description: z.string().max(200),
      sourceId: z.string().max(128),
      reason: z.enum([
        'force_wake',
        'shop',
        'discover_gift',
        'ai_over_quota',
        'other',
      ]).optional(),
    }),
  ),
  async (c) => {
    const userId = requireUser(c);
    if (!userId) return c.json({ error: 'guest_forbidden' }, 403);
    const body = c.req.valid('json');
    const result = await spendEnergy(userId, body.amount, body.description, body.sourceId);
    return c.json(result);
  },
);

energyRoutes.post(
  '/claim',
  zValidator(
    'json',
    z.object({
      claimType: z.string().max(64),
      sourceId: z.string().max(128),
      amount: z.number().int().positive().max(500),
      description: z.string().max(200),
    }),
  ),
  async (c) => {
    const userId = requireUser(c);
    if (!userId) return c.json({ error: 'guest_forbidden' }, 403);
    const body = c.req.valid('json');
    const result = await claimReward(
      userId,
      body.claimType,
      body.sourceId,
      body.amount,
      body.description,
    );
    return c.json(result);
  },
);
