import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { config } from '../config.js';
import {
  getLatestRealtime,
  getSleepReport,
  listKnownDevices,
  listSleepReports,
  normalizeRadarMac,
  upsertRealtime,
  upsertReports,
  type RadarRealtimeInput,
  type RadarReportInput,
} from '../services/radar.js';

export const radarRoutes = new Hono();

async function requireRadarPushAuth(c: Context, next: Next) {
  if (!config.radarPushSecret) {
    await next();
    return;
  }
  const header = c.req.header('Authorization');
  const token = header?.startsWith('Bearer ') ? header.slice(7) : null;
  if (token === config.radarPushSecret) {
    await next();
    return;
  }
  return c.json({ ret: 1, msg: 'unauthorized' }, 401);
}

function mapRealtimeItem(raw: Record<string, unknown>): RadarRealtimeInput | null {
  const mac = typeof raw.mac === 'string' ? raw.mac : '';
  if (!mac) return null;
  return {
    mac,
    radarNumber: typeof raw.radarNumber === 'number' ? raw.radarNumber : undefined,
    heartRate: typeof raw.heartRate === 'number' ? raw.heartRate : undefined,
    respiratoryRate: typeof raw.respiratoryRate === 'number' ? raw.respiratoryRate : undefined,
    isbed: typeof raw.isbed === 'number' ? raw.isbed : undefined,
    signal: typeof raw.signal === 'number' ? raw.signal : undefined,
    alarmType: typeof raw.alarmType === 'number' ? raw.alarmType : undefined,
    online: typeof raw.online === 'number' ? raw.online : undefined,
    timeStamp: typeof raw.timeStamp === 'string' ? raw.timeStamp : undefined,
    raw,
  };
}

function mapReportItem(raw: Record<string, unknown>): RadarReportInput | null {
  const mac = typeof raw.mac === 'string' ? raw.mac : '';
  const sleep_id = typeof raw.sleep_id === 'string' ? raw.sleep_id : '';
  if (!mac || !sleep_id) return null;
  return {
    sleep_id,
    mac,
    inbed_time: typeof raw.inbed_time === 'number' ? raw.inbed_time : undefined,
    outbed_time: typeof raw.outbed_time === 'number' ? raw.outbed_time : undefined,
    deep_sleeptime: typeof raw.deep_sleeptime === 'number' ? raw.deep_sleeptime : undefined,
    light_sleeptime: typeof raw.light_sleeptime === 'number' ? raw.light_sleeptime : undefined,
    rem_time: typeof raw.rem_time === 'number' ? raw.rem_time : undefined,
    wake_time: typeof raw.wake_time === 'number' ? raw.wake_time : undefined,
    sleep_score: typeof raw.sleep_score === 'number' ? raw.sleep_score : undefined,
    sdate: typeof raw.sdate === 'string' ? raw.sdate : undefined,
    edate: typeof raw.edate === 'string' ? raw.edate : undefined,
    assess_result: raw.assess_result,
    datelist: raw.datelist,
    heartlist: raw.heartlist,
    resplist: raw.resplist,
    raw,
  };
}

/** 厂商推送实时数据 */
radarRoutes.post('/datapost', requireRadarPushAuth, async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!Array.isArray(body)) {
    return c.json({ ret: 1, msg: 'payload must be array' }, 400);
  }

  const items = body
    .filter((x): x is Record<string, unknown> => x && typeof x === 'object')
    .map(mapRealtimeItem)
    .filter((x): x is RadarRealtimeInput => x !== null);

  const stored = await upsertRealtime(items);
  console.log(`[radar] datapost stored=${stored}`);
  return c.json({ ret: 0, msg: 'ok', stored });
});

/** 厂商推送睡眠报告 */
radarRoutes.post('/reportpost', requireRadarPushAuth, async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!Array.isArray(body)) {
    return c.json({ ret: 1, msg: 'payload must be array' }, 400);
  }

  const items = body
    .filter((x): x is Record<string, unknown> => x && typeof x === 'object')
    .map(mapReportItem)
    .filter((x): x is RadarReportInput => x !== null);

  const stored = await upsertReports(items);
  console.log(`[radar] reportpost stored=${stored}`);
  return c.json({ ret: 0, msg: 'ok', stored });
});

/** App 查询最新实时数据 */
radarRoutes.get('/latest', async (c) => {
  const mac = c.req.query('mac');
  if (!mac) return c.json({ error: 'mac required' }, 400);

  const data = await getLatestRealtime(normalizeRadarMac(mac));
  if (!data) return c.json({ error: 'no data' }, 404);
  return c.json(data);
});

/** App 查询多日睡眠报告（趋势） */
radarRoutes.get('/reports', async (c) => {
  const mac = c.req.query('mac');
  const daysRaw = c.req.query('days') ?? '7';
  if (!mac) return c.json({ error: 'mac required' }, 400);

  const days = Number.parseInt(daysRaw, 10);
  const reports = await listSleepReports(normalizeRadarMac(mac), Number.isFinite(days) ? days : 7);
  return c.json({ reports });
});

/** App 查询睡眠报告 */
radarRoutes.get('/report', async (c) => {
  const mac = c.req.query('mac');
  const date = c.req.query('date');
  if (!mac) return c.json({ error: 'mac required' }, 400);

  const report = await getSleepReport(normalizeRadarMac(mac), date || undefined);
  if (!report) return c.json({ error: 'no report' }, 404);
  return c.json(report);
});

/** App 扫描：列出后端已收到数据的雷达 MAC */
radarRoutes.get('/my-devices', async (c) => {
  const devices = await listKnownDevices();
  return c.json(devices);
});
