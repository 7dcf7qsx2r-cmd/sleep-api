import { sleepNightDate } from '../utils/civilDate.js';

export const EPOCH_MS = 30_000;
export const MOTION_SCALE_PA = 80;
export const QUALITY_MIN_SAMPLES = 20;
export const SNORE_LOOKBACK_MS = 60_000;
export const EPOCH_CLOSE_GRACE_MS = 2_000;
export const IOT_SLEEP_TTL_DAYS = 3;
export const PILLOW_PRODUCT_KEY = 'cis_ip';

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

function motionFromTicks(ticks: PillowTick[]): number {
  const deltas: number[] = [];
  for (let i = 1; i < ticks.length; i += 1) {
    const prev = ticks[i - 1]!;
    const cur = ticks[i]!;
    if (prev.pressureLeft == null || prev.pressureRight == null) continue;
    if (cur.pressureLeft == null || cur.pressureRight == null) continue;
    deltas.push(
      Math.abs(cur.pressureLeft - prev.pressureLeft) + Math.abs(cur.pressureRight - prev.pressureRight),
    );
  }
  const raw = mean(deltas) ?? 0;
  return clip01(raw / MOTION_SCALE_PA);
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
  let motion = motionFromTicks(ordered);
  if (moving) motion = Math.max(motion, 0.5);
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
): SleepEpoch[] {
  const groups = groupTicksByEpoch(ticks);
  return [...groups.keys()]
    .sort((a, b) => a - b)
    .map((start) => aggregatePillowEpoch(start, groups.get(start) ?? [], reports));
}
