import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { requireAuth, type AuthVariables } from '../middleware/auth.js';
import { ownerFromAuth } from '../lib/owner.js';
import {
  applyMorningCheckIn,
  buildRollingWeekTimeline,
  loadSleepNights,
  getLastNight,
  hasMorningCheckInToday,
} from '../services/sleepNights.js';
import { completeTask } from '../services/energyLedger.js';

export const reportRoutes = new Hono<{ Variables: AuthVariables }>();

reportRoutes.use('*', requireAuth);

function requireUserId(c: { get: (key: 'auth') => { sub: string; type: string } }) {
  const auth = c.get('auth');
  if (auth.type !== 'user') return null;
  return auth.sub;
}

reportRoutes.get('/weekly', async (c) => {
  const owner = ownerFromAuth(c.get('auth'));
  const { nights } = await loadSleepNights(owner);
  const timeline = buildRollingWeekTimeline(nights);
  const dataNightCount = timeline.filter((d) => d.hasData).length;
  const chapter = dataNightCount;

  let mode: 'seed' | 'building' | 'gapped' | 'full' = 'seed';
  if (dataNightCount >= 7) mode = 'full';
  else if (dataNightCount >= 3) mode = 'building';
  else if (dataNightCount >= 1) mode = 'gapped';

  const progressLabel = chapter === 0
    ? '序章 · 等待第一格'
    : `已归档 ${chapter}/7 晚`;

  const progressHint = chapter === 0
    ? '30 秒晨间打卡，点亮睡眠故事第一格'
    : chapter < 7
      ? `再记 ${7 - chapter} 晚，解锁周肖像`
      : '本周连载已满，小眠正在整理周肖像';

  return c.json({
    mode,
    timeline,
    dataNightCount: chapter,
    progressLabel,
    progressHint,
    checkedInToday: hasMorningCheckInToday(nights),
    lastNight: getLastNight(nights),
  });
});

reportRoutes.post(
  '/morning-checkin',
  zValidator(
    'json',
    z.object({
      subjectiveMood: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
      bedtimeBucket: z.enum(['before_23', '23_01', 'after_01']).optional(),
      morningTags: z.array(z.string().max(32)).max(8).optional(),
    }),
  ),
  async (c) => {
    const userId = requireUserId(c);
    if (!userId) return c.json({ error: 'guest_forbidden', message: '登录后打卡' }, 403);

    const owner = ownerFromAuth(c.get('auth'));
    const body = c.req.valid('json');
    const { night, version } = await applyMorningCheckIn(owner, body);

    let taskResult = null;
    try {
      taskResult = await completeTask(userId, 'morning_report_checkin');
    } catch {
      /* task may already be done */
    }

    return c.json({ night, sleepNightsVersion: version, task: taskResult });
  },
);
