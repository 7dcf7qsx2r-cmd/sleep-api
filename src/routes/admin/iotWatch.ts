import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { requireAdminAuth, type AdminVariables } from '../../middleware/adminAuth.js';
import { listWatchDevices, listWatchMessages, searchWatchBindings } from '../../services/iotWatch.js';
import { getWatchSleepEpochs, getWatchSleepSummary } from '../../services/iotSleepEpochs.js';
import { IotBindError } from '../../services/iot.js';
import { sleepNightDate } from '../../utils/civilDate.js';
import { IOT_WATCH_HTML } from './iotWatchPage.js';

export const adminIotWatchRoutes = new Hono<{ Variables: AdminVariables }>();

adminIotWatchRoutes.get('/', (c) => c.html(IOT_WATCH_HTML));

adminIotWatchRoutes.get('/devices', requireAdminAuth, async (c) => {
  c.header('Cache-Control', 'no-store');
  const devices = await listWatchDevices();
  return c.json({ devices });
});

adminIotWatchRoutes.get(
  '/search',
  requireAdminAuth,
  zValidator(
    'query',
    z.object({
      q: z.string().max(80).optional(),
    }),
  ),
  async (c) => {
    c.header('Cache-Control', 'no-store');
    const q = c.req.valid('query').q ?? '';
    const items = await searchWatchBindings(q);
    return c.json({ items, q });
  },
);

adminIotWatchRoutes.get(
  '/messages',
  requireAdminAuth,
  zValidator(
    'query',
    z.object({
      sn: z.string().min(3).max(64),
      afterId: z.string().regex(/^\d+$/).optional(),
      limit: z.coerce.number().int().min(1).max(200).optional(),
    }),
  ),
  async (c) => {
    const { sn, afterId, limit } = c.req.valid('query');
    c.header('Cache-Control', 'no-store');
    try {
      const messages = await listWatchMessages({ sn, afterId, limit });
      return c.json({ messages });
    } catch (err) {
      const code = err instanceof Error ? err.message : '';
      if (code === 'invalid_sn' || code === 'invalid_after_id') {
        return c.json({ error: code, message: '参数无效' }, 400);
      }
      throw err;
    }
  },
);

adminIotWatchRoutes.get(
  '/sleep-epochs',
  requireAdminAuth,
  zValidator(
    'query',
    z.object({
      sn: z.string().min(3).max(64),
      nightDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    }),
  ),
  async (c) => {
    const { sn, nightDate } = c.req.valid('query');
    c.header('Cache-Control', 'no-store');
    try {
      const date = nightDate || sleepNightDate();
      const epochs = await getWatchSleepEpochs(sn, date);
      return c.json({ sn: sn.toUpperCase(), nightDate: date, epochs });
    } catch (err) {
      if (err instanceof IotBindError) {
        return c.json({ error: err.code, message: err.message }, 400);
      }
      throw err;
    }
  },
);

adminIotWatchRoutes.get(
  '/sleep-summary',
  requireAdminAuth,
  zValidator(
    'query',
    z.object({
      sn: z.string().min(3).max(64),
      nightDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    }),
  ),
  async (c) => {
    const { sn, nightDate } = c.req.valid('query');
    c.header('Cache-Control', 'no-store');
    try {
      const date = nightDate || sleepNightDate();
      const summary = await getWatchSleepSummary(sn, date);
      return c.json({ summary });
    } catch (err) {
      if (err instanceof IotBindError) {
        return c.json({ error: err.code, message: err.message }, 400);
      }
      throw err;
    }
  },
);
