import { query } from '../db/client.js';
import { IotBindError, isValidIotSn, normalizeIotSn } from './iot.js';
import {
  EPOCH_MS,
  IOT_SLEEP_TTL_DAYS,
  PILLOW_PRODUCT_KEY,
  aggregatePillowEpoch,
  epochIsClosed,
  epochStartMs,
  extractPillowTick,
  extractSleepReport,
  type SleepEpoch,
  type SleepReportOverlay,
  type PillowTick,
} from './iotSleepEpochMath.js';
import { estimatePillowSleep, type PillowSleepEstimate } from './iotSleepEstimate.js';
import { toDateOnly } from '../utils/civilDate.js';

const CATCHUP_BATCH = 5_000;
const CATCHUP_MAX_BATCHES = 8;
const LOOKBACK_MS = 60_000;
const TTL_INTERVAL = `${IOT_SLEEP_TTL_DAYS} days`;

let catchUpRunning = false;

export interface SleepEpochRow extends SleepEpoch {
  sn: string;
  productKey: string;
}

export interface PillowSleepSession extends PillowSleepEstimate {
  sn: string;
  productKey: string;
  computedAt: string;
}

function receivedAtMs(value: Date | string): number {
  return value instanceof Date ? value.getTime() : new Date(value).getTime();
}

function messageId(value: string | number | bigint): number {
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'number') return value;
  return Number.parseInt(value, 10);
}

async function assertOwned(userId: string, sn: string): Promise<void> {
  const { rows } = await query<{ user_id: string }>(
    `SELECT user_id FROM iot_device_bindings WHERE sn = $1`,
    [sn],
  );
  if (!rows[0] || rows[0].user_id !== userId) {
    throw new IotBindError('not_found', '未绑定该设备');
  }
}

function mapEpochRow(row: {
  sn: string;
  epoch_start: Date | string;
  product_key: string;
  night_date: Date | string;
  sample_count: number;
  in_bed_ratio: number;
  hr_mean: number | null;
  hr_min: number | null;
  hr_std: number | null;
  br_mean: number | null;
  br_std: number | null;
  p_mean: number | null;
  motion: number;
  snore_count: number | null;
  snore_db_max: number | null;
  moving_flag: number;
  quality: string;
}): SleepEpochRow {
  const epochStartMs = receivedAtMs(row.epoch_start);
  return {
    sn: row.sn,
    productKey: row.product_key,
    epochStartMs,
    nightDate: toDateOnly(row.night_date) ?? '',
    sampleCount: Number(row.sample_count),
    inBedRatio: Number(row.in_bed_ratio),
    hrMean: row.hr_mean == null ? null : Number(row.hr_mean),
    hrMin: row.hr_min == null ? null : Number(row.hr_min),
    hrStd: row.hr_std == null ? null : Number(row.hr_std),
    brMean: row.br_mean == null ? null : Number(row.br_mean),
    brStd: row.br_std == null ? null : Number(row.br_std),
    pMean: row.p_mean == null ? null : Number(row.p_mean),
    motion: Number(row.motion),
    snoreCount: row.snore_count == null ? null : Number(row.snore_count),
    snoreDbMax: row.snore_db_max == null ? null : Number(row.snore_db_max),
    movingFlag: Number(row.moving_flag) ? 1 : 0,
    quality: row.quality === 'low' ? 'low' : 'ok',
  };
}

async function listPillowSns(): Promise<string[]> {
  const { rows } = await query<{ sn: string }>(
    `SELECT sn FROM iot_devices WHERE product_key = $1
     UNION
     SELECT sn FROM iot_sleep_epoch_cursor`,
    [PILLOW_PRODUCT_KEY],
  );
  return [...new Set(rows.map((r) => r.sn))];
}

async function cursorFor(sn: string): Promise<number> {
  const { rows } = await query<{ last_message_id: string | number | bigint }>(
    `SELECT last_message_id FROM iot_sleep_epoch_cursor WHERE sn = $1`,
    [sn],
  );
  if (!rows[0]) return 0;
  const id = messageId(rows[0].last_message_id);
  return Number.isFinite(id) ? id : 0;
}

async function saveCursor(sn: string, lastMessageId: number): Promise<void> {
  await query(
    `INSERT INTO iot_sleep_epoch_cursor (sn, last_message_id, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (sn) DO UPDATE SET
       last_message_id = EXCLUDED.last_message_id,
       updated_at = NOW()`,
    [sn, lastMessageId],
  );
}

async function loadWindowMessages(
  sn: string,
  fromMs: number,
  toMs: number,
): Promise<Array<{
  id: string | number | bigint;
  topic: string;
  raw_json: unknown;
  received_at: Date | string;
}>> {
  const { rows } = await query<{
    id: string | number | bigint;
    topic: string;
    raw_json: unknown;
    received_at: Date | string;
  }>(
    `SELECT id, topic, raw_json, received_at
     FROM iot_messages
     WHERE sn = $1
       AND product_key = $2
       AND received_at >= $3::timestamptz
       AND received_at < $4::timestamptz
     ORDER BY received_at ASC, id ASC`,
    [sn, PILLOW_PRODUCT_KEY, new Date(fromMs).toISOString(), new Date(toMs).toISOString()],
  );
  return rows;
}

async function upsertEpoch(sn: string, epoch: SleepEpoch): Promise<void> {
  await query(
    `INSERT INTO iot_sleep_epochs (
       sn, epoch_start, product_key, night_date, sample_count, in_bed_ratio,
       hr_mean, hr_min, hr_std, br_mean, br_std, p_mean, motion,
       snore_count, snore_db_max, moving_flag, quality
     ) VALUES (
       $1, $2::timestamptz, $3, $4::date, $5, $6,
       $7, $8, $9, $10, $11, $12, $13,
       $14, $15, $16, $17
     )
     ON CONFLICT (sn, epoch_start) DO UPDATE SET
       sample_count = EXCLUDED.sample_count,
       in_bed_ratio = EXCLUDED.in_bed_ratio,
       hr_mean = EXCLUDED.hr_mean,
       hr_min = EXCLUDED.hr_min,
       hr_std = EXCLUDED.hr_std,
       br_mean = EXCLUDED.br_mean,
       br_std = EXCLUDED.br_std,
       p_mean = EXCLUDED.p_mean,
       motion = EXCLUDED.motion,
       snore_count = EXCLUDED.snore_count,
       snore_db_max = EXCLUDED.snore_db_max,
       moving_flag = EXCLUDED.moving_flag,
       quality = EXCLUDED.quality`,
    [
      sn,
      new Date(epoch.epochStartMs).toISOString(),
      PILLOW_PRODUCT_KEY,
      epoch.nightDate,
      epoch.sampleCount,
      epoch.inBedRatio,
      epoch.hrMean,
      epoch.hrMin,
      epoch.hrStd,
      epoch.brMean,
      epoch.brStd,
      epoch.pMean,
      epoch.motion,
      epoch.snoreCount,
      epoch.snoreDbMax,
      epoch.movingFlag,
      epoch.quality,
    ],
  );
}

async function upsertSession(sn: string, estimate: PillowSleepEstimate): Promise<void> {
  await query(
    `INSERT INTO iot_sleep_sessions (
       sn, night_date, product_key, sleep_start, sleep_end,
       duration_minutes, deep_minutes, light_minutes, rem_minutes, awake_minutes,
       awakenings, avg_heart_rate, avg_breath_rate, confidence, source, computed_at
     ) VALUES (
       $1, $2::date, $3, $4::timestamptz, $5::timestamptz,
       $6, $7, $8, $9, $10,
       $11, $12, $13, $14, $15, NOW()
     )
     ON CONFLICT (sn, night_date) DO UPDATE SET
       sleep_start = EXCLUDED.sleep_start,
       sleep_end = EXCLUDED.sleep_end,
       duration_minutes = EXCLUDED.duration_minutes,
       deep_minutes = EXCLUDED.deep_minutes,
       light_minutes = EXCLUDED.light_minutes,
       rem_minutes = EXCLUDED.rem_minutes,
       awake_minutes = EXCLUDED.awake_minutes,
       awakenings = EXCLUDED.awakenings,
       avg_heart_rate = EXCLUDED.avg_heart_rate,
       avg_breath_rate = EXCLUDED.avg_breath_rate,
       confidence = EXCLUDED.confidence,
       source = EXCLUDED.source,
       computed_at = NOW()`,
    [
      sn,
      estimate.nightDate,
      PILLOW_PRODUCT_KEY,
      estimate.sleepStart,
      estimate.sleepEnd,
      estimate.durationMinutes,
      estimate.deepMinutes,
      estimate.lightMinutes,
      estimate.remMinutes,
      estimate.awakeMinutes,
      estimate.awakenings,
      estimate.avgHeartRate,
      estimate.avgBreathRate,
      estimate.confidence,
      estimate.source,
    ],
  );
}

export async function recomputePillowNight(sn: string, nightDate: string): Promise<PillowSleepEstimate> {
  const epochs = await listSleepEpochs(sn, nightDate);
  const estimate = estimatePillowSleep(epochs, nightDate);
  await upsertSession(sn, estimate);
  return estimate;
}

export async function purgeExpiredSleepEpochs(): Promise<void> {
  await query(
    `DELETE FROM iot_sleep_epochs
     WHERE epoch_start < NOW() - INTERVAL '${TTL_INTERVAL}'`,
  );
  await query(
    `DELETE FROM iot_sleep_sessions
     WHERE night_date < ((CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Shanghai')::date - $1::int)`,
    [IOT_SLEEP_TTL_DAYS],
  );
}

export async function catchUpPillowSleepEpochs(sn: string, nowMs = Date.now()): Promise<{
  epochs: number;
  advancedTo: number | null;
}> {
  const id = normalizeIotSn(sn);
  let wrote = 0;
  let advancedTo: number | null = null;
  for (let batch = 0; batch < CATCHUP_MAX_BATCHES; batch += 1) {
    const cursor = await cursorFor(id);
    const { rows } = await query<{
      id: string | number | bigint;
      topic: string;
      raw_json: unknown;
      received_at: Date | string;
    }>(
      `SELECT id, topic, raw_json, received_at
       FROM iot_messages
       WHERE sn = $1
         AND product_key = $2
         AND id > $3
         AND received_at > NOW() - INTERVAL '${TTL_INTERVAL}'
       ORDER BY id ASC
       LIMIT $4`,
      [id, PILLOW_PRODUCT_KEY, cursor, CATCHUP_BATCH],
    );
    if (!rows.length) break;

    const closedEpochs = new Set<number>();
    let lastClosedId: number | null = null;
    for (const row of rows) {
      const atMs = receivedAtMs(row.received_at);
      const start = epochStartMs(atMs);
      if (!epochIsClosed(start, nowMs)) continue;
      closedEpochs.add(start);
      lastClosedId = messageId(row.id);
    }
    if (lastClosedId == null) break;

    const minStart = Math.min(...closedEpochs);
    const maxEnd = Math.max(...closedEpochs) + EPOCH_MS;
    const window = await loadWindowMessages(id, minStart - LOOKBACK_MS, maxEnd);
    const ticksByEpoch = new Map<number, PillowTick[]>();
    const reports: SleepReportOverlay[] = [];
    for (const row of window) {
      const atMs = receivedAtMs(row.received_at);
      const tick = extractPillowTick(row.topic, row.raw_json, atMs);
      if (tick) {
        const start = epochStartMs(tick.atMs);
        const list = ticksByEpoch.get(start);
        if (list) list.push(tick);
        else ticksByEpoch.set(start, [tick]);
      }
      const report = extractSleepReport(row.raw_json, atMs);
      if (report) reports.push(report);
    }

    const nightDates = new Set<string>();
    for (const start of closedEpochs) {
      const ticks = ticksByEpoch.get(start) ?? [];
      if (!ticks.length) continue;
      const epoch = aggregatePillowEpoch(start, ticks, reports);
      await upsertEpoch(id, epoch);
      nightDates.add(epoch.nightDate);
      wrote += 1;
    }
    await saveCursor(id, lastClosedId);
    advancedTo = lastClosedId;
    for (const nightDate of nightDates) {
      await recomputePillowNight(id, nightDate);
    }
    if (rows.length < CATCHUP_BATCH) break;
  }
  return { epochs: wrote, advancedTo };
}

export async function catchUpIotSleepEpochs(): Promise<{ sns: number; epochs: number }> {
  if (catchUpRunning) return { sns: 0, epochs: 0 };
  catchUpRunning = true;
  try {
    const sns = await listPillowSns();
    let epochs = 0;
    for (const sn of sns) {
      const result = await catchUpPillowSleepEpochs(sn);
      epochs += result.epochs;
    }
    await purgeExpiredSleepEpochs();
    return { sns: sns.length, epochs };
  } finally {
    catchUpRunning = false;
  }
}

export function startIotSleepEpochLoop(): void {
  const tick = () => {
    void catchUpIotSleepEpochs().catch((err) => {
      console.error('[iot-sleep-epoch]', err);
    });
  };
  setTimeout(() => {
    tick();
    setInterval(tick, EPOCH_MS);
  }, 5_000);
}

export async function listSleepEpochs(sn: string, nightDate: string): Promise<SleepEpochRow[]> {
  const { rows } = await query<{
    sn: string;
    epoch_start: Date | string;
    product_key: string;
    night_date: Date | string;
    sample_count: number;
    in_bed_ratio: number;
    hr_mean: number | null;
    hr_min: number | null;
    hr_std: number | null;
    br_mean: number | null;
    br_std: number | null;
    p_mean: number | null;
    motion: number;
    snore_count: number | null;
    snore_db_max: number | null;
    moving_flag: number;
    quality: string;
  }>(
    `SELECT sn, epoch_start, product_key, night_date, sample_count, in_bed_ratio,
            hr_mean, hr_min, hr_std, br_mean, br_std, p_mean, motion,
            snore_count, snore_db_max, moving_flag, quality
     FROM iot_sleep_epochs
     WHERE sn = $1 AND night_date = $2::date
     ORDER BY epoch_start ASC
     LIMIT 4000`,
    [sn, nightDate],
  );
  return rows.map(mapEpochRow);
}

export async function getSleepSession(sn: string, nightDate: string): Promise<PillowSleepSession | null> {
  const { rows } = await query<{
    sn: string;
    night_date: Date | string;
    product_key: string;
    sleep_start: Date | string | null;
    sleep_end: Date | string | null;
    duration_minutes: number;
    deep_minutes: number;
    light_minutes: number;
    rem_minutes: number;
    awake_minutes: number;
    awakenings: number;
    avg_heart_rate: number | null;
    avg_breath_rate: number | null;
    confidence: string;
    source: string;
    computed_at: Date | string;
  }>(
    `SELECT sn, night_date, product_key, sleep_start, sleep_end,
            duration_minutes, deep_minutes, light_minutes, rem_minutes, awake_minutes,
            awakenings, avg_heart_rate, avg_breath_rate, confidence, source, computed_at
     FROM iot_sleep_sessions
     WHERE sn = $1 AND night_date = $2::date`,
    [sn, nightDate],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    sn: row.sn,
    productKey: row.product_key,
    nightDate: toDateOnly(row.night_date) ?? nightDate,
    sleepStart: row.sleep_start ? new Date(row.sleep_start).toISOString() : null,
    sleepEnd: row.sleep_end ? new Date(row.sleep_end).toISOString() : null,
    durationMinutes: Number(row.duration_minutes),
    deepMinutes: Number(row.deep_minutes),
    lightMinutes: Number(row.light_minutes),
    remMinutes: Number(row.rem_minutes),
    awakeMinutes: Number(row.awake_minutes),
    awakenings: Number(row.awakenings),
    avgHeartRate: row.avg_heart_rate == null ? null : Number(row.avg_heart_rate),
    avgBreathRate: row.avg_breath_rate == null ? null : Number(row.avg_breath_rate),
    confidence: row.confidence === 'medium' || row.confidence === 'high' ? row.confidence : 'low',
    source: 'cis_ip',
    computedAt: new Date(row.computed_at).toISOString(),
  };
}

export function serializeSleepEpoch(row: SleepEpochRow) {
  return {
    sn: row.sn,
    productKey: row.productKey,
    epochStart: new Date(row.epochStartMs).toISOString(),
    nightDate: row.nightDate,
    sampleCount: row.sampleCount,
    inBedRatio: round4(row.inBedRatio),
    hrMean: round1(row.hrMean),
    hrMin: round1(row.hrMin),
    hrStd: round2(row.hrStd),
    brMean: round1(row.brMean),
    brStd: round2(row.brStd),
    pMean: round1(row.pMean),
    motion: round4(row.motion),
    snoreCount: row.snoreCount,
    snoreDbMax: round1(row.snoreDbMax),
    movingFlag: row.movingFlag,
    quality: row.quality,
  };
}

export function serializeSleepSession(session: PillowSleepSession) {
  return {
    sn: session.sn,
    productKey: session.productKey,
    nightDate: session.nightDate,
    sleepStart: session.sleepStart,
    sleepEnd: session.sleepEnd,
    durationMinutes: session.durationMinutes,
    deepMinutes: session.deepMinutes,
    lightMinutes: session.lightMinutes,
    remMinutes: session.remMinutes,
    awakeMinutes: session.awakeMinutes,
    awakenings: session.awakenings,
    avgHeartRate: round1(session.avgHeartRate),
    avgBreathRate: round1(session.avgBreathRate),
    confidence: session.confidence,
    source: session.source,
    computedAt: session.computedAt,
  };
}

function round1(value: number | null): number | null {
  return value == null ? null : Math.round(value * 10) / 10;
}

function round2(value: number | null): number | null {
  return value == null ? null : Math.round(value * 100) / 100;
}

function round4(value: number | null): number | null {
  return value == null ? null : Math.round(value * 10_000) / 10_000;
}

function requireSn(sn: string): string {
  const id = normalizeIotSn(sn);
  if (!isValidIotSn(id)) throw new IotBindError('invalid_sn', '设备 SN 无效');
  return id;
}

export async function getOwnedSleepEpochs(
  userId: string,
  sn: string,
  nightDate: string,
): Promise<ReturnType<typeof serializeSleepEpoch>[]> {
  const id = requireSn(sn);
  await assertOwned(userId, id);
  const rows = await listSleepEpochs(id, nightDate);
  return rows.map(serializeSleepEpoch);
}

export async function getOwnedSleepSummary(
  userId: string,
  sn: string,
  nightDate: string,
): Promise<ReturnType<typeof serializeSleepSession> | null> {
  const id = requireSn(sn);
  await assertOwned(userId, id);
  let session = await getSleepSession(id, nightDate);
  if (!session) {
    const estimate = await recomputePillowNight(id, nightDate);
    session = {
      sn: id,
      productKey: PILLOW_PRODUCT_KEY,
      computedAt: new Date().toISOString(),
      ...estimate,
    };
  }
  return serializeSleepSession(session);
}

export async function getWatchSleepEpochs(sn: string, nightDate: string) {
  const id = requireSn(sn);
  const rows = await listSleepEpochs(id, nightDate);
  return rows.map(serializeSleepEpoch);
}

export async function getWatchSleepSummary(sn: string, nightDate: string) {
  const id = requireSn(sn);
  let session = await getSleepSession(id, nightDate);
  if (!session) {
    const estimate = await recomputePillowNight(id, nightDate);
    session = {
      sn: id,
      productKey: PILLOW_PRODUCT_KEY,
      computedAt: new Date().toISOString(),
      ...estimate,
    };
  }
  return serializeSleepSession(session);
}
