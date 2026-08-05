import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { requireAuth, type AuthVariables } from '../middleware/auth.js';
import {
  GardenClaimError,
  canVisitGarden,
  claimGardenOverflowDew,
  getUserGarden,
  getVisitProgress,
  listGardenPeers,
  upsertUserGarden,
} from '../services/garden.js';
import { query } from '../db/client.js';

export const gardenRoutes = new Hono<{ Variables: AuthVariables }>();

gardenRoutes.use('*', requireAuth);

const plantSchema = z.record(z.string(), z.unknown());

const upsertSchema = z.object({
  plants: z.array(plantSchema).max(7),
  overflowDew: z.number().int().min(0).max(3),
  overflowDewDay: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
});

function requireUser(c: { get: (k: 'auth') => { type: string; sub: string } }) {
  const auth = c.get('auth');
  if (auth.type !== 'user') return null;
  return auth.sub;
}

gardenRoutes.put('/', zValidator('json', upsertSchema), async (c) => {
  const userId = requireUser(c);
  if (!userId) return c.json({ error: 'guest_not_allowed' }, 403);
  const body = c.req.valid('json');
  const garden = await upsertUserGarden(userId, {
    plants: body.plants,
    overflowDew: body.overflowDew,
    overflowDewDay: body.overflowDewDay ?? null,
  });
  return c.json({ garden });
});

gardenRoutes.get('/me', async (c) => {
  const userId = requireUser(c);
  if (!userId) return c.json({ error: 'guest_not_allowed' }, 403);
  const garden = await getUserGarden(userId);
  const visits = await getVisitProgress(userId);
  return c.json({ garden, visits });
});

gardenRoutes.get('/peers', async (c) => {
  const userId = requireUser(c);
  if (!userId) return c.json({ error: 'guest_not_allowed' }, 403);
  const peers = await listGardenPeers(userId);
  const visits = await getVisitProgress(userId);
  return c.json({ peers, visits });
});

gardenRoutes.get('/visits/today', async (c) => {
  const userId = requireUser(c);
  if (!userId) return c.json({ error: 'guest_not_allowed' }, 403);
  const visits = await getVisitProgress(userId);
  return c.json({ visits });
});

gardenRoutes.get('/:userId', async (c) => {
  const visitorId = requireUser(c);
  if (!visitorId) return c.json({ error: 'guest_not_allowed' }, 403);
  const ownerId = c.req.param('userId');

  if (ownerId !== visitorId) {
    if (!(await canVisitGarden(visitorId, ownerId))) {
      return c.json({ error: 'not_visitable' }, 403);
    }
  }

  const garden = await getUserGarden(ownerId);
  if (!garden) return c.json({ error: 'garden_missing' }, 404);

  const profile = await query<{
    username: string | null;
    nickname: string | null;
    avatar_url: string | null;
  }>(
    `SELECT u.username, up.nickname, up.avatar_url
     FROM users u
     LEFT JOIN user_profiles up ON up.user_id = u.id
     WHERE u.id = $1`,
    [ownerId],
  );
  const row = profile.rows[0];
  return c.json({
    garden,
    peer: {
      id: ownerId,
      username: row?.username ?? null,
      nickname: row?.nickname ?? null,
      avatarUrl: row?.avatar_url ?? null,
      overflowLeft: garden.overflowDew,
      plantCount: garden.plotCount,
      updatedAt: garden.updatedAt,
    },
  });
});

gardenRoutes.post('/:userId/claim-dew', async (c) => {
  const visitorId = requireUser(c);
  if (!visitorId) return c.json({ error: 'guest_not_allowed' }, 403);
  const ownerId = c.req.param('userId');
  try {
    const result = await claimGardenOverflowDew(visitorId, ownerId);
    return c.json({ ok: true, ...result });
  } catch (err) {
    if (err instanceof GardenClaimError) {
      const status =
        err.code === 'daily_capped' || err.code === 'no_overflow'
          ? 409
          : err.code === 'not_visitable' || err.code === 'cannot_visit_self'
            ? 403
            : 404;
      return c.json({ ok: false, error: err.code }, status);
    }
    throw err;
  }
});
