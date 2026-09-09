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
}

export const MOTION_CALIBRATION: Record<SleepProductKey, MotionCalibration> = {
  // 枕头：右气囊呼吸/心搏底噪约 16Pa，一次翻身差分 ~120Pa。moving 字段不可信 → 关闭下限。
  cis_ip: { scalePa: 120, baselinePa: 16, movingFloor: 0 },
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
  return {
    atMs,
    person,
    heart: finiteNumber(status.heart) ?? 0,
    breathing: finiteNumber(status.breathing) ?? 0,
    pressureLeft: finiteNumber(status.pressureLeft),
    pressureRight: finiteNumber(status.pressureRight),
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

export function aggregatePillowEpoch(
  epochStart: number,
  ticks: PillowTick[],
  reports: SleepReportOverlay[] = [],
  cal: MotionCalibration = MOTION_CALIBRATION.cis_ip,
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
  let motion = motionFromTicks(ordered, cal);
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
  };
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
