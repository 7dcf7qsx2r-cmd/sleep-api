import { Hono, type Context } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { requireAuth, type AuthVariables } from '../middleware/auth.js';
import { addCivilDays, shanghaiToday, sleepDisplayNightDate } from '../utils/civilDate.js';
import {
  CbtiError,
  applyPlanAction,
  getCurrentPlan,
  joinPlan,
  listDiary,
  listNightEvents,
  listNightSummaries,
  listSettlements,
  recordNightEvents,
  runDueSettlement,
  submitQuestionnaire,
  upsertDiary,
  withdrawConsent,
} from '../services/cbti/plans.js';
import { getNightPrefill, getNightStatus } from '../services/cbti/nightMonitor.js';

type Env = { Variables: AuthVariables };

export const cbtiRoutes = new Hono<Env>();

cbtiRoutes.use('*', requireAuth);

function userId(c: Context<Env>): string | null {
  const auth = c.get('auth');
  return auth.type === 'user' ? auth.sub : null;
}

async function handle<T>(c: Context<Env>, fn: (uid: string) => Promise<T>) {
  const uid = userId(c);
  if (!uid) return c.json({ error: 'guest_not_allowed' }, 403);
  try {
    return c.json(await fn(uid) as object);
  } catch (err) {
    if (err instanceof CbtiError) return c.json({ error: err.code }, err.status);
    throw err;
  }
}

const hm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const minutes = z.number().int().min(0).max(720);

const deviceSchema = z.object({
  kind: z.enum(['radar', 'cis_ib', 'cis_iswb', 'cis_ip', 'wearable']),
  id: z.string().min(1).max(64),
  side: z.enum(['left', 'right', 'center']).optional(),
  sharedBed: z.boolean().optional(),
  radarNumber: z.number().int().min(0).max(8).optional(),
  flipLatencyMs: z.number().int().min(0).max(120_000).optional(),
});

const safetyItem = z.enum(['bipolar_epilepsy', 'pregnant', 'apnea', 'shift_or_hazard', 'low_mood', 'self_harm']);

cbtiRoutes.get('/plans/current', (c) => handle(c, (uid) => getCurrentPlan(uid)));

cbtiRoutes.post(
  '/plans',
  zValidator('json', z.object({
    intake: z.object({
      frequency: z.enum(['lt1', '1_2', 'gte3']),
      duration: z.enum(['lt1m', '1_3m', 'gte3m']),
      isAdult: z.boolean(),
      safety: z.record(safetyItem, z.boolean()),
    }),
    consent: z.object({
      version: z.string().max(64),
      items: z.array(z.object({ key: z.string().max(32), checkedAt: z.string().max(40) })).max(10),
      archiveOptIn: z.boolean(),
      deviceInfo: z.record(z.string(), z.unknown()).default({}),
    }),
    wakeAnchor: hm,
    devices: z.array(deviceSchema).max(6).default([]),
  })),
  (c) => handle(c, (uid) => joinPlan(uid, c.req.valid('json'))),
);

const planAction = z.discriminatedUnion('action', [
  z.object({ action: z.literal('pause') }),
  z.object({ action: z.literal('resume') }),
  z.object({ action: z.literal('switch_gentle'), reason: z.string().max(48).optional() }),
  z.object({ action: z.literal('request_full') }),
  z.object({ action: z.literal('set_wake_anchor'), wakeAnchor: hm }),
  z.object({ action: z.literal('exit'), reason: z.string().min(1).max(64) }),
  z.object({ action: z.literal('safety_pause'), reason: z.string().min(1).max(48) }),
  z.object({ action: z.literal('safety_resume') }),
  z.object({ action: z.literal('restart_baseline') }),
  z.object({ action: z.literal('relapse_restart') }),
  z.object({ action: z.literal('update_devices'), devices: z.array(deviceSchema).max(6) }),
  z.object({ action: z.literal('update_night_prefs'), soundAllowed: z.boolean().optional(), promptsOff: z.boolean().optional() }),
]);

cbtiRoutes.patch(
  '/plans/current',
  zValidator('json', planAction),
  (c) => handle(c, async (uid) => ({ plan: await applyPlanAction(uid, c.req.valid('json')) })),
);

cbtiRoutes.post('/consent/withdraw', (c) => handle(c, async (uid) => {
  await withdrawConsent(uid);
  return { ok: true };
}));

cbtiRoutes.put(
  '/diary/:nightDate',
  zValidator('param', z.object({ nightDate: isoDate })),
  zValidator('json', z.object({
    bedTime: hm.nullable(),
    wakeTime: hm.nullable(),
    preLightsMin: minutes.nullable().optional(),
    solMin: minutes.nullable(),
    wasoMin: minutes.nullable(),
    emaMin: minutes.nullable(),
    leaveCount: z.number().int().min(0).max(20).nullable().optional(),
    inputMode: z.record(z.string().max(24), z.string().max(24)).optional(),
    napMin: minutes.nullable().optional(),
    caffeine: z.boolean().nullable().optional(),
    alcohol: z.boolean().nullable().optional(),
    sleepiness: z.number().int().min(0).max(4).nullable().optional(),
    special: z.enum(['sick', 'travel', 'alcohol', 'childcare', 'other']).nullable().optional(),
    deviceTier: z.string().max(24).nullable().optional(),
    deviceEstimates: z.record(z.string(), z.unknown()).nullable().optional(),
    clientUpdatedAt: z.string().datetime({ offset: true }),
  })),
  (c) => handle(c, (uid) => upsertDiary(uid, c.req.valid('param').nightDate, c.req.valid('json'))),
);

cbtiRoutes.get('/diary', (c) => handle(c, async (uid) => ({ entries: await listDiary(uid) })));

cbtiRoutes.post(
  '/night-events',
  zValidator('json', z.object({
    events: z.array(z.object({
      eventId: z.string().min(8).max(96),
      nightDate: isoDate,
      kind: z.enum(['leave_bed', 'return_bed', 'prompt_feedback', 'night_chat', 'app_foreground']),
      occurredAt: z.string().datetime({ offset: true }),
      source: z.enum(['button', 'app']),
      payload: z.record(z.string(), z.unknown()).optional(),
    })).min(1).max(50),
  })),
  (c) => handle(c, async (uid) => {
    const { events } = c.req.valid('json');
    const today = shanghaiToday();
    const bad = events.find((e) => e.nightDate > addCivilDays(today, 1) || e.nightDate < addCivilDays(today, -3));
    if (bad) throw new CbtiError('night_date_out_of_range', 422);
    return { inserted: await recordNightEvents(uid, events) };
  }),
);

cbtiRoutes.get(
  '/night-events',
  zValidator('query', z.object({ nightDate: isoDate })),
  (c) => handle(c, async (uid) => ({ events: await listNightEvents(uid, c.req.valid('query').nightDate) })),
);

cbtiRoutes.post(
  '/settlements',
  zValidator('json', z.object({
    client: z.object({
      planDay: z.number().int().min(0).max(200),
      reason: z.string().max(32),
      newTibMin: z.number().int().min(0).max(720).nullable(),
    }).nullable().optional(),
  })),
  (c) => handle(c, (uid) => runDueSettlement(uid, c.req.valid('json').client ?? null)),
);

cbtiRoutes.get('/settlements', (c) => handle(c, async (uid) => ({ settlements: await listSettlements(uid) })));

cbtiRoutes.post(
  '/questionnaires',
  zValidator('json', z.object({
    kind: z.enum(['isi', 'ess']),
    phase: z.enum(['baseline', 'final']),
    answers: z.array(z.number().int().min(0).max(4)).min(7).max(8),
  })),
  (c) => handle(c, (uid) => submitQuestionnaire(uid, c.req.valid('json'))),
);

cbtiRoutes.get('/night/status', (c) => handle(c, async (uid) => ({ status: await getNightStatus(uid) })));

cbtiRoutes.get(
  '/night/prefill',
  zValidator('query', z.object({ nightDate: isoDate.optional() })),
  (c) => handle(c, async (uid) => ({
    prefill: await getNightPrefill(uid, c.req.valid('query').nightDate ?? sleepDisplayNightDate()),
  })),
);

cbtiRoutes.get(
  '/night/summaries',
  zValidator('query', z.object({ from: isoDate })),
  (c) => handle(c, async (uid) => ({ summaries: await listNightSummaries(uid, c.req.valid('query').from) })),
);
