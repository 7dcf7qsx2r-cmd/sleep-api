import {
  EPOCH_MS,
  QUALITY_MIN_SAMPLES,
  type SleepEpoch,
} from './iotSleepEpochMath.js';

export const IN_BED_RATIO = 0.8;
export const ONSET_EPOCHS = 30;
export const WAKE_OFF_BED_EPOCHS = 20;
export const WASO_EPOCHS = 6;
export const MOTION_SLEEP_MAX = 0.2;
export const MOTION_AWAKE = 0.35;
export const MOTION_DEEP_MAX = 0.1;
export const DEEP_STREAK_MAX_EPOCHS = 40;

export type SleepConfidence = 'low' | 'medium' | 'high';

export interface PillowSleepEstimate {
  nightDate: string;
  sleepStart: string | null;
  sleepEnd: string | null;
  durationMinutes: number;
  deepMinutes: number;
  lightMinutes: number;
  remMinutes: number;
  awakeMinutes: number;
  awakenings: number;
  avgHeartRate: number | null;
  avgBreathRate: number | null;
  confidence: SleepConfidence;
  source: 'cis_ip';
}

function isUsable(epoch: SleepEpoch): boolean {
  return epoch.quality === 'ok' && epoch.sampleCount >= QUALITY_MIN_SAMPLES;
}

export function isInBedEpoch(epoch: SleepEpoch): boolean {
  return isUsable(epoch) && epoch.inBedRatio >= IN_BED_RATIO;
}

function isQuiet(epoch: SleepEpoch): boolean {
  return epoch.motion < MOTION_SLEEP_MAX;
}

function minutesFromEpochs(count: number): number {
  return Math.round((count * EPOCH_MS) / 60_000);
}

function avg(values: number[]): number | null {
  if (!values.length) return null;
  return values.reduce((sum, n) => sum + n, 0) / values.length;
}

function findOnsetIndex(epochs: SleepEpoch[]): number {
  let streak = 0;
  let start = 0;
  for (let i = 0; i < epochs.length; i += 1) {
    const epoch = epochs[i]!;
    if (isInBedEpoch(epoch) && isQuiet(epoch)) {
      if (streak === 0) start = i;
      streak += 1;
      if (streak >= ONSET_EPOCHS) return start;
    } else {
      streak = 0;
    }
  }
  return -1;
}

function findWakeIndex(epochs: SleepEpoch[], onsetIdx: number): number {
  let off = 0;
  let offStart = onsetIdx;
  for (let i = onsetIdx; i < epochs.length; i += 1) {
    if (!isInBedEpoch(epochs[i]!)) {
      if (off === 0) offStart = i;
      off += 1;
      if (off >= WAKE_OFF_BED_EPOCHS) return offStart;
    } else {
      off = 0;
    }
  }
  return epochs.length;
}

function markBouts(
  flags: boolean[],
  from: number,
  to: number,
  pred: (i: number) => boolean,
  minLen: number,
): number {
  let awakenings = 0;
  let i = from;
  while (i < to) {
    if (!pred(i)) {
      i += 1;
      continue;
    }
    let j = i;
    while (j < to && pred(j)) j += 1;
    if (j - i >= minLen) {
      awakenings += 1;
      for (let k = i; k < j; k += 1) flags[k] = true;
    }
    i = j;
  }
  return awakenings;
}

export function estimatePillowSleep(epochs: SleepEpoch[], nightDate?: string): PillowSleepEstimate {
  const ordered = [...epochs].sort((a, b) => a.epochStartMs - b.epochStartMs);
  const date = nightDate ?? ordered[0]?.nightDate ?? '';
  const empty: PillowSleepEstimate = {
    nightDate: date,
    sleepStart: null,
    sleepEnd: null,
    durationMinutes: 0,
    deepMinutes: 0,
    lightMinutes: 0,
    remMinutes: 0,
    awakeMinutes: 0,
    awakenings: 0,
    avgHeartRate: null,
    avgBreathRate: null,
    confidence: 'low',
    source: 'cis_ip',
  };
  if (!ordered.length) return empty;

  const onsetIdx = findOnsetIndex(ordered);
  if (onsetIdx < 0) return empty;

  const wakeIdx = findWakeIndex(ordered, onsetIdx);
  const openEnded = wakeIdx === ordered.length;
  const awake = ordered.map(() => false);
  const offBedAwakenings = markBouts(
    awake,
    onsetIdx,
    wakeIdx,
    (i) => !isInBedEpoch(ordered[i]!),
    WASO_EPOCHS,
  );
  const motionAwakenings = markBouts(
    awake,
    onsetIdx,
    wakeIdx,
    (i) => isInBedEpoch(ordered[i]!) && ordered[i]!.motion >= MOTION_AWAKE,
    WASO_EPOCHS,
  );

  let deep = 0;
  let light = 0;
  let awakeCount = 0;
  let deepStreak = 0;
  const hearts: number[] = [];
  const breaths: number[] = [];

  for (let i = onsetIdx; i < wakeIdx; i += 1) {
    const epoch = ordered[i]!;
    const forcedAwake = awake[i] || !isInBedEpoch(epoch) || epoch.motion >= MOTION_AWAKE;
    if (forcedAwake) {
      awakeCount += 1;
      deepStreak = 0;
      continue;
    }
    if (epoch.hrMean != null) hearts.push(epoch.hrMean);
    if (epoch.brMean != null) breaths.push(epoch.brMean);
    if (epoch.motion < MOTION_DEEP_MAX) {
      if (deepStreak < DEEP_STREAK_MAX_EPOCHS) {
        deep += 1;
        deepStreak += 1;
      } else {
        light += 1;
      }
    } else {
      light += 1;
      deepStreak = 0;
    }
  }

  const lastSleep = ordered[Math.max(onsetIdx, wakeIdx - 1)]!;
  const sleepEndMs = openEnded
    ? lastSleep.epochStartMs + EPOCH_MS
    : ordered[wakeIdx]?.epochStartMs ?? lastSleep.epochStartMs + EPOCH_MS;
  const durationMinutes = minutesFromEpochs(deep + light);
  const asleepHours = durationMinutes / 60;
  let confidence: SleepConfidence = 'low';
  if (!openEnded && asleepHours >= 3 && asleepHours <= 12) confidence = 'medium';
  else if (openEnded && durationMinutes >= 30) confidence = 'medium';

  return {
    nightDate: date || ordered[onsetIdx]!.nightDate,
    sleepStart: new Date(ordered[onsetIdx]!.epochStartMs).toISOString(),
    sleepEnd: new Date(sleepEndMs).toISOString(),
    durationMinutes,
    deepMinutes: minutesFromEpochs(deep),
    lightMinutes: minutesFromEpochs(light),
    remMinutes: 0,
    awakeMinutes: minutesFromEpochs(awakeCount),
    awakenings: offBedAwakenings + motionAwakenings,
    avgHeartRate: avg(hearts),
    avgBreathRate: avg(breaths),
    confidence,
    source: 'cis_ip',
  };
}
