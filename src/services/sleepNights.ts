import type { OwnerRef } from '../lib/owner.js';
import { getBlob, upsertBlob } from './dataBlob.js';
import {
  type SleepNight,
  nightDateToday,
  parseSleepNights,
} from '../types/sleepNight.js';

const DOMAIN = 'sleep_nights';

export async function loadSleepNights(owner: OwnerRef): Promise<{ nights: SleepNight[]; version: number }> {
  const blob = await getBlob(owner, DOMAIN);
  if (!blob) return { nights: [], version: 0 };
  return { nights: parseSleepNights(blob.data), version: blob.version };
}

export async function saveSleepNights(
  owner: OwnerRef,
  nights: SleepNight[],
  expectedVersion: number,
): Promise<{ ok: true; version: number } | { ok: false; conflict: boolean }> {
  const sorted = [...nights].sort((a, b) => a.nightDate.localeCompare(b.nightDate));
  const result = await upsertBlob(owner, DOMAIN, expectedVersion, sorted);
  if (!result.ok) return { ok: false, conflict: true };
  return { ok: true, version: result.row.version };
}

export function getLastNight(nights: SleepNight[]): SleepNight | null {
  if (!nights.length) return null;
  return nights[nights.length - 1]!;
}

export function hasMorningCheckInToday(nights: SleepNight[]): boolean {
  const today = nightDateToday();
  const night = nights.find((n) => n.nightDate === today);
  return Boolean(night?.checkInAt);
}

export interface MorningCheckInInput {
  subjectiveMood: 1 | 2 | 3 | 4;
  bedtimeBucket?: 'before_23' | '23_01' | 'after_01';
  morningTags?: string[];
}

export async function applyMorningCheckIn(
  owner: OwnerRef,
  input: MorningCheckInInput,
): Promise<{ night: SleepNight; version: number }> {
  const { nights, version } = await loadSleepNights(owner);
  const today = nightDateToday();
  const now = new Date().toISOString();
  const idx = nights.findIndex((n) => n.nightDate === today);
  const base: SleepNight = idx >= 0 ? nights[idx]! : {
    id: `night_${Date.now()}`,
    nightDate: today,
    score: 0,
    durationMinutes: 0,
    deepMinutes: 0,
    lightMinutes: 0,
    remMinutes: 0,
    awakeMinutes: 0,
    primarySource: 'user_self_report',
    confidence: 'medium',
    synthesizedAt: now,
    version: 1,
  };

  const updated: SleepNight = {
    ...base,
    subjectiveMood: input.subjectiveMood,
    bedtimeBucket: input.bedtimeBucket,
    morningTags: input.morningTags ?? [],
    checkInAt: now,
    primarySource: base.durationMinutes > 0 ? base.primarySource : 'user_self_report',
    synthesizedAt: now,
  };

  const next = [...nights];
  if (idx >= 0) next[idx] = updated;
  else next.push(updated);

  const saved = await saveSleepNights(owner, next, version);
  if (!saved.ok) {
    const retry = await loadSleepNights(owner);
    const retryNext = [...retry.nights];
    const ri = retryNext.findIndex((n) => n.nightDate === today);
    if (ri >= 0) retryNext[ri] = updated;
    else retryNext.push(updated);
    const saved2 = await saveSleepNights(owner, retryNext, retry.version);
    if (!saved2.ok) throw new Error('sleep_nights_conflict');
    return { night: updated, version: saved2.version };
  }
  return { night: updated, version: saved.version };
}

const WEEKDAY = ['日', '一', '二', '三', '四', '五', '六'];

export interface WeekTimelineDay {
  nightDate: string;
  label: string;
  weekday: string;
  hasData: boolean;
  score?: number;
  durationHours?: number;
  checkedIn?: boolean;
}

export function buildRollingWeekTimeline(nights: SleepNight[]): WeekTimelineDay[] {
  const byDate = new Map(nights.map((n) => [n.nightDate, n]));
  const slots: WeekTimelineDay[] = [];
  const today = new Date();

  for (let offset = 6; offset >= 0; offset -= 1) {
    const d = new Date(today);
    d.setDate(d.getDate() - offset);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    const nightDate = `${y}-${m}-${day}`;
    const rec = byDate.get(nightDate);
    slots.push({
      nightDate,
      label: `${m}-${day}`,
      weekday: WEEKDAY[d.getDay()]!,
      hasData: Boolean(rec && (rec.durationMinutes > 0 || rec.checkInAt)),
      score: rec?.score,
      durationHours: rec?.durationMinutes ? +(rec.durationMinutes / 60).toFixed(1) : undefined,
      checkedIn: Boolean(rec?.checkInAt),
    });
  }
  return slots;
}
