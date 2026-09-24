/**
 * 夜间离床估计器（纯函数）。规则与阈值见 sleep-app-rn/docs/cbti-night-leave-bed-design.md 第 5、7 节。
 */

export const EPOCH_MS = 30_000;
export const TRANSITION_EPOCHS = 4;
export const PILLOW_TRANSITION_EPOCHS = 10;
export const GAP_UNKNOWN_EPOCHS = 3;
export const WINDOW_EPOCHS = 50;
export const SLEEP_ONSET_EPOCHS = 20;
export const SILENT_LOWER_BOUND_MIN = 15;
export const SOUND_LOWER_BOUND_MIN = 20;
export const SOUND_THRESHOLD_MAX_MIN = 40;
export const MAX_SILENT_PER_NIGHT = 3;
export const MAX_SOUND_PER_NIGHT = 2;
export const SOUND_MIN_INTERVAL_MS = 60 * 60_000;
export const NO_PROMPT_BEFORE_WAKE_MS = 60 * 60_000;
export const RECENT_APP_USE_MS = 3 * 60_000;
export const NO_GAP_LOOKBACK_EPOCHS = 10;
export const Z_ONE_SIDED_95 = 1.64;

export type EstimatorTier = 'bed' | 'pillow';

export interface EstimatorEpoch {
  startMs: number;
  /** null = 缺包、雷达分析中或设备异常 */
  inBed: boolean | null;
  motion: number | null;
  hrMean: number | null;
  hrStd: number | null;
  brStd: number | null;
  breathIrregular?: boolean | null;
  sittingUp?: boolean;
}

export interface EstimatorContext {
  tier: EstimatorTier;
  nowMs: number;
  wakeAnchorMs: number;
  sleepHrBaseline: number | null;
  preLightsMin: number;
  flipLatencyMs: number;
  qualified: boolean;
  shadow: boolean;
  soundAllowed: boolean;
  soundThresholdMin: number;
  singleZoneSharedBed: boolean;
  promptsOff: boolean;
  appForegroundAtMs: number[];
  priorPrompts: Array<{ level: 'silent' | 'sound'; atMs: number }>;
  /** 用户按了「我起来了」且还没按「回床」 */
  userOutByButton: boolean;
}

export type BedState = 'in_bed' | 'out_of_bed' | 'unknown';

export interface BedTransition {
  kind: 'leave_bed' | 'return_bed';
  atMs: number;
}

export type EpochLabel = 'awake_sure' | 'awake_strong' | 'awake_like' | 'sleep_like' | 'uncertain' | 'no_data';

export interface EstimatorResult {
  state: BedState;
  transitions: BedTransition[];
  inBedSinceMs: number | null;
  expectedAwakeMin: number;
  lowerBoundAwakeMin: number;
  cues: Array<'motion' | 'heart' | 'breath' | 'sitting'>;
  prompt: 'silent' | 'sound' | null;
  /** 影子期：本该提示，但只记录不发 */
  shadowPrompt: 'silent' | 'sound' | null;
  blockedBy: string | null;
}

/* ================================================================
   E1：离床、回床
   ================================================================ */

/**
 * 在枕级（第 4.4 节）：离枕且心率、呼吸都为空才算不在床，并且要连续 5 分钟；
 * 离枕但仍有心率呼吸（坐起、滑下枕头）按在床处理。
 */
export function pillowEpochsAsBed(epochs: EstimatorEpoch[]): EstimatorEpoch[] {
  return epochs.map((e) => {
    if (e.inBed !== false) return e;
    const vitalsGone = e.hrMean == null && e.brStd == null;
    return vitalsGone ? e : { ...e, inBed: true };
  });
}

export function transitionEpochsFor(tier: EstimatorTier): number {
  return tier === 'pillow' ? PILLOW_TRANSITION_EPOCHS : TRANSITION_EPOCHS;
}

export function detectTransitions(epochs: EstimatorEpoch[], flipLatencyMs = 0, transitionEpochs = TRANSITION_EPOCHS): {
  state: BedState;
  transitions: BedTransition[];
  inBedSinceMs: number | null;
} {
  const sorted = [...epochs].sort((a, b) => a.startMs - b.startMs);
  let state: BedState = 'unknown';
  let known: 'in_bed' | 'out_of_bed' | null = null;
  let inBedSinceMs: number | null = null;
  let runValue: boolean | null = null;
  let runStart = 0;
  let runLength = 0;
  let gap = 0;
  let prevStart: number | null = null;
  const transitions: BedTransition[] = [];

  for (const epoch of sorted) {
    const missed = prevStart == null ? 0 : Math.max(0, Math.round((epoch.startMs - prevStart) / EPOCH_MS) - 1);
    prevStart = epoch.startMs;
    if (missed > 0) {
      gap += missed;
      runValue = null;
      runLength = 0;
    }
    if (epoch.inBed == null) {
      gap += 1;
      runValue = null;
      runLength = 0;
      if (gap >= GAP_UNKNOWN_EPOCHS) state = 'unknown';
      continue;
    }
    if (gap >= GAP_UNKNOWN_EPOCHS) state = 'unknown';
    gap = 0;
    if (runValue === epoch.inBed) {
      runLength += 1;
    } else {
      runValue = epoch.inBed;
      runStart = epoch.startMs;
      runLength = 1;
    }
    if (runLength < transitionEpochs) continue;
    const next = runValue ? 'in_bed' : 'out_of_bed';
    if (known !== next) {
      if (known != null) {
        transitions.push(
          next === 'out_of_bed'
            ? { kind: 'leave_bed', atMs: runStart - flipLatencyMs }
            : { kind: 'return_bed', atMs: runStart },
        );
      }
      if (next === 'in_bed') inBedSinceMs = runStart;
      known = next;
    }
    state = next;
  }
  if (known === 'out_of_bed') inBedSinceMs = null;
  return { state, transitions, inBedSinceMs };
}

/* ================================================================
   E2：每个 epoch 醒着的概率
   ================================================================ */

export function labelEpoch(epoch: EstimatorEpoch, hrBaseline: number | null, appInUse: boolean): EpochLabel {
  if (appInUse || epoch.sittingUp) return 'awake_sure';
  if (epoch.inBed !== true) return 'no_data';
  if (epoch.motion == null && epoch.hrMean == null && epoch.brStd == null && epoch.breathIrregular == null) return 'no_data';
  const hrHigh = hrBaseline != null && epoch.hrMean != null && epoch.hrMean > hrBaseline + 8 && (epoch.hrStd ?? 0) >= 4;
  const breathIrregular = epoch.breathIrregular === true || (epoch.brStd != null && epoch.brStd >= 2.5);
  const motionHigh = epoch.motion != null && epoch.motion >= 0.35;
  const agreeing = [motionHigh, hrHigh, breathIrregular].filter(Boolean).length;
  if (agreeing >= 2) return 'awake_strong';
  if (agreeing === 1) return 'awake_like';
  const hrCalm = hrBaseline == null || epoch.hrMean == null || epoch.hrMean <= hrBaseline + 3;
  const breathRegular = epoch.breathIrregular === false || (epoch.brStd != null && epoch.brStd < 1.5);
  // 雷达云端没有体动：只有心率和呼吸都在且都平稳才算像睡着
  const motionCalm = epoch.motion == null ? epoch.hrMean != null : epoch.motion < 0.2;
  if (motionCalm && hrCalm && breathRegular) return 'sleep_like';
  return 'uncertain';
}

/** 校准前的规则概率；同一 epoch 两类以上线索同时指向醒着时取 0.92，否则 25 分钟窗口的保守下限到不了 20 分钟。 */
const LABEL_PROBABILITY: Record<Exclude<EpochLabel, 'no_data'>, number> = {
  awake_sure: 0.95,
  awake_strong: 0.92,
  awake_like: 0.8,
  sleep_like: 0.1,
  uncertain: 0.4,
};

function epochCues(epoch: EstimatorEpoch, hrBaseline: number | null): Set<'motion' | 'heart' | 'breath' | 'sitting'> {
  const cues = new Set<'motion' | 'heart' | 'breath' | 'sitting'>();
  if (epoch.sittingUp) cues.add('sitting');
  if ((epoch.motion ?? 0) >= 0.35) cues.add('motion');
  if (hrBaseline != null && epoch.hrMean != null && epoch.hrMean > hrBaseline + 8) cues.add('heart');
  if (epoch.breathIrregular === true || (epoch.brStd != null && epoch.brStd >= 2.5)) cues.add('breath');
  return cues;
}

export function awakeLowerBound(probabilities: number[]): { expected: number; lower: number } {
  const expected = probabilities.reduce((s, p) => s + p * 0.5, 0);
  const variance = probabilities.reduce((s, p) => s + p * (1 - p) * 0.25, 0);
  return { expected, lower: Math.max(0, expected - Z_ONE_SIDED_95 * Math.sqrt(variance)) };
}

/* ================================================================
   综合判定
   ================================================================ */

export function estimateNight(epochs: EstimatorEpoch[], ctx: EstimatorContext): EstimatorResult {
  const raw = [...epochs].filter((e) => e.startMs <= ctx.nowMs).sort((a, b) => a.startMs - b.startMs);
  const sorted = ctx.tier === 'pillow' ? pillowEpochsAsBed(raw) : raw;
  const e1 = detectTransitions(sorted, ctx.flipLatencyMs, transitionEpochsFor(ctx.tier));
  const empty: EstimatorResult = {
    ...e1,
    expectedAwakeMin: 0,
    lowerBoundAwakeMin: 0,
    cues: [],
    prompt: null,
    shadowPrompt: null,
    blockedBy: null,
  };
  if (e1.state !== 'in_bed' || e1.inBedSinceMs == null) {
    return { ...empty, blockedBy: e1.state === 'unknown' ? 'data_gap' : 'not_in_bed' };
  }

  const appUse = (atMs: number) => ctx.appForegroundAtMs.some((t) => t >= atMs && t < atMs + EPOCH_MS);
  const settleStart = e1.inBedSinceMs + ctx.preLightsMin * 60_000;
  const segment = sorted.filter((e) => e.startMs >= e1.inBedSinceMs! && e.startMs >= settleStart);
  const labels = segment.map((e) => ({ epoch: e, label: labelEpoch(e, ctx.sleepHrBaseline, appUse(e.startMs)) }));

  const trailingSleepRun = (() => {
    let n = 0;
    for (let i = labels.length - 1; i >= 0 && labels[i]!.label === 'sleep_like'; i -= 1) n += 1;
    return n;
  })();

  const window = labels.slice(-WINDOW_EPOCHS);
  const recentReturn = e1.transitions.some((t) => t.kind === 'return_bed' && ctx.nowMs - t.atMs < 20 * 60_000);
  const probabilities = window
    .filter(({ label }) => label !== 'no_data')
    .map(({ label }) => {
      let p = LABEL_PROBABILITY[label as Exclude<EpochLabel, 'no_data'>];
      if (recentReturn) p += 0.1;
      if (trailingSleepRun >= 120) p -= 0.1;
      return Math.min(0.98, Math.max(0.02, p));
    });
  const { expected, lower } = awakeLowerBound(probabilities);

  const cueCounts = new Map<string, number>();
  for (const { epoch } of window) {
    for (const cue of epochCues(epoch, ctx.sleepHrBaseline)) cueCounts.set(cue, (cueCounts.get(cue) ?? 0) + 1);
  }
  const cueFloor = Math.max(1, Math.floor(window.length / 3));
  const cues = [...cueCounts.entries()]
    .filter(([cue, count]) => (cue === 'sitting' ? count >= 1 : count >= cueFloor))
    .map(([cue]) => cue as 'motion' | 'heart' | 'breath' | 'sitting');

  const result: EstimatorResult = {
    ...empty,
    expectedAwakeMin: Math.round(expected * 10) / 10,
    lowerBoundAwakeMin: Math.round(lower * 10) / 10,
    cues,
  };

  const recentApp = ctx.appForegroundAtMs.some((t) => ctx.nowMs - t <= RECENT_APP_USE_MS && t <= ctx.nowMs);
  const independentCues = cues.filter((c) => c !== 'sitting').length;
  let level: 'silent' | 'sound' | null = null;
  if (ctx.qualified && lower >= ctx.soundThresholdMin && (independentCues >= 2 || cues.includes('sitting'))) level = 'sound';
  else if ((ctx.qualified && lower >= SILENT_LOWER_BOUND_MIN) || recentApp) level = 'silent';
  if (level === 'sound' && !ctx.soundAllowed) level = 'silent';
  if (!level) return result;

  const block = promptBlock(sorted, ctx, e1.inBedSinceMs, level);
  if (block === 'sound_limit' && level === 'sound') {
    const silentBlock = promptBlock(sorted, ctx, e1.inBedSinceMs, 'silent');
    if (!silentBlock) return finalize(result, 'silent', ctx);
  }
  if (block) return { ...result, blockedBy: block };
  return finalize(result, level, ctx);
}

function finalize(result: EstimatorResult, level: 'silent' | 'sound', ctx: EstimatorContext): EstimatorResult {
  if (ctx.shadow) return { ...result, shadowPrompt: level, blockedBy: 'shadow' };
  return { ...result, prompt: level };
}

function promptBlock(
  epochs: EstimatorEpoch[],
  ctx: EstimatorContext,
  inBedSinceMs: number,
  level: 'silent' | 'sound',
): string | null {
  if (ctx.promptsOff) return 'prompts_off';
  if (ctx.tier !== 'bed') return 'pillow_tier';
  if (ctx.singleZoneSharedBed) return 'shared_bed';
  if (ctx.userOutByButton) return 'user_out';
  if (ctx.wakeAnchorMs - ctx.nowMs <= NO_PROMPT_BEFORE_WAKE_MS) return 'near_wake';
  const lookbackStart = ctx.nowMs - NO_GAP_LOOKBACK_EPOCHS * EPOCH_MS;
  const recent = epochs.filter((e) => e.startMs >= lookbackStart && e.startMs < ctx.nowMs);
  const last = epochs[epochs.length - 1];
  if (
    recent.length < NO_GAP_LOOKBACK_EPOCHS - 1
    || recent.some((e) => e.inBed == null)
    || !last
    || ctx.nowMs - last.startMs > 2 * EPOCH_MS
  ) {
    return 'data_gap';
  }
  const inSegment = ctx.priorPrompts.filter((p) => p.atMs >= inBedSinceMs);
  if (inSegment.length > 0) return 'already_prompted_this_stretch';
  const silentCount = ctx.priorPrompts.filter((p) => p.level === 'silent').length;
  const sounds = ctx.priorPrompts.filter((p) => p.level === 'sound');
  if (level === 'silent' && silentCount >= MAX_SILENT_PER_NIGHT) return 'silent_limit';
  if (level === 'sound') {
    if (sounds.length >= MAX_SOUND_PER_NIGHT) return 'sound_limit';
    const last = Math.max(...sounds.map((p) => p.atMs), -Infinity);
    if (ctx.nowMs - last < SOUND_MIN_INTERVAL_MS) return 'sound_limit';
  }
  return null;
}

/* ================================================================
   个人资格、阈值与夜摘要
   ================================================================ */

export interface QualificationNight {
  coverage: number;
  deviceLeaveCount: number;
  diaryLeaveCount: number | null;
  deviceSolMin: number | null;
  diarySolMin: number | null;
  deviceWasoMin: number | null;
  diaryWasoMin: number | null;
}

function bucketIndex(minutes: number): number {
  if (minutes <= 0) return 0;
  if (minutes < 15) return 1;
  if (minutes < 30) return 2;
  if (minutes < 60) return 3;
  if (minutes < 120) return 4;
  return 5;
}

function withinOneBucket(a: number | null, b: number | null): boolean | null {
  if (a == null || b == null) return null;
  return Math.abs(bucketIndex(a) - bucketIndex(b)) <= 1;
}

/** 第 7.2 节第 2 道关：基线 ≥ 5 晚覆盖率 ≥ 90%，离床次数一致 ≥ 80%，入睡与夜醒相差不超过一档 ≥ 70%。 */
export function evaluateQualification(nights: QualificationNight[]): { qualified: boolean; reason: string | null } {
  const covered = nights.filter((n) => n.coverage >= 0.9);
  if (covered.length < 5) return { qualified: false, reason: 'coverage' };
  const withLeave = covered.filter((n) => n.diaryLeaveCount != null);
  if (withLeave.length > 0) {
    const agree = withLeave.filter((n) => n.diaryLeaveCount === n.deviceLeaveCount).length;
    if (agree / withLeave.length < 0.8) return { qualified: false, reason: 'leave_count' };
  }
  const bucketChecks = covered
    .map((n) => {
      const sol = withinOneBucket(n.deviceSolMin, n.diarySolMin);
      const waso = withinOneBucket(n.deviceWasoMin, n.diaryWasoMin);
      if (sol == null && waso == null) return null;
      return (sol ?? true) && (waso ?? true);
    })
    .filter((v): v is boolean => v != null);
  if (bucketChecks.length > 0 && bucketChecks.filter(Boolean).length / bucketChecks.length < 0.7) {
    return { qualified: false, reason: 'bucket_agreement' };
  }
  return { qualified: true, reason: null };
}

export type PromptFeedback = 'accurate' | 'was_asleep' | 'not_noticed';

/** 第 7.4 节：被吵醒 +5 分钟（最多 40）；连续 7 次「准」−5 分钟（最低 20）。 */
export function soundThresholdFromFeedback(history: PromptFeedback[]): number {
  let threshold = SOUND_LOWER_BOUND_MIN;
  let streak = 0;
  for (const fb of history) {
    if (fb === 'was_asleep') {
      threshold = Math.min(SOUND_THRESHOLD_MAX_MIN, threshold + 5);
      streak = 0;
    } else if (fb === 'accurate') {
      streak += 1;
      if (streak >= 7) {
        threshold = Math.max(SOUND_LOWER_BOUND_MIN, threshold - 5);
        streak = 0;
      }
    }
  }
  return threshold;
}

/** 连续两周有声提醒准确率低于 60% 自动关闭提醒。 */
export function promptsAutoDisabled(weekly: Array<{ accurate: number; total: number }>): boolean {
  const last = weekly.slice(-2);
  return last.length === 2 && last.every((w) => w.total > 0 && w.accurate / w.total < 0.6);
}

export interface NightSummary {
  inBedStartMs: number | null;
  finalOutMs: number | null;
  leaveCount: number;
  leaveMinutes: number;
  coverage: number;
  sleepHrMedian: number | null;
  estSolMin: number | null;
  estWasoMin: number | null;
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** 早晨回看整夜：E1 时间线、覆盖率、睡眠心率中位数、入睡与夜醒估计（E3）。 */
export function summarizeNight(
  epochs: EstimatorEpoch[],
  hrBaseline: number | null,
  flipLatencyMs = 0,
  tier: EstimatorTier = 'bed',
): NightSummary {
  const raw = [...epochs].sort((a, b) => a.startMs - b.startMs);
  const sorted = tier === 'pillow' ? pillowEpochsAsBed(raw) : raw;
  const e1 = detectTransitions(sorted, flipLatencyMs, transitionEpochsFor(tier));
  const firstIn = sorted.find((e) => e.inBed === true);
  const lastIn = [...sorted].reverse().find((e) => e.inBed === true);
  const inBedStartMs = firstIn?.startMs ?? null;
  const finalOutMs = lastIn ? lastIn.startMs + EPOCH_MS : null;
  const leaves = e1.transitions.filter((t) => t.kind === 'leave_bed');
  let leaveMinutes = 0;
  for (const leave of leaves) {
    const back = e1.transitions.find((t) => t.kind === 'return_bed' && t.atMs > leave.atMs);
    if (back) leaveMinutes += (back.atMs - leave.atMs) / 60_000;
  }
  const midLeaves = leaves.filter((l) => e1.transitions.some((t) => t.kind === 'return_bed' && t.atMs > l.atMs));
  const span = inBedStartMs != null && finalOutMs != null ? Math.max(1, Math.round((finalOutMs - inBedStartMs) / EPOCH_MS)) : 0;
  const withData = sorted.filter((e) => e.inBed != null && e.startMs >= (inBedStartMs ?? 0) && e.startMs < (finalOutMs ?? 0)).length;
  const coverage = span ? Math.min(1, withData / span) : 0;

  const labels = sorted
    .filter((e) => e.inBed === true)
    .map((e) => ({ e, label: labelEpoch(e, hrBaseline, false) }));
  const sleepHr = labels.filter((l) => l.label === 'sleep_like' && l.e.hrMean != null).map((l) => l.e.hrMean!);

  let estSolMin: number | null = null;
  let estWasoMin: number | null = null;
  if (coverage >= 0.9 && labels.length > 0) {
    let run = 0;
    let onsetIndex = -1;
    for (let i = 0; i < labels.length; i += 1) {
      run = labels[i]!.label === 'sleep_like' ? run + 1 : 0;
      if (run >= SLEEP_ONSET_EPOCHS) { onsetIndex = i - SLEEP_ONSET_EPOCHS + 1; break; }
    }
    if (onsetIndex >= 0) {
      estSolMin = (onsetIndex * EPOCH_MS) / 60_000;
      const after = labels.slice(onsetIndex);
      const awake = after.filter((l) => l.label === 'awake_like' || l.label === 'awake_strong' || l.label === 'awake_sure').length;
      estWasoMin = Math.round((awake * EPOCH_MS) / 60_000 + leaveMinutes);
    }
  }

  return {
    inBedStartMs,
    finalOutMs,
    leaveCount: midLeaves.length,
    leaveMinutes: Math.round(leaveMinutes),
    coverage: Math.round(coverage * 1000) / 1000,
    sleepHrMedian: median(sleepHr),
    estSolMin: estSolMin == null ? null : Math.round(estSolMin),
    estWasoMin,
  };
}
