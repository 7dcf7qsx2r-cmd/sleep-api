/**
 * 智能枕睡眠推算离线回放：读取导出的 iot_messages（JSON 数组 [id, topic, receivedAtMs, params]），
 * 按线上同一套 epoch 聚合 + 整夜推算重算，打印每晚的摘要与逐分钟睡眠图，用于阈值标定与戒指对照。
 *
 * 用法：npx tsx scripts/pillow-sleep-replay.ts /tmp/pillow-nights.json [--stats]
 */
import { readFileSync } from 'node:fs';
import {
  EPOCH_MS,
  MOTION_CALIBRATION,
  aggregatePillowEpoch,
  epochStartMs,
  extractReport,
  extractTick,
  smoothedMotionPa,
  windowTicksFor,
  type PillowTick,
  type SleepEpoch,
  type SleepReportOverlay,
} from '../src/services/iotSleepEpochMath.js';
import { classifyPillowNight, type EpochStage } from '../src/services/iotSleepEstimate.js';

type Row = [number, string, number, Record<string, unknown>];

const file = process.argv[2] ?? '/tmp/pillow-nights.json';
const wantStats = process.argv.includes('--stats');
const rows = JSON.parse(readFileSync(file, 'utf8')) as Row[];

const ticks: PillowTick[] = [];
const reports: SleepReportOverlay[] = [];
for (const [, topic, atMs, params] of rows) {
  const raw = { params };
  const t = extractTick('cis_ip', topic, raw, atMs);
  if (t) ticks.push(t);
  const r = extractReport('cis_ip', raw, atMs);
  if (r) reports.push(r);
}
ticks.sort((a, b) => a.atMs - b.atMs);

const groups = new Map<number, PillowTick[]>();
for (const t of ticks) {
  const s = epochStartMs(t.atMs);
  const list = groups.get(s);
  if (list) list.push(t);
  else groups.set(s, [t]);
}

const epochs: SleepEpoch[] = [];
const tvByStart = new Map<number, number | null>();
for (const start of [...groups.keys()].sort((a, b) => a - b)) {
  const win = windowTicksFor(ticks, start);
  epochs.push(aggregatePillowEpoch(start, groups.get(start)!, reports, MOTION_CALIBRATION.cis_ip, win));
  if (wantStats) tvByStart.set(start, smoothedMotionPa(win, start));
}

const loc = (ms: number) => new Date(ms + 8 * 3600e3).toISOString().slice(11, 16);
const byNight = new Map<string, SleepEpoch[]>();
for (const e of epochs) {
  const list = byNight.get(e.nightDate);
  if (list) list.push(e);
  else byNight.set(e.nightDate, [e]);
}

function pct(values: number[], p: number): number {
  if (!values.length) return NaN;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))]!;
}

if (wantStats) {
  const fmt = (v: number[]) => [0.1, 0.5, 0.75, 0.9, 0.97].map((p) => pct(v, p).toFixed(1)).join(' / ');
  const inBed = epochs.filter((e) => e.inBedRatio >= 0.8 && !e.actuating);
  const empty = epochs.filter((e) => e.inBedRatio === 0 && !e.actuating && (e.respProm ?? 0) < 20);
  console.log('分位 p10/p50/p75/p90/p97');
  console.log('在枕 TV(Pa)  ', fmt(inBed.map((e) => tvByStart.get(e.epochStartMs) ?? 0)));
  console.log('空枕 TV(Pa)  ', fmt(empty.map((e) => tvByStart.get(e.epochStartMs) ?? 0)));
  console.log('规律呼吸 TV  ', fmt(epochs.filter((e) => (e.respProm ?? 0) >= 50 && !e.actuating).map((e) => tvByStart.get(e.epochStartMs) ?? 0)));
  console.log('在枕 prom    ', fmt(inBed.map((e) => e.respProm ?? 0)));
  console.log('离枕 prom    ', fmt(epochs.filter((e) => e.inBedRatio === 0 && !e.actuating).map((e) => e.respProm ?? 0)));
  console.log('在枕 amp     ', fmt(inBed.map((e) => e.respAmp ?? 0)));
  console.log('空枕 amp     ', fmt(empty.map((e) => e.respAmp ?? 0)));
}

const dumpArg = process.argv.find((a) => a.startsWith('--dump='));
if (dumpArg) {
  // --dump=2026-09-10T06:00/07:00（本地时间）
  const [a, b] = dumpArg.slice(7).split('/');
  const day = a!.slice(0, 10);
  const fromMs = Date.parse(`${a}:00+08:00`);
  const toMs = Date.parse(`${day}T${b}:00+08:00`);
  const list = epochs.filter((e) => e.epochStartMs >= fromMs - 6 * 3600e3 && e.epochStartMs < toMs + 6 * 3600e3);
  const { stages } = classifyPillowNight(list, list[0]?.nightDate, 'cis_ip');
  const stageAt = new Map(stages.map((s) => [s.epochStartMs, s.stage]));
  for (const e of list.filter((x) => x.epochStartMs >= fromMs && x.epochStartMs < toMs)) {
    console.log(
      `${new Date(e.epochStartMs + 8 * 3600e3).toISOString().slice(11, 19)} fw=${e.inBedRatio.toFixed(1)} act=${e.actuating} ` +
        `mot=${e.motion.toFixed(3)} p=${e.pMean?.toFixed(0)} rr=${e.respRate?.toFixed(1)} prom=${e.respProm?.toFixed(1)} amp=${e.respAmp?.toFixed(1)} → ${stageAt.get(e.epochStartMs)}`,
    );
  }
  process.exit(0);
}

const SYM: Record<EpochStage, string> = { off: ' ', wake: 'W', light: '-', deep: '█', rem: 'R', unknown: 'A' };

for (const [night, list] of [...byNight.entries()].sort()) {
  const { estimate, stages } = classifyPillowNight(list, night, 'cis_ip');
  const inBedMin = list.filter((e) => e.inBedRatio >= 0.8).length / 2;
  if (inBedMin < 30 && !estimate.durationMinutes) continue;
  console.log(`\n== ${night}  固件在枕 ${inBedMin} 分钟`);
  console.log(
    `入睡 ${estimate.sleepStart ? loc(Date.parse(estimate.sleepStart)) : '--'}  起床 ${estimate.sleepEnd ? loc(Date.parse(estimate.sleepEnd)) : '--'}  ` +
      `睡眠 ${estimate.durationMinutes}m  深 ${estimate.deepMinutes}  浅 ${estimate.lightMinutes}  REM ${estimate.remMinutes}  ` +
      `醒 ${estimate.awakeMinutes}m/${estimate.awakenings}次  呼吸 ${estimate.avgBreathRate?.toFixed(1) ?? '--'}  置信 ${estimate.confidence}`,
  );
  if (wantStats) {
    const asleep = new Set(stages.filter((s) => ['light', 'deep', 'rem'].includes(s.stage)).map((s) => s.epochStartMs));
    const proms = list.filter((e) => asleep.has(e.epochStartMs)).map((e) => e.respProm ?? 0);
    const amps = list.filter((e) => asleep.has(e.epochStartMs)).map((e) => e.respAmp ?? 0);
    const idx = list.map((e, i) => (asleep.has(e.epochStartMs) ? i : -1)).filter((i) => i >= 0);
    const rsd = idx.map((i) => {
      const r = list.slice(Math.max(0, i - 4), i + 5).map((e) => e.respRate ?? 0);
      const m = r.reduce((a, b) => a + b, 0) / r.length;
      return Math.sqrt(r.reduce((a, b) => a + (b - m) ** 2, 0) / r.length);
    });
    console.log(`  睡眠中 呼吸率波动(±4epoch std) p25/p50/p75/p90: ${[0.25, 0.5, 0.75, 0.9].map((p) => pct(rsd, p).toFixed(2)).join('/')}`);
    console.log(`  睡眠中 prom p25/p50/p75/p90: ${[0.25, 0.5, 0.75, 0.9].map((p) => pct(proms, p).toFixed(0)).join('/')}  amp p25/p50/p75: ${[0.25, 0.5, 0.75].map((p) => pct(amps, p).toFixed(1)).join('/')}`);
  }
  const first = stages.findIndex((s) => s.stage !== 'off');
  let last = -1;
  for (let i = stages.length - 1; i >= 0; i -= 1) if (stages[i]!.stage !== 'off') { last = i; break; }
  if (first < 0) continue;
  // 每字符 = 1 分钟（2 个 epoch，取更「醒」的那个）
  const rank: EpochStage[] = ['off', 'wake', 'unknown', 'rem', 'light', 'deep'];
  let line = '';
  let lineStart = stages[first]!.epochStartMs;
  for (let i = first; i <= last; i += 2) {
    const a = stages[i]!.stage;
    const b = stages[i + 1]?.stage ?? a;
    line += SYM[rank.indexOf(a) <= rank.indexOf(b) ? a : b];
    if (line.length === 60) {
      console.log(`${loc(lineStart)} ${line}`);
      line = '';
      lineStart = stages[i + 2]?.epochStartMs ?? lineStart;
    }
  }
  if (line) console.log(`${loc(lineStart)} ${line}`);
}
console.log(`\n图例：█深睡 -浅睡 R REM  W清醒  A气囊动作  空白离枕；每字符 1 分钟；epoch ${EPOCH_MS / 1000}s`);
