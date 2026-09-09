/**
 * 一次性核对脚本（只读，不写库）：
 * 从生产 iot_messages 拉取指定设备某夜的原始报文，用「新算法」重新聚合 30s epoch 并推算，
 * 与 iot_sleep_sessions 里已存的「旧结果」对比打印。
 *
 * 用法：
 *   bash scripts/prod-db-tunnel.sh   # 另开终端保持隧道
 *   npx tsx scripts/recompute-night-check.ts 14639369D06C 2026-09-09
 */
import 'dotenv/config';
import { query, closeDb } from '../src/db/client.js';
import {
  aggregateTickGroups,
  calibrationFor,
  extractReport,
  extractTick,
  epochStartMs,
  type PillowTick,
  type SleepReportOverlay,
  type SleepProductKey,
} from '../src/services/iotSleepEpochMath.js';
import { estimatePillowSleep } from '../src/services/iotSleepEstimate.js';

const sn = (process.argv[2] ?? '14639369D06C').toUpperCase();
const nightDate = process.argv[3] ?? '2026-09-09';

// 上海 12:00 切分 → nightDate 的 UTC 窗口 [前一日 04:00Z, 当日 04:00Z)
const dayMs = Date.parse(`${nightDate}T00:00:00Z`);
const fromIso = new Date(dayMs - 20 * 3600_000).toISOString(); // 前一日 04:00Z
const toIso = new Date(dayMs + 4 * 3600_000).toISOString(); // 当日 04:00Z

function hm(min: number): string {
  const m = Math.max(0, Math.round(min));
  const h = Math.floor(m / 60);
  return h ? `${h}h${String(m % 60).padStart(2, '0')}m` : `${m}m`;
}
function clock(iso: string | null): string {
  if (!iso) return '--';
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  // 上海时间
  const s = new Date(d.getTime() + 8 * 3600_000);
  return `${pad(s.getUTCHours())}:${pad(s.getUTCMinutes())}`;
}

async function main() {
  const dev = await query<{ product_key: string }>(
    `SELECT product_key FROM iot_devices WHERE sn = $1`,
    [sn],
  );
  const pk = (dev.rows[0]?.product_key ?? 'cis_ip') as SleepProductKey;
  const cal = calibrationFor(pk);

  const { rows } = await query<{
    topic: string;
    raw_json: unknown;
    received_at: Date | string;
  }>(
    `SELECT topic, raw_json, received_at
       FROM iot_messages
      WHERE sn = $1 AND product_key = $2
        AND received_at >= $3::timestamptz AND received_at < $4::timestamptz
      ORDER BY received_at ASC, id ASC`,
    [sn, pk, fromIso, toIso],
  );

  const ticks: PillowTick[] = [];
  const reports: SleepReportOverlay[] = [];
  for (const r of rows) {
    const atMs = r.received_at instanceof Date ? r.received_at.getTime() : new Date(r.received_at).getTime();
    const t = extractTick(pk, r.topic, r.raw_json, atMs);
    if (t) ticks.push(t);
    const rep = extractReport(pk, r.raw_json, atMs);
    if (rep) reports.push(rep);
  }

  const epochs = aggregateTickGroups(ticks, reports, cal).filter((e) => e.nightDate === nightDate);
  const est = estimatePillowSleep(epochs, nightDate, pk);

  const inBed = epochs.filter((e) => e.quality === 'ok' && e.inBedRatio >= 0.8);
  const firstMs = ticks.length ? epochStartMs(ticks[0]!.atMs) : 0;
  const lastMs = ticks.length ? epochStartMs(ticks[ticks.length - 1]!.atMs) : 0;

  const old = await query<{
    duration_minutes: number; deep_minutes: number; light_minutes: number;
    awake_minutes: number; awakenings: number; sleep_start: string | null;
    sleep_end: string | null; confidence: string;
  }>(
    `SELECT duration_minutes, deep_minutes, light_minutes, awake_minutes, awakenings,
            sleep_start, sleep_end, confidence
       FROM iot_sleep_sessions WHERE sn = $1 AND night_date = $2::date`,
    [sn, nightDate],
  );
  const o = old.rows[0];

  console.log(`\n设备 ${sn} · ${pk} · 民用夜 ${nightDate}`);
  console.log(`原始报文 ${rows.length} 条 · 提取 tick ${ticks.length} · report ${reports.length}`);
  console.log(`聚合 epoch ${epochs.length}（在枕 ${inBed.length}）· 覆盖 ${clock(new Date(firstMs).toISOString())}–${clock(new Date(lastMs).toISOString())}`);
  console.log(`体动标定：baseline ${cal.baselinePa}Pa / scale ${cal.scalePa}Pa / movingFloor ${cal.movingFloor}`);
  console.log('\n指标            旧(已存)        新(本次算法)');
  const row = (k: string, oldV: string, newV: string) => console.log(k.padEnd(14), oldV.padEnd(14), newV);
  row('睡眠时长', o ? hm(o.duration_minutes) : '—', hm(est.durationMinutes));
  row('深睡', o ? hm(o.deep_minutes) : '—', hm(est.deepMinutes));
  row('浅睡', o ? hm(o.light_minutes) : '—', hm(est.lightMinutes));
  row('清醒', o ? hm(o.awake_minutes) : '—', hm(est.awakeMinutes));
  row('夜醒次数', o ? `${o.awakenings}` : '—', `${est.awakenings}`);
  row('入睡', o ? clock(o.sleep_start) : '—', clock(est.sleepStart));
  row('起床', o ? clock(o.sleep_end) : '—', clock(est.sleepEnd));
  row('置信', o ? o.confidence : '—', est.confidence);
  row('平均心率', '—', est.avgHeartRate != null ? `${Math.round(est.avgHeartRate)}` : '—');

  await closeDb();
}

main().catch(async (e) => {
  console.error(e);
  await closeDb().catch(() => {});
  process.exit(1);
});
