import { query } from '../db/client.js';

export function normalizeRadarMac(mac: string): string {
  return mac.replace(/[^0-9A-Fa-f]/g, '').toUpperCase();
}

export interface RadarRealtimeInput {
  mac: string;
  radarNumber?: number;
  heartRate?: number;
  respiratoryRate?: number;
  isbed?: number;
  signal?: number;
  alarmType?: number;
  online?: number;
  timeStamp?: string;
  raw?: Record<string, unknown>;
}

export interface RadarReportInput {
  sleep_id: string;
  mac: string;
  inbed_time?: number;
  outbed_time?: number;
  deep_sleeptime?: number;
  light_sleeptime?: number;
  rem_time?: number;
  wake_time?: number;
  sleep_score?: number;
  sdate?: string;
  edate?: string;
  assess_result?: unknown;
  datelist?: unknown;
  heartlist?: unknown;
  resplist?: unknown;
  raw?: Record<string, unknown>;
}

function parseTimestamp(value?: string): Date | null {
  if (!value) return null;
  const d = new Date(value.replace(' ', 'T'));
  return Number.isNaN(d.getTime()) ? null : d;
}

export async function upsertRealtime(items: RadarRealtimeInput[]): Promise<number> {
  let stored = 0;
  for (const item of items) {
    const mac = normalizeRadarMac(item.mac);
    if (!mac) continue;

    await query(
      `INSERT INTO radar_realtime_latest (
        mac, radar_number, heart_rate, respiratory_rate, isbed, signal, alarm_type, online, time_stamp, raw_json, updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW())
      ON CONFLICT (mac) DO UPDATE SET
        radar_number = EXCLUDED.radar_number,
        heart_rate = EXCLUDED.heart_rate,
        respiratory_rate = EXCLUDED.respiratory_rate,
        isbed = EXCLUDED.isbed,
        signal = EXCLUDED.signal,
        alarm_type = EXCLUDED.alarm_type,
        online = EXCLUDED.online,
        time_stamp = EXCLUDED.time_stamp,
        raw_json = EXCLUDED.raw_json,
        updated_at = NOW()`,
      [
        mac,
        item.radarNumber ?? null,
        item.heartRate ?? null,
        item.respiratoryRate ?? null,
        item.isbed ?? null,
        item.signal ?? null,
        item.alarmType ?? null,
        item.online ?? null,
        parseTimestamp(item.timeStamp),
        JSON.stringify(item.raw ?? {}),
      ],
    );
    stored++;
  }
  return stored;
}

export async function upsertReports(items: RadarReportInput[]): Promise<number> {
  let stored = 0;
  for (const item of items) {
    const mac = normalizeRadarMac(item.mac);
    if (!mac || !item.sleep_id) continue;

    await query(
      `INSERT INTO radar_sleep_reports (
        sleep_id, mac, inbed_time, outbed_time, deep_sleeptime, light_sleeptime, rem_time, wake_time,
        sleep_score, sdate, edate, assess_json, heartlist_json, resplist_json, datelist_json, raw_json
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
      ON CONFLICT (sleep_id) DO UPDATE SET
        mac = EXCLUDED.mac,
        inbed_time = EXCLUDED.inbed_time,
        outbed_time = EXCLUDED.outbed_time,
        deep_sleeptime = EXCLUDED.deep_sleeptime,
        light_sleeptime = EXCLUDED.light_sleeptime,
        rem_time = EXCLUDED.rem_time,
        wake_time = EXCLUDED.wake_time,
        sleep_score = EXCLUDED.sleep_score,
        sdate = EXCLUDED.sdate,
        edate = EXCLUDED.edate,
        assess_json = EXCLUDED.assess_json,
        heartlist_json = EXCLUDED.heartlist_json,
        resplist_json = EXCLUDED.resplist_json,
        datelist_json = EXCLUDED.datelist_json,
        raw_json = EXCLUDED.raw_json`,
      [
        item.sleep_id,
        mac,
        item.inbed_time ?? null,
        item.outbed_time ?? null,
        item.deep_sleeptime ?? null,
        item.light_sleeptime ?? null,
        item.rem_time ?? null,
        item.wake_time ?? null,
        item.sleep_score ?? null,
        parseTimestamp(item.sdate),
        parseTimestamp(item.edate),
        JSON.stringify(item.assess_result ?? null),
        JSON.stringify(item.heartlist ?? null),
        JSON.stringify(item.resplist ?? null),
        JSON.stringify(item.datelist ?? null),
        JSON.stringify(item.raw ?? {}),
      ],
    );
    stored++;
  }
  return stored;
}

export async function getLatestRealtime(mac: string) {
  const norm = normalizeRadarMac(mac);
  const { rows } = await query<{
    mac: string;
    radar_number: number | null;
    heart_rate: number | null;
    respiratory_rate: number | null;
    isbed: number | null;
    signal: number | null;
    alarm_type: number | null;
    online: number | null;
    time_stamp: Date | null;
    updated_at: Date;
  }>(
    `SELECT mac, radar_number, heart_rate, respiratory_rate, isbed, signal, alarm_type, online, time_stamp, updated_at
     FROM radar_realtime_latest WHERE mac = $1`,
    [norm],
  );
  const row = rows[0];
  if (!row) return null;

  return {
    mac: row.mac,
    radarNumber: row.radar_number ?? undefined,
    heartRate: row.heart_rate ?? undefined,
    respiratoryRate: row.respiratory_rate ?? undefined,
    isbed: row.isbed ?? undefined,
    signal: row.signal ?? undefined,
    alarmType: row.alarm_type ?? undefined,
    online: row.online ?? undefined,
    timeStamp: row.time_stamp?.toISOString() ?? row.updated_at.toISOString(),
  };
}

export async function getSleepReport(mac: string, date?: string) {
  const norm = normalizeRadarMac(mac);
  let sql = `SELECT sleep_id, mac, inbed_time, outbed_time, deep_sleeptime, light_sleeptime, rem_time, wake_time,
                    sleep_score, sdate, edate, assess_json, heartlist_json, resplist_json, datelist_json, created_at
             FROM radar_sleep_reports WHERE mac = $1`;
  const params: unknown[] = [norm];

  if (date) {
    sql += ` AND (sdate::date = $2::date OR edate::date = $2::date OR created_at::date = $2::date)`;
    params.push(date);
    sql += ` ORDER BY created_at DESC LIMIT 1`;
  } else {
    sql += ` ORDER BY created_at DESC LIMIT 1`;
  }

  const { rows } = await query<{
    sleep_id: string;
    mac: string;
    inbed_time: number | null;
    outbed_time: number | null;
    deep_sleeptime: number | null;
    light_sleeptime: number | null;
    rem_time: number | null;
    wake_time: number | null;
    sleep_score: number | null;
    sdate: Date | null;
    edate: Date | null;
    assess_json: unknown;
    heartlist_json: unknown;
    resplist_json: unknown;
    datelist_json: unknown;
  }>(sql, params);

  const row = rows[0];
  if (!row) return null;

  return {
    sleep_id: row.sleep_id,
    mac: row.mac,
    inbed_time: row.inbed_time ?? 0,
    outbed_time: row.outbed_time ?? 0,
    deep_sleeptime: row.deep_sleeptime ?? 0,
    light_sleeptime: row.light_sleeptime ?? 0,
    rem_time: row.rem_time ?? 0,
    wake_time: row.wake_time ?? 0,
    sleep_score: row.sleep_score ?? 0,
    sdate: row.sdate?.toISOString(),
    edate: row.edate?.toISOString(),
    assess_result: row.assess_json ?? undefined,
    heartlist: row.heartlist_json ?? undefined,
    resplist: row.resplist_json ?? undefined,
    datelist: row.datelist_json ?? undefined,
  };
}

export async function listSleepReports(mac: string, days = 7) {
  const norm = normalizeRadarMac(mac);
  const clampedDays = Math.min(Math.max(Math.floor(days), 1), 90);

  const { rows } = await query<{
    sleep_id: string;
    mac: string;
    inbed_time: number | null;
    deep_sleeptime: number | null;
    light_sleeptime: number | null;
    rem_time: number | null;
    wake_time: number | null;
    sleep_score: number | null;
    sdate: Date | null;
    edate: Date | null;
    assess_json: unknown;
    heartlist_json: unknown;
    resplist_json: unknown;
    datelist_json: unknown;
  }>(
    `SELECT sleep_id, mac, inbed_time, deep_sleeptime, light_sleeptime, rem_time, wake_time,
            sleep_score, sdate, edate, assess_json, heartlist_json, resplist_json, datelist_json
     FROM radar_sleep_reports
     WHERE mac = $1
       AND COALESCE(sdate, created_at) >= NOW() - ($2::text || ' days')::interval
     ORDER BY COALESCE(sdate, created_at) ASC`,
    [norm, String(clampedDays)],
  );

  return rows.map((row) => ({
    sleep_id: row.sleep_id,
    mac: row.mac,
    inbed_time: row.inbed_time ?? 0,
    deep_sleeptime: row.deep_sleeptime ?? 0,
    light_sleeptime: row.light_sleeptime ?? 0,
    rem_time: row.rem_time ?? 0,
    wake_time: row.wake_time ?? 0,
    sleep_score: row.sleep_score ?? 0,
    sdate: row.sdate?.toISOString(),
    edate: row.edate?.toISOString(),
    assess_result: row.assess_json ?? undefined,
    heartlist: row.heartlist_json ?? undefined,
    resplist: row.resplist_json ?? undefined,
    datelist: row.datelist_json ?? undefined,
  }));
}

export async function listKnownDevices(): Promise<Array<{ mac: string; alias?: string; online?: boolean }>> {
  const { rows } = await query<{ mac: string; online: number | null; updated_at: Date }>(
    `SELECT mac, online, updated_at FROM radar_realtime_latest ORDER BY updated_at DESC`,
  );
  return rows.map((r) => ({
    mac: r.mac,
    alias: `生物雷达 ${r.mac.slice(-4)}`,
    online: r.online !== 0,
  }));
}
