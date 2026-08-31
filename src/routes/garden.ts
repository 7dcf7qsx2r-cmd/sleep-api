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
  listGardenHelpToday,
  listGardenPeers,
  smashGardenPest,
  upsertUserGarden,
} from '../services/garden.js';
import { query } from '../db/client.js';

export const gardenRoutes = new Hono<{ Variables: AuthVariables }>();

gardenRoutes.use('*', requireAuth);

const plantSchema = z.record(z.string(), z.unknown());

const pestSchema = z.object({
  id: z.string().min(1).max(96),
  plotIndex: z.number().int().min(0).max(6),
  slot: z.number().int().min(0).max(5),
  monsterId: z.string().min(1).max(64),
  spawnedDay: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

const upsertSchema = z.object({
  plants: z.array(plantSchema).max(7),
  overflowDew: z.number().int().min(0).max(3),
  overflowDewDay: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  pests: z.array(pestSchema).max(6).optional(),
  pestSpawnDay: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  nourishKind: z.enum(['harvest_rich', 'harvest_care', 'holding', 'hurt']).nullable().optional(),
  pestsReplace: z.boolean().optional(),
});

const smashSchema = z.object({
  pestId: z.string().min(1).max(96),
});

function requireUser(c: { get: (k: 'auth') => { type: string; sub: string } }) {
  const auth = c.get('auth');
  if (auth.type !== 'user') return null;
  return auth.sub;
}

function claimErrorStatus(code: GardenClaimError['code']): 403 | 404 | 409 {
  if (code === 'daily_capped' || code === 'no_overflow' || code === 'no_pest') return 409;
  if (code === 'not_visitable' || code === 'cannot_visit_self') return 403;
  return 404;
}

gardenRoutes.put('/', zValidator('json', upsertSchema), async (c) => {
  const userId = requireUser(c);
  if (!userId) return c.json({ error: 'guest_not_allowed' }, 403);
  const body = c.req.valid('json');
  const garden = await upsertUserGarden(userId, {
    plants: body.plants,
    overflowDew: body.overflowDew,
    overflowDewDay: body.overflowDewDay ?? null,
    pests: body.pests,
    pestSpawnDay: body.pestSpawnDay ?? null,
    nourishKind: body.nourishKind ?? null,
    pestsReplace: body.pestsReplace,
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

gardenRoutes.post('/me/smash', zValidator('json', smashSchema), async (c) => {
  const userId = requireUser(c);
  if (!userId) return c.json({ error: 'guest_not_allowed' }, 403);
  try {
    const result = await smashGardenPest(userId, userId, c.req.valid('json').pestId);
    return c.json({ ok: true, ...result });
  } catch (err) {
    if (err instanceof GardenClaimError) {
      return c.json({ ok: false, error: err.code }, claimErrorStatus(err.code));
    }
    throw err;
  }
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

gardenRoutes.get('/help/today', async (c) => {
  const userId = requireUser(c);
  if (!userId) return c.json({ error: 'guest_not_allowed' }, 403);
  const helpers = await listGardenHelpToday(userId);
  const visits = await getVisitProgress(userId);
  return c.json({ helpers, visits, day: visits.day });
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
      pestLeft: garden.pestLeft,
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
      return c.json({ ok: false, error: err.code }, claimErrorStatus(err.code));
    }
    throw err;
  }
});

gardenRoutes.post('/:userId/smash', zValidator('json', smashSchema), async (c) => {
  const visitorId = requireUser(c);
  if (!visitorId) return c.json({ error: 'guest_not_allowed' }, 403);
  const ownerId = c.req.param('userId');
  try {
    const result = await smashGardenPest(visitorId, ownerId, c.req.valid('json').pestId);
    return c.json({ ok: true, ...result });
  } catch (err) {
    if (err instanceof GardenClaimError) {
      return c.json({ ok: false, error: err.code }, claimErrorStatus(err.code));
    }
    throw err;
  }
});
