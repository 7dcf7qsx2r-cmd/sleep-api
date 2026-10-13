import {
  EPOCH_MS,
  QUALITY_MIN_SAMPLES,
  type SleepEpoch,
  type SleepProductKey,
} from './iotSleepEpochMath.js';

export const IN_BED_RATIO = 0.8;
export const ONSET_EPOCHS = 30;
export const WAKE_OFF_BED_EPOCHS = 20;
/** 中途离枕若之后仍有 ≥ 该数量的在枕 epoch，则视为夜间起夜(WASO)而非最终起床 → 续夜 */
export const REENTRY_INBED_EPOCHS = 20;
export const WASO_EPOCHS = 6;
export const MOTION_SLEEP_MAX = 0.2;
export const MOTION_AWAKE = 0.35;
export const MOTION_DEEP_MAX = 0.1;
export const DEEP_STREAK_MAX_EPOCHS = 40;

/**
 * 分期(深/浅/REM)可信门控（仅作用于「体动」旧算法）。
 * 体动单一特征无法可靠区分深睡/浅睡,REM 亦未建模 → 合并为单一「睡眠中」桶。
 * cis_ip 有气压呼吸特征时走 classifyRespiratoryNight，不受此门控影响。
 */
export const STAGING_RELIABLE: Record<SleepProductKey, boolean> = {
  cis_ip: false,
  cis_ib: false,
  cis_iswb: false,
};

// ── 气压呼吸分期（cis_ip）参数 ─────────────────────────────────────────────
/** 呼吸峰显著度 ≥ 该值视为「看得到呼吸」；空枕随机峰 p97 约 10 */
export const RESP_CONTACT_PROM = 20;
/** 相邻 epoch 呼吸率差 ≤ 该值才算稳定呼吸（排除空枕偶发尖峰） */
export const RESP_RATE_TOL = 3;
/** 体动 ≥ 该值（平滑总变差 ≈40Pa）说明有人在枕上动；空枕 p97 ≈19Pa */
export const RESP_CONTACT_MOTION = 0.08;
/**
 * 平均气压高于就近空枕基线 ≥ 该值（Pa）视为头仍压在枕上（侧睡/偏头时固件常误报离枕）。
 * 空枕水平随漏气/补气漂移约 ±40Pa；头压实测抬高 60–600Pa。
 */
export const LEVEL_CONTACT_PA = 80;
export const BASELINE_WINDOW_EPOCHS = 360;
export const BASELINE_MIN_SAMPLES = 20;
export const BASELINE_BLOCK_EPOCHS = 10;
/** 仅凭气压水平（无呼吸/体动/固件在枕佐证）维持在枕的最长时长，防止枕上放物被当成人 */
export const LEVEL_ONLY_MAX_EPOCHS = 180;
/** 气囊动作结束后再屏蔽的 epoch 数（气压回稳） */
export const ACTUATOR_SETTLE_EPOCHS = 2;
export const RESP_ONSET_EPOCHS = 20;
/** 入睡窗口内至少该比例的 epoch 有直接佐证（呼吸可见或固件在枕） */
export const RESP_ONSET_EVIDENCE = 0.3;
export const RESP_MOTION_SLEEP_MAX = 0.1;
export const RESP_MOTION_AWAKE = 0.35;
/** 持续中等体动 ≥ 该 epoch 数判清醒 */
export const RESP_RESTLESS_EPOCHS = 4;
/** 离枕超过该时长视为两段独立睡眠（如午睡与夜间），取睡得最久的一段 */
export const SESSION_GAP_EPOCHS = 120;
/**
 * 深睡：平滑后呼吸显著度 ≥ 当晚静卧段的 DEEP_QUANTILE 分位（不低于 DEEP_PROM_MIN），
 * 门槛随夜间位置线性升高到 (1 + DEEP_LATE_FACTOR) 倍——深睡集中在前半夜。
 * 显著度受头压位置影响、夜间差异大（实测 p90 54–92），故用夜内相对门槛。
 */
export const DEEP_QUANTILE = 0.8;
export const DEEP_PROM_MIN = 30;
export const DEEP_LATE_FACTOR = 1.5;
export const DEEP_MOTION_MAX = 0.04;
export const DEEP_MIN_EPOCHS = 10;
/** 入睡后至少该时长才可能进入深睡 */
export const DEEP_LATENCY_EPOCHS = 20;
/**
 * REM：入睡 ≥60 分钟后、身体静止、呼吸幅度够（头压实、信号在）但规律性处于当晚低位。
 * 幅度小而无峰是信号弱，不判 REM。
 */
export const REM_QUANTILE = 0.4;
export const REM_PROM_MAX = 20;
export const REM_AMP_MIN = 3;
export const REM_MIN_EPOCHS = 6;
export const REM_LATENCY_EPOCHS = 120;
/** 同类分期之间 ≤ 该 epoch 数的浅睡空隙并入（防碎片化） */
export const STAGE_GAP_FILL_EPOCHS = 2;

export type SleepConfidence = 'low' | 'medium' | 'high';
export type EpochStage = 'off' | 'wake' | 'light' | 'deep' | 'rem' | 'unknown';

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
  source: SleepProductKey;
}

export interface EpochStagePoint {
  epochStartMs: number;
  stage: EpochStage;
}

export interface PillowNightClassification {
  estimate: PillowSleepEstimate;
  stages: EpochStagePoint[];
  method: 'respiration' | 'motion';
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

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
}

function quantile(values: number[], p: number): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor(p * (s.length - 1))]!;
}

function emptyEstimate(nightDate: string, source: SleepProductKey): PillowSleepEstimate {
  return {
    nightDate,
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
    source,
  };
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

/**
 * 最终起床点。
 * 一段离枕达到 WAKE_OFF_BED_EPOCHS(10min) 只是「候选」：
 *  - 若其后仍有足够的在枕 epoch（如厕/起夜后重新上床）→ 判为夜间起夜(WASO)，继续找 → 续夜
 *  - 若其后再无实质在枕 → 判为最终起床，返回该段离枕起点
 *  - 离枕超过 SESSION_GAP_EPOCHS（1h）一律视为本段睡眠结束（如午睡后到夜里才再上床）
 * 否则整夜在枕（openEnded）返回 epochs.length。
 */
function findWakeIndex(inBed: boolean[], onsetIdx: number): number {
  const inBedAfter = new Array<number>(inBed.length + 1).fill(0);
  for (let i = inBed.length - 1; i >= 0; i -= 1) inBedAfter[i] = inBedAfter[i + 1]! + (inBed[i] ? 1 : 0);
  let off = 0;
  let offStart = onsetIdx;
  for (let i = onsetIdx; i < inBed.length; i += 1) {
    if (!inBed[i]) {
      if (off === 0) offStart = i;
      off += 1;
      if (off >= SESSION_GAP_EPOCHS) return offStart;
      if (off >= WAKE_OFF_BED_EPOCHS) {
        if (inBedAfter[i + 1]! >= REENTRY_INBED_EPOCHS) continue;
        return offStart;
      }
    } else {
      off = 0;
    }
  }
  return inBed.length;
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

function confidenceOf(openEnded: boolean, durationMinutes: number): SleepConfidence {
  const hours = durationMinutes / 60;
  if (!openEnded && hours >= 3 && hours <= 12) return 'medium';
  if (openEnded && durationMinutes >= 30) return 'medium';
  return 'low';
}

function sleepEndIso(ordered: SleepEpoch[], onsetIdx: number, wakeIdx: number): string {
  const openEnded = wakeIdx === ordered.length;
  const lastSleep = ordered[Math.max(onsetIdx, wakeIdx - 1)]!;
  const endMs = openEnded
    ? lastSleep.epochStartMs + EPOCH_MS
    : ordered[wakeIdx]?.epochStartMs ?? lastSleep.epochStartMs + EPOCH_MS;
  return new Date(endMs).toISOString();
}

/** 旧算法：仅体动 + 固件在枕标志 */
function classifyMotionNight(
  ordered: SleepEpoch[],
  date: string,
  source: SleepProductKey,
): PillowNightClassification {
  const stages: EpochStagePoint[] = ordered.map((e) => ({
    epochStartMs: e.epochStartMs,
    stage: isInBedEpoch(e) ? 'wake' : 'off',
  }));
  const onsetIdx = findOnsetIndex(ordered);
  if (onsetIdx < 0) return { estimate: emptyEstimate(date, source), stages, method: 'motion' };

  const inBed = ordered.map(isInBedEpoch);
  const wakeIdx = findWakeIndex(inBed, onsetIdx);
  const awake = ordered.map(() => false);
  const offBedAwakenings = markBouts(awake, onsetIdx, wakeIdx, (i) => !inBed[i], WASO_EPOCHS);
  const motionAwakenings = markBouts(
    awake,
    onsetIdx,
    wakeIdx,
    (i) => inBed[i]! && ordered[i]!.motion >= MOTION_AWAKE,
    WASO_EPOCHS,
  );

  const stagingReliable = STAGING_RELIABLE[source] ?? false;
  let deep = 0;
  let light = 0;
  let awakeCount = 0;
  let deepStreak = 0;
  const hearts: number[] = [];
  const breaths: number[] = [];

  for (let i = onsetIdx; i < wakeIdx; i += 1) {
    const epoch = ordered[i]!;
    if (awake[i] || !inBed[i] || epoch.motion >= MOTION_AWAKE) {
      awakeCount += 1;
      deepStreak = 0;
      stages[i]!.stage = inBed[i] ? 'wake' : 'off';
      continue;
    }
    if (epoch.hrMean != null) hearts.push(epoch.hrMean);
    if (epoch.brMean != null) breaths.push(epoch.brMean);
    if (epoch.motion < MOTION_DEEP_MAX && deepStreak < DEEP_STREAK_MAX_EPOCHS) {
      deep += 1;
      deepStreak += 1;
      stages[i]!.stage = stagingReliable ? 'deep' : 'light';
    } else {
      light += 1;
      if (epoch.motion >= MOTION_DEEP_MAX) deepStreak = 0;
      stages[i]!.stage = 'light';
    }
  }

  // 分期可信门控:不可信时把深睡并入「睡眠中」(light),避免向用户呈现虚高深睡;总睡眠 epoch 数不变
  if (!stagingReliable) {
    light = deep + light;
    deep = 0;
  }

  const durationMinutes = minutesFromEpochs(deep + light);
  return {
    method: 'motion',
    stages,
    estimate: {
      nightDate: date || ordered[onsetIdx]!.nightDate,
      sleepStart: new Date(ordered[onsetIdx]!.epochStartMs).toISOString(),
      sleepEnd: sleepEndIso(ordered, onsetIdx, wakeIdx),
      durationMinutes,
      deepMinutes: minutesFromEpochs(deep),
      lightMinutes: minutesFromEpochs(light),
      remMinutes: 0,
      awakeMinutes: minutesFromEpochs(awakeCount),
      awakenings: offBedAwakenings + motionAwakenings,
      avgHeartRate: avg(hearts),
      avgBreathRate: avg(breaths),
      confidence: confidenceOf(wakeIdx === ordered.length, durationMinutes),
      source,
    },
  };
}

function hasRespirationFeatures(epochs: SleepEpoch[]): boolean {
  return epochs.some((e) => e.respProm != null);
}

/** 呼吸峰可信：显著度够，且与相邻 epoch 的呼吸率一致（真实呼吸连续，空枕尖峰孤立） */
function breathingSeen(epochs: SleepEpoch[], i: number): boolean {
  const e = epochs[i]!;
  if (e.respProm == null || e.respRate == null || e.respProm < RESP_CONTACT_PROM) return false;
  for (const j of [i - 1, i + 1]) {
    const n = epochs[j];
    if (!n || n.respProm == null || n.respRate == null || n.respProm < RESP_CONTACT_PROM) continue;
    if (Math.abs(n.epochStartMs - e.epochStartMs) > 2 * EPOCH_MS) continue;
    if (Math.abs(n.respRate - e.respRate) <= RESP_RATE_TOL) return true;
  }
  return false;
}

function smoothedProm(epochs: SleepEpoch[], i: number): number {
  const vals: number[] = [];
  for (let k = i - 2; k <= i + 2; k += 1) vals.push(epochs[k]?.respProm ?? 0);
  return median(vals);
}

/** 把短于 minLen 的 target 段改成 fallback */
function dropShortRuns(stages: EpochStage[], from: number, to: number, target: EpochStage, minLen: number, fallback: EpochStage): void {
  let i = from;
  while (i < to) {
    if (stages[i] !== target) {
      i += 1;
      continue;
    }
    let j = i;
    while (j < to && stages[j] === target) j += 1;
    if (j - i < minLen) for (let k = i; k < j; k += 1) stages[k] = fallback;
    i = j;
  }
}

/** target 段之间夹着的 ≤ maxGap 个浅睡 epoch 并入 target */
function fillShortGaps(stages: EpochStage[], from: number, to: number, target: EpochStage, maxGap: number): void {
  let lastEnd = -1;
  for (let i = from; i < to; i += 1) {
    if (stages[i] !== target) continue;
    if (lastEnd >= 0 && i - lastEnd - 1 > 0 && i - lastEnd - 1 <= maxGap) {
      let allLight = true;
      for (let k = lastEnd + 1; k < i; k += 1) if (stages[k] !== 'light') allLight = false;
      if (allLight) for (let k = lastEnd + 1; k < i; k += 1) stages[k] = target;
    }
    lastEnd = i;
  }
}

type PressureChannel = (e: SleepEpoch) => number | null | undefined;

const CHANNELS: PressureChannel[] = [
  (e) => e.pLeft,
  (e) => e.pRight,
];

/**
 * 就近空枕基线（左右气囊分别求）：固件离枕、无呼吸、气压平稳且非气囊动作的 epoch 是「疑似空枕」，
 * 但头静压在枕上且呼吸弱时也满足这些条件。头压只会抬高气压，故取 ±3h 内疑似空枕
 * 气压的低位（p10）作基线；附近无样本时退回整夜 p10，整夜都无则返回 null。
 */
function emptyBaselines(ordered: SleepEpoch[], actuator: boolean[]): Array<Array<number | null>> {
  const flat: number[] = [];
  ordered.forEach((e, i) => {
    if (
      !actuator[i] && isUsable(e) && e.inBedRatio === 0 && e.motion === 0 &&
      (e.respProm ?? 0) < RESP_CONTACT_PROM
    ) flat.push(i);
  });
  return CHANNELS.map((channel) => {
    const usable = flat.filter((k) => channel(ordered[k]!) != null);
    if (!usable.length) return ordered.map(() => null);
    const low = (idx: number[]) => {
      const s = idx.map((k) => channel(ordered[k]!)!).sort((a, b) => a - b);
      return s[Math.floor(0.1 * (s.length - 1))]!;
    };
    const nightLow = low(usable);
    // 基线变化缓慢：每 BASELINE_BLOCK_EPOCHS 个 epoch 算一次，块内共用
    const blocks = new Map<number, number>();
    return ordered.map((_, i) => {
      const block = Math.floor(i / BASELINE_BLOCK_EPOCHS);
      const cached = blocks.get(block);
      if (cached != null) return cached;
      const center = block * BASELINE_BLOCK_EPOCHS + BASELINE_BLOCK_EPOCHS / 2;
      const near = usable.filter((k) => Math.abs(k - center) <= BASELINE_WINDOW_EPOCHS);
      const value = near.length >= BASELINE_MIN_SAMPLES ? low(near) : nightLow;
      blocks.set(block, value);
      return value;
    });
  });
}

function aboveEmpty(e: SleepEpoch, i: number, baselines: Array<Array<number | null>>): boolean {
  return CHANNELS.some((channel, c) => {
    const v = channel(e);
    const base = baselines[c]![i];
    return v != null && base != null && v - base >= LEVEL_CONTACT_PA;
  });
}

interface RespSignals {
  actuator: boolean[];
  breathing: boolean[];
  /** 有直接佐证：固件在枕 / 呼吸可见 / 体动 */
  evidence: boolean[];
  contact: boolean[];
}

function respSignals(ordered: SleepEpoch[]): RespSignals {
  const n = ordered.length;
  const actuator = ordered.map(() => false);
  for (let i = 0; i < n; i += 1) {
    if (!ordered[i]!.actuating) continue;
    for (let k = i; k <= Math.min(n - 1, i + ACTUATOR_SETTLE_EPOCHS); k += 1) actuator[k] = true;
  }
  const breathing = ordered.map((_, i) => breathingSeen(ordered, i));
  const evidence = ordered.map((e, i) =>
    !actuator[i] && isUsable(e) && (e.inBedRatio >= IN_BED_RATIO || breathing[i]! || e.motion >= RESP_CONTACT_MOTION),
  );
  const baselines = emptyBaselines(ordered, actuator);
  const contact = evidence.slice();
  let sinceEvidence = Infinity;
  for (let i = 0; i < n; i += 1) {
    if (evidence[i]) {
      sinceEvidence = 0;
      continue;
    }
    sinceEvidence += 1;
    const e = ordered[i]!;
    if (actuator[i]) {
      // 气囊动作期间沿用前一状态，避免把助眠时段切成离枕
      contact[i] = i > 0 && contact[i - 1]!;
    } else if (isUsable(e) && sinceEvidence <= LEVEL_ONLY_MAX_EPOCHS && aboveEmpty(e, i, baselines)) {
      contact[i] = true;
    }
  }
  return { actuator, breathing, evidence, contact };
}

function findRespOnset(ordered: SleepEpoch[], sig: RespSignals, from: number): number {
  let start = -1;
  let streak = 0;
  let evid = 0;
  for (let i = from; i < ordered.length; i += 1) {
    if (sig.actuator[i]) continue;
    if (sig.contact[i] && ordered[i]!.motion < RESP_MOTION_SLEEP_MAX) {
      if (streak === 0) {
        start = i;
        evid = 0;
      }
      streak += 1;
      if (sig.breathing[i] || ordered[i]!.inBedRatio >= IN_BED_RATIO) evid += 1;
      if (streak >= RESP_ONSET_EPOCHS) {
        if (evid >= RESP_ONSET_EVIDENCE * streak) return start;
        // 佐证不足（可能是枕上放了东西）：窗口整体后移
        streak = 0;
        i = start;
      }
    } else {
      streak = 0;
    }
  }
  return -1;
}

/**
 * 气压呼吸分期（cis_ip）。
 * 枕头固件的心率/呼吸为占位值、在枕标志在侧睡/偏头时误报离枕，故：
 *  - 在枕 = 固件在枕 ∨ 气压可见稳定呼吸 ∨ 有体动 ∨ 气压高于就近空枕基线；
 *  - 气囊动作期间及回稳期标 unknown，不算清醒、不打断入睡判定；
 *  - 一晚可能有多段（午睡/夜间），离枕 >1h 切段，取睡得最久的一段；
 *  - 深睡 = 入睡 10 分钟后、身体静止 + 呼吸规律性处于当晚高位，持续 ≥5 分钟（后半夜门槛更高）；
 *  - REM = 入睡 60 分钟后、身体静止、呼吸幅度够但规律性处于当晚低位，持续 ≥3 分钟；
 *  - 其余睡眠为浅睡。分期为估算，非医学结论。
 */
function classifyRespiratoryNight(
  ordered: SleepEpoch[],
  date: string,
  source: SleepProductKey,
): PillowNightClassification {
  const n = ordered.length;
  const sig = respSignals(ordered);
  const { actuator, contact } = sig;
  const baseStages = (): EpochStage[] => ordered.map((_, i) => (actuator[i] ? 'unknown' : contact[i] ? 'wake' : 'off'));
  const toPoints = (stages: EpochStage[]): EpochStagePoint[] =>
    ordered.map((e, i) => ({ epochStartMs: e.epochStartMs, stage: stages[i]! }));

  let best: { stages: EpochStage[]; estimate: PillowSleepEstimate } | null = null;
  let from = 0;
  while (from < n) {
    const onsetIdx = findRespOnset(ordered, sig, from);
    if (onsetIdx < 0) break;
    const wakeIdx = findWakeIndex(contact, onsetIdx);
    const session = classifyRespSession(ordered, sig, onsetIdx, wakeIdx, baseStages(), date, source);
    if (!best || session.estimate.durationMinutes > best.estimate.durationMinutes) best = session;
    from = Math.max(wakeIdx, onsetIdx + 1);
  }
  if (!best) return { estimate: emptyEstimate(date, source), stages: toPoints(baseStages()), method: 'respiration' };
  return { estimate: best.estimate, stages: toPoints(best.stages), method: 'respiration' };
}

function classifyRespSession(
  ordered: SleepEpoch[],
  sig: RespSignals,
  onsetIdx: number,
  wakeIdx: number,
  stages: EpochStage[],
  date: string,
  source: SleepProductKey,
): { stages: EpochStage[]; estimate: PillowSleepEstimate } {
  const { actuator, breathing, contact } = sig;
  const sleepLen = Math.max(1, wakeIdx - onsetIdx);
  const awake = ordered.map(() => false);
  markBouts(awake, onsetIdx, wakeIdx, (i) => !contact[i], 1);
  markBouts(awake, onsetIdx, wakeIdx, (i) => contact[i]! && !actuator[i] && ordered[i]!.motion >= RESP_MOTION_AWAKE, 1);
  markBouts(
    awake,
    onsetIdx,
    wakeIdx,
    (i) => contact[i]! && !actuator[i] && ordered[i]!.motion >= RESP_MOTION_SLEEP_MAX,
    RESP_RESTLESS_EPOCHS,
  );

  const restingProms: number[] = [];
  for (let i = onsetIdx; i < wakeIdx; i += 1) {
    if (!awake[i] && !actuator[i]) restingProms.push(ordered[i]!.respProm ?? 0);
  }
  const deepBase = Math.max(DEEP_PROM_MIN, quantile(restingProms, DEEP_QUANTILE));
  const remGate = Math.min(REM_PROM_MAX, quantile(restingProms, REM_QUANTILE));

  for (let i = onsetIdx; i < wakeIdx; i += 1) {
    if (actuator[i]) continue;
    if (awake[i]) {
      stages[i] = contact[i] ? 'wake' : 'off';
      continue;
    }
    const e = ordered[i]!;
    const pos = (i - onsetIdx) / sleepLen;
    const prom = smoothedProm(ordered, i);
    const deepGate = deepBase * (1 + DEEP_LATE_FACTOR * pos);
    if (i - onsetIdx >= DEEP_LATENCY_EPOCHS && prom >= deepGate && e.motion < DEEP_MOTION_MAX) stages[i] = 'deep';
    else if (
      i - onsetIdx >= REM_LATENCY_EPOCHS &&
      prom < remGate &&
      (e.respAmp ?? 0) >= REM_AMP_MIN &&
      e.motion < RESP_MOTION_SLEEP_MAX
    ) stages[i] = 'rem';
    else stages[i] = 'light';
  }
  fillShortGaps(stages, onsetIdx, wakeIdx, 'deep', STAGE_GAP_FILL_EPOCHS);
  fillShortGaps(stages, onsetIdx, wakeIdx, 'rem', STAGE_GAP_FILL_EPOCHS);
  dropShortRuns(stages, onsetIdx, wakeIdx, 'deep', DEEP_MIN_EPOCHS, 'light');
  dropShortRuns(stages, onsetIdx, wakeIdx, 'rem', REM_MIN_EPOCHS, 'light');
  // 睡眠段内的气囊动作：沿用前一分期
  for (let i = onsetIdx + 1; i < wakeIdx; i += 1) {
    if (stages[i] === 'unknown' && stages[i - 1] !== 'off') stages[i] = stages[i - 1]!;
  }

  let deep = 0;
  let light = 0;
  let rem = 0;
  let awakeCount = 0;
  const breaths: number[] = [];
  for (let i = onsetIdx; i < wakeIdx; i += 1) {
    const s = stages[i]!;
    if (s === 'deep') deep += 1;
    else if (s === 'rem') rem += 1;
    else if (s === 'light' || s === 'unknown') light += 1;
    else awakeCount += 1;
    if (s !== 'wake' && s !== 'off' && breathing[i] && ordered[i]!.respRate != null) breaths.push(ordered[i]!.respRate!);
  }
  const awakenings = markBouts(
    ordered.map(() => false),
    onsetIdx,
    wakeIdx,
    (i) => stages[i] === 'wake' || stages[i] === 'off',
    WASO_EPOCHS,
  );

  const durationMinutes = minutesFromEpochs(deep + light + rem);
  return {
    stages,
    estimate: {
      nightDate: date || ordered[onsetIdx]!.nightDate,
      sleepStart: new Date(ordered[onsetIdx]!.epochStartMs).toISOString(),
      sleepEnd: sleepEndIso(ordered, onsetIdx, wakeIdx),
      durationMinutes,
      deepMinutes: minutesFromEpochs(deep),
      lightMinutes: minutesFromEpochs(light),
      remMinutes: minutesFromEpochs(rem),
      awakeMinutes: minutesFromEpochs(awakeCount),
      awakenings,
      // 枕头固件心率为占位值，不对外呈现
      avgHeartRate: null,
      avgBreathRate: breaths.length ? median(breaths) : null,
      confidence: confidenceOf(wakeIdx === ordered.length, durationMinutes),
      source,
    },
  };
}

export function classifyPillowNight(
  epochs: SleepEpoch[],
  nightDate?: string,
  source: SleepProductKey = 'cis_ip',
): PillowNightClassification {
  const ordered = [...epochs].sort((a, b) => a.epochStartMs - b.epochStartMs);
  const date = nightDate ?? ordered[0]?.nightDate ?? '';
  if (!ordered.length) return { estimate: emptyEstimate(date, source), stages: [], method: 'motion' };
  if (source === 'cis_ip' && hasRespirationFeatures(ordered)) {
    return classifyRespiratoryNight(ordered, date, source);
  }
  return classifyMotionNight(ordered, date, source);
}

export function estimatePillowSleep(
  epochs: SleepEpoch[],
  nightDate?: string,
  source: SleepProductKey = 'cis_ip',
): PillowSleepEstimate {
  return classifyPillowNight(epochs, nightDate, source).estimate;
}
