import { sleepNightDate } from '../utils/civilDate.js';

export const EPOCH_MS = 30_000;
/** @deprecated 保留兼容；按设备类型请用 MOTION_CALIBRATION[kind].scalePa */
export const MOTION_SCALE_PA = 80;
export const QUALITY_MIN_SAMPLES = 20;
export const SNORE_LOOKBACK_MS = 60_000;
export const EPOCH_CLOSE_GRACE_MS = 2_000;
export const IOT_SLEEP_TTL_DAYS = 3;
export const PILLOW_PRODUCT_KEY = 'cis_ip';

/** 全部进入睡眠推算流水线的云端设备物模型 productKey */
export const SLEEP_PRODUCT_KEYS = ['cis_ip', 'cis_ib', 'cis_iswb'] as const;
export type SleepProductKey = (typeof SLEEP_PRODUCT_KEYS)[number];

export function isSleepProductKey(value: unknown): value is SleepProductKey {
  return value === 'cis_ip' || value === 'cis_ib' || value === 'cis_iswb';
}

/**
 * 体动标定：先扣除在设备上的生理信号底噪（baselinePa，呼吸/心搏引起的气压抖动），
 * 再除以「一次明显翻身」对应的气压差分（scalePa）归一化到 0–1。
 * movingFloor 为固件 moving 标志命中时给 motion 的下限；由于枕头 moving 字段
 * 几乎恒为 1（区分度差），cis_ip 关闭该下限，改由气压差分主导。
 */
export interface MotionCalibration {
  scalePa: number;
  baselinePa: number;
  movingFloor: number;
  /**
   * delta：逐秒气压差分均值（含呼吸起伏）；
   * smoothedStep：先 9s 平滑去掉呼吸，再取 epoch 内平滑气压总变差，同时提取气压呼吸特征。
   */
  method?: 'delta' | 'smoothedStep';
}

export const MOTION_CALIBRATION: Record<SleepProductKey, MotionCalibration> = {
  // 枕头：平滑后总变差，规律呼吸静卧 p90≈15Pa、空枕≈3Pa，一次翻身数百 Pa。moving 字段不可信 → 关闭下限。
  cis_ip: { scalePa: 300, baselinePa: 15, movingFloor: 0, method: 'smoothedStep' },
  // 床垫：8 分区气压差分之和，底噪更高、量程更大；moving 由 ibNew 缺失 → 关闭下限。
  cis_ib: { scalePa: 220, baselinePa: 28, movingFloor: 0 },
  // 撑腰床垫：左右两路气压差分，介于枕头与床垫之间；ISWB 报文自带 moving，保留弱下限。
  cis_iswb: { scalePa: 160, baselinePa: 20, movingFloor: 0.35 },
};

export function calibrationFor(productKey: string): MotionCalibration {
  return isSleepProductKey(productKey) ? MOTION_CALIBRATION[productKey] : MOTION_CALIBRATION.cis_ip;
}

export interface PillowTick {
  atMs: number;
  person: number;
  heart: number;
  breathing: number;
  pressureLeft: number | null;
  pressureRight: number | null;
  /** 气囊正在充放气或处于助眠/止鼾等工作模式：此时气压变化来自设备而非人体 */
  actuating?: 0 | 1;
}

export interface SleepReportOverlay {
  atMs: number;
  moving: number;
  snoreCount: number | null;
  snoreDb: number | null;
}

export interface SleepEpoch {
  epochStartMs: number;
  nightDate: string;
  sampleCount: number;
  inBedRatio: number;
  hrMean: number | null;
  hrMin: number | null;
  hrStd: number | null;
  brMean: number | null;
  brStd: number | null;
  pMean: number | null;
  motion: number;
  snoreCount: number | null;
  snoreDbMax: number | null;
  movingFlag: 0 | 1;
  quality: 'ok' | 'low';
  /** 由气压频谱提取的呼吸率（次/分）；窗口内无可辨呼吸峰时为 null */
  respRate?: number | null;
  /** 呼吸峰显著度（峰功率 / 频谱中位功率），越大呼吸越规律 */
  respProm?: number | null;
  /** 去趋势后呼吸通道的 RMS 幅度（Pa），用于区分「呼吸不规律」与「信号丢失」 */
  respAmp?: number | null;
  /** 窗口内气囊在动作（助眠/止鼾/补气） */
  actuating?: 0 | 1;
  pLeft?: number | null;
  pRight?: number | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseJson(raw: unknown): Record<string, unknown> | null {
  if (typeof raw === 'string') {
    try {
      return asRecord(JSON.parse(raw));
    } catch {
      return null;
    }
  }
  return asRecord(raw);
}

export function finiteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

export function epochStartMs(atMs: number): number {
  return Math.floor(atMs / EPOCH_MS) * EPOCH_MS;
}

export function epochIsClosed(epochStart: number, nowMs: number): boolean {
  return epochStart + EPOCH_MS + EPOCH_CLOSE_GRACE_MS <= nowMs;
}

function paramsOf(raw: unknown): Record<string, unknown> | null {
  const root = parseJson(raw);
  if (!root) return null;
  return asRecord(root.params) ?? root;
}

export function isPropertyPostTopic(topic: string): boolean {
  return topic.includes('thing/property/post');
}

export function extractPillowTick(topic: string, raw: unknown, atMs: number): PillowTick | null {
  if (!isPropertyPostTopic(topic)) return null;
  const params = paramsOf(raw);
  const status = asRecord(params?.deviceStatus);
  if (!params || !status) return null;
  const person = finiteNumber(status.person);
  if (person == null) return null;
  const gasbag = (finiteNumber(status.gasbagStatusLeft) ?? 0) || (finiteNumber(status.gasbagStatusRight) ?? 0);
  const workMode = finiteNumber(status.workMode) ?? 0;
  return {
    atMs,
    person,
    heart: finiteNumber(status.heart) ?? 0,
    breathing: finiteNumber(status.breathing) ?? 0,
    pressureLeft: finiteNumber(status.pressureLeft),
    pressureRight: finiteNumber(status.pressureRight),
    actuating: gasbag || workMode ? 1 : 0,
  };
}

function pillowSleepReport(value: unknown): Record<string, unknown> | null {
  const report = asRecord(value);
  if (!report) return null;
  if (report.ISWBSleepReport != null || report.iswbSleepReport != null || report.ibNew != null) {
    return null;
  }
  return report;
}

export function extractSleepReport(raw: unknown, atMs: number): SleepReportOverlay | null {
  const params = paramsOf(raw);
  if (!params) return null;
  const report = pillowSleepReport(params.SleepReportNew ?? params.sleepReportNew);
  if (!report) return null;
  const snore = finiteNumber(report.snoreStatus);
  const db = finiteNumber(report.db);
  const moving = finiteNumber(report.moving) ?? 0;
  return {
    atMs,
    moving,
    snoreCount: snore,
    snoreDb: db,
  };
}

// ── 多设备通用提取（cis_ib 床垫 / cis_iswb 撑腰床垫）─────────────────────────

function numAt(value: unknown, index: number): number | null {
  return Array.isArray(value) ? finiteNumber(value[index]) : null;
}

/** 取占用侧的生理值均值（>0 才计入）；无人则返回 0 */
function occupiedMean(values: Array<number | null>): number {
  const usable = values.filter((v): v is number => v != null && v > 0);
  if (!usable.length) return 0;
  return usable.reduce((sum, n) => sum + n, 0) / usable.length;
}

/** 床垫 cis_ib：物模型字段在 params 顶层（HR / airbagsPerson / airbagsPressure）。 */
function extractIbTick(params: Record<string, unknown>, atMs: number): PillowTick | null {
  const hr = params.HR ?? params.hr;
  const person = params.airbagsPerson;
  const bags = params.airbagsPressure;
  if (hr == null && person == null && bags == null) return null;
  const personL = numAt(person, 0);
  const personR = numAt(person, 1);
  const occL = personL === 1;
  const occR = personR === 1;
  const inBed = occL || occR ? 1 : 0;
  const heart = occupiedMean([occL ? numAt(hr, 0) : null, occR ? numAt(hr, 3) : null]);
  const breathing = occupiedMean([occL ? numAt(hr, 1) : null, occR ? numAt(hr, 4) : null]);
  // 8 分区气压 → 左右两半各求和，得到两路可差分的“体压”
  let left: number | null = null;
  let right: number | null = null;
  if (Array.isArray(bags) && bags.length) {
    const half = Math.max(1, Math.floor(bags.length / 2));
    let l = 0;
    let r = 0;
    let ln = 0;
    let rn = 0;
    bags.forEach((v, i) => {
      const n = finiteNumber(v);
      if (n == null) return;
      if (i < half) { l += n; ln += 1; } else { r += n; rn += 1; }
    });
    left = ln ? l : null;
    right = rn ? r : null;
  }
  return { atMs, person: inBed, heart, breathing, pressureLeft: left, pressureRight: right };
}

/** 撑腰床垫 cis_iswb：heartData / pressureLeft / pressureRight 在 params 顶层，无 person 字段 → 由心率>0 推占用。 */
function extractIswbTick(params: Record<string, unknown>, atMs: number): PillowTick | null {
  const heart = params.heartData;
  if (heart == null && params.pressureLeft == null && params.pressureRight == null) return null;
  const heartL = numAt(heart, 0);
  const heartR = numAt(heart, 3);
  const breathL = numAt(heart, 1);
  const breathR = numAt(heart, 4);
  const occL = heartL != null && heartL > 0;
  const occR = heartR != null && heartR > 0;
  const inBed = occL || occR ? 1 : 0;
  return {
    atMs,
    person: inBed,
    heart: occupiedMean([occL ? heartL : null, occR ? heartR : null]),
    breathing: occupiedMean([occL ? breathL : null, occR ? breathR : null]),
    pressureLeft: finiteNumber(params.pressureLeft),
    pressureRight: finiteNumber(params.pressureRight),
  };
}

/** 按 productKey 分派的通用 tick 提取。 */
export function extractTick(
  productKey: string,
  topic: string,
  raw: unknown,
  atMs: number,
): PillowTick | null {
  if (!isPropertyPostTopic(topic)) return null;
  if (productKey === 'cis_ib') {
    const params = paramsOf(raw);
    return params ? extractIbTick(params, atMs) : null;
  }
  if (productKey === 'cis_iswb') {
    const params = paramsOf(raw);
    return params ? extractIswbTick(params, atMs) : null;
  }
  return extractPillowTick(topic, raw, atMs);
}

/** 按 productKey 分派的通用睡眠报文提取（moving / 打鼾）。 */
export function extractReport(
  productKey: string,
  raw: unknown,
  atMs: number,
): SleepReportOverlay | null {
  const params = paramsOf(raw);
  if (!params) return null;
  if (productKey === 'cis_ib') {
    const ibNew = (asRecord(params.SleepReportNew)?.ibNew) ?? params.ibNew;
    if (!Array.isArray(ibNew)) return null;
    const snore = (numAt(ibNew, 1) ? 1 : 0) || (numAt(ibNew, 7) ? 1 : 0);
    return { atMs, moving: 0, snoreCount: snore ? 1 : 0, snoreDb: null };
  }
  if (productKey === 'cis_iswb') {
    const arr = (asRecord(params.SleepReportNew)?.ISWBSleepReport)
      ?? params.ISWBSleepReport ?? params.iswbSleepReport;
    if (!Array.isArray(arr)) return null;
    const movingL = numAt(arr, 4) ?? 0;
    const movingR = numAt(arr, 9) ?? 0;
    const snore = (numAt(arr, 1) ? 1 : 0) || (numAt(arr, 6) ? 1 : 0);
    return { atMs, moving: movingL || movingR ? 1 : 0, snoreCount: snore ? 1 : 0, snoreDb: null };
  }
  return extractSleepReport(raw, atMs);
}

function mean(values: number[]): number | null {
  if (!values.length) return null;
  return values.reduce((sum, n) => sum + n, 0) / values.length;
}

function sampleStd(values: number[]): number | null {
  if (values.length < 2) return values.length === 1 ? 0 : null;
  const m = mean(values);
  if (m == null) return null;
  const variance = values.reduce((sum, n) => sum + (n - m) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

function clip01(value: number): number {
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function tickPressureMean(tick: PillowTick): number | null {
  if (tick.pressureLeft != null && tick.pressureRight != null) {
    return (tick.pressureLeft + tick.pressureRight) / 2;
  }
  return tick.pressureLeft ?? tick.pressureRight;
}

function pairDelta(prev: PillowTick, cur: PillowTick): number | null {
  let sum = 0;
  let seen = false;
  if (prev.pressureLeft != null && cur.pressureLeft != null) {
    sum += Math.abs(cur.pressureLeft - prev.pressureLeft);
    seen = true;
  }
  if (prev.pressureRight != null && cur.pressureRight != null) {
    sum += Math.abs(cur.pressureRight - prev.pressureRight);
    seen = true;
  }
  return seen ? sum : null;
}

function motionFromTicks(ticks: PillowTick[], cal: MotionCalibration): number {
  const deltas: number[] = [];
  for (let i = 1; i < ticks.length; i += 1) {
    const delta = pairDelta(ticks[i - 1]!, ticks[i]!);
    if (delta != null) deltas.push(delta);
  }
  const raw = mean(deltas) ?? 0;
  // 先扣除在设备上的生理底噪，再归一化——避免安静睡眠被算成中等体动
  return clip01(Math.max(0, raw - cal.baselinePa) / cal.scalePa);
}

// ── 气压呼吸提取（cis_ip）──────────────────────────────────────────────────
// 头枕处气囊随呼吸起伏，1Hz 气压里可见 0.15–0.45Hz 的呼吸峰（空枕无此峰）。
// 取 epoch 结束前 120s 的尾随窗口：只依赖已到达的数据，实时聚合与离线重算结果一致。

export const RESP_WINDOW_MS = 120_000;
const RESP_MIN_COVERAGE = 0.8;
const RESP_DETREND_HALF = 7;
const RESP_SPEC_HZ: [number, number] = [0.08, 0.5];
const RESP_PEAK_HZ: [number, number] = [0.15, 0.45];
const MOTION_SMOOTH_HALF = 4;

export interface RespirationFeature {
  rate: number;
  prom: number;
  amp: number;
}

type PressureKey = 'pressureLeft' | 'pressureRight';

/** 把 tick 落到 1s 网格；缺口线性插值，覆盖率不足返回 null */
function resampleChannel(ticks: PillowTick[], key: PressureKey, startMs: number, n: number): number[] | null {
  const grid: Array<number | null> = new Array(n).fill(null);
  let filled = 0;
  for (const t of ticks) {
    const v = t[key];
    if (v == null) continue;
    const idx = Math.floor((t.atMs - startMs) / 1000);
    if (idx < 0 || idx >= n) continue;
    if (grid[idx] == null) filled += 1;
    grid[idx] = v;
  }
  if (filled < n * RESP_MIN_COVERAGE) return null;
  const out: number[] = new Array(n);
  let prev = -1;
  for (let i = 0; i < n; i += 1) {
    if (grid[i] != null) {
      out[i] = grid[i]!;
      if (prev >= 0 && i - prev > 1) {
        for (let k = prev + 1; k < i; k += 1) {
          out[k] = out[prev]! + ((out[i]! - out[prev]!) * (k - prev)) / (i - prev);
        }
      }
      prev = i;
    }
  }
  const first = grid.findIndex((v) => v != null);
  for (let i = 0; i < first; i += 1) out[i] = out[first]!;
  for (let i = prev + 1; i < n; i += 1) out[i] = out[prev]!;
  return out;
}

function movingAverage(x: number[], half: number): number[] {
  return x.map((_, i) => {
    let sum = 0;
    let cnt = 0;
    for (let k = Math.max(0, i - half); k <= Math.min(x.length - 1, i + half); k += 1) {
      sum += x[k]!;
      cnt += 1;
    }
    return sum / cnt;
  });
}

function respirationOfSeries(x: number[]): RespirationFeature | null {
  const trend = movingAverage(x, RESP_DETREND_HALF);
  const y = x.map((v, i) => v - trend[i]!);
  const n = y.length;
  const step = 1 / (2 * n);
  const spec: Array<{ f: number; p: number }> = [];
  for (let f = RESP_SPEC_HZ[0]; f <= RESP_SPEC_HZ[1] + 1e-9; f += step) {
    let re = 0;
    let im = 0;
    for (let k = 0; k < n; k += 1) {
      const w = 2 * Math.PI * f * k;
      re += y[k]! * Math.cos(w);
      im -= y[k]! * Math.sin(w);
    }
    spec.push({ f, p: (re * re + im * im) / n });
  }
  const powers = spec.map((s) => s.p).sort((a, b) => a - b);
  const median = powers[Math.floor(powers.length / 2)]!;
  let peak: { f: number; p: number } | null = null;
  for (const s of spec) {
    if (s.f < RESP_PEAK_HZ[0] || s.f > RESP_PEAK_HZ[1]) continue;
    if (!peak || s.p > peak.p) peak = s;
  }
  if (!peak || median <= 0) return null;
  const amp = Math.sqrt(y.reduce((sum, v) => sum + v * v, 0) / n);
  return { rate: peak.f * 60, prom: peak.p / median, amp };
}

/** 取左右气囊中呼吸峰更显著的一路；数据不足返回 null */
export function respirationFromTicks(ticks: PillowTick[], endMs: number): RespirationFeature | null {
  const n = Math.round(RESP_WINDOW_MS / 1000);
  const startMs = endMs - RESP_WINDOW_MS;
  let best: RespirationFeature | null = null;
  for (const key of ['pressureLeft', 'pressureRight'] as const) {
    const x = resampleChannel(ticks, key, startMs, n);
    if (!x) continue;
    const r = respirationOfSeries(x);
    if (r && (!best || r.prom > best.prom)) best = r;
  }
  return best;
}

/**
 * 去呼吸体动（Pa）：两级 9s 滑动平均（三角窗）把 3–5s 周期的呼吸起伏压到 ~1% 后，
 * 统计本 epoch 内左右气囊平滑气压的总变差。翻身/挪头 = 数百 Pa，静卧 ≈ 个位数。
 */
export function smoothedMotionPa(ticks: PillowTick[], epochStart: number): number | null {
  const ctxSec = 2 * MOTION_SMOOTH_HALF + 1;
  const startMs = epochStart - ctxSec * 1000;
  const n = Math.round(EPOCH_MS / 1000) + ctxSec;
  let total = 0;
  let seen = false;
  for (const key of ['pressureLeft', 'pressureRight'] as const) {
    const x = resampleChannel(ticks, key, startMs, n);
    if (!x) continue;
    const ma = movingAverage(movingAverage(x, MOTION_SMOOTH_HALF), MOTION_SMOOTH_HALF);
    for (let i = ctxSec + 1; i < n; i += 1) total += Math.abs(ma[i]! - ma[i - 1]!);
    seen = true;
  }
  return seen ? total : null;
}

export function reportsForEpoch(
  epochStart: number,
  reports: SleepReportOverlay[],
): SleepReportOverlay[] {
  const epochEnd = epochStart + EPOCH_MS;
  const inWindow = reports.filter((r) => r.atMs >= epochStart && r.atMs < epochEnd);
  if (inWindow.length) return inWindow;
  const lookback = reports
    .filter((r) => r.atMs > epochStart - SNORE_LOOKBACK_MS && r.atMs <= epochEnd)
    .sort((a, b) => a.atMs - b.atMs);
  return lookback.length ? [lookback[lookback.length - 1]!] : [];
}

/**
 * windowTicks：覆盖 [epochStart - RESP_WINDOW_MS + EPOCH_MS, epochStart + EPOCH_MS) 的 tick，
 * 供呼吸提取与平滑体动使用；缺省时仅用本 epoch 的 tick（不足以提取呼吸）。
 */
export function aggregatePillowEpoch(
  epochStart: number,
  ticks: PillowTick[],
  reports: SleepReportOverlay[] = [],
  cal: MotionCalibration = MOTION_CALIBRATION.cis_ip,
  windowTicks?: PillowTick[],
): SleepEpoch {
  const ordered = [...ticks].sort((a, b) => a.atMs - b.atMs || a.person - b.person);
  const n = ordered.length;
  const inBed = ordered.filter((t) => t.person === 1).length;
  const hearts = ordered
    .filter((t) => t.person === 1 && t.heart > 0)
    .map((t) => t.heart);
  const breaths = ordered
    .filter((t) => t.person === 1 && t.breathing > 0)
    .map((t) => t.breathing);
  const pressures = ordered
    .map(tickPressureMean)
    .filter((v): v is number => v != null);
  const overlay = reportsForEpoch(epochStart, reports);
  const moving = overlay.some((r) => r.moving !== 0);
  const context = windowTicks ?? ordered;
  let motion = motionFromTicks(ordered, cal);
  if (cal.method === 'smoothedStep') {
    const tv = smoothedMotionPa(context, epochStart);
    if (tv != null) motion = clip01(Math.max(0, tv - cal.baselinePa) / cal.scalePa);
  }
  const resp = cal.method === 'smoothedStep' ? respirationFromTicks(context, epochStart + EPOCH_MS) : null;
  const actuating = context.some(
    (t) => t.actuating === 1 && t.atMs >= epochStart + EPOCH_MS - RESP_WINDOW_MS && t.atMs < epochStart + EPOCH_MS,
  );
  // 固件 moving 标志仅作弱下限（cis_ip movingFloor=0，即完全忽略不可信的枕头 moving）
  if (moving && cal.movingFloor > 0) motion = Math.max(motion, cal.movingFloor);
  const snoreCounts = overlay.map((r) => r.snoreCount).filter((v): v is number => v != null);
  const snoreDbs = overlay.map((r) => r.snoreDb).filter((v): v is number => v != null);
  return {
    epochStartMs: epochStart,
    nightDate: sleepNightDate(new Date(epochStart)),
    sampleCount: n,
    inBedRatio: n ? inBed / n : 0,
    hrMean: mean(hearts),
    hrMin: hearts.length ? Math.min(...hearts) : null,
    hrStd: sampleStd(hearts),
    brMean: mean(breaths),
    brStd: sampleStd(breaths),
    pMean: mean(pressures),
    motion,
    snoreCount: snoreCounts.length ? Math.max(...snoreCounts) : null,
    snoreDbMax: snoreDbs.length ? Math.max(...snoreDbs) : null,
    movingFlag: moving ? 1 : 0,
    quality: n >= QUALITY_MIN_SAMPLES ? 'ok' : 'low',
    respRate: resp ? resp.rate : null,
    respProm: resp ? resp.prom : null,
    respAmp: resp ? resp.amp : null,
    actuating: actuating ? 1 : 0,
    pLeft: mean(ordered.map((t) => t.pressureLeft).filter((v): v is number => v != null)),
    pRight: mean(ordered.map((t) => t.pressureRight).filter((v): v is number => v != null)),
  };
}

/** 从按时间排序的 tick 中切出某 epoch 的尾随窗口 */
export function windowTicksFor(sortedTicks: PillowTick[], epochStart: number): PillowTick[] {
  const from = Math.min(epochStart + EPOCH_MS - RESP_WINDOW_MS, epochStart - (2 * MOTION_SMOOTH_HALF + 1) * 1000);
  const to = epochStart + EPOCH_MS;
  let lo = 0;
  let hi = sortedTicks.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sortedTicks[mid]!.atMs < from) lo = mid + 1;
    else hi = mid;
  }
  const out: PillowTick[] = [];
  for (let i = lo; i < sortedTicks.length && sortedTicks[i]!.atMs < to; i += 1) out.push(sortedTicks[i]!);
  return out;
}

export function groupTicksByEpoch(ticks: PillowTick[]): Map<number, PillowTick[]> {
  const groups = new Map<number, PillowTick[]>();
  for (const tick of ticks) {
    const start = epochStartMs(tick.atMs);
    const list = groups.get(start);
    if (list) list.push(tick);
    else groups.set(start, [tick]);
  }
  return groups;
}

export function aggregateTickGroups(
  ticks: PillowTick[],
  reports: SleepReportOverlay[] = [],
  cal: MotionCalibration = MOTION_CALIBRATION.cis_ip,
): SleepEpoch[] {
  const groups = groupTicksByEpoch(ticks);
  return [...groups.keys()]
    .sort((a, b) => a - b)
    .map((start) => aggregatePillowEpoch(start, groups.get(start) ?? [], reports, cal));
}
