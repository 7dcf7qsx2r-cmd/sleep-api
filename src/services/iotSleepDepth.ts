/**
 * 睡眠深度指数（v1 · 低置信）
 *
 * 背景：现固件下逐拍 RR 间期不可得（1Hz 纯标量，见 pillow-hrv-staging-plan），
 * 无法做医学级深/浅/REM 四期。本模块只产出一个「夜内自归一化的连续深度指数」(0–100)，
 * 用于在前端画一条曲线，直观展示整夜的深浅起伏——**不**产出分期分钟数，也**不**解锁
 * STAGING_RELIABLE。口径保守：
 *   - 唯一有结构的特征是 hrStd（心率读数波动，越小越平静/越沉）；
 *   - 用「当夜在枕睡眠段的 p10/p90」把 hrStd 归一化，避免个体基线差异；
 *   - motion 作为衰减因子（体动越大越浅）；
 *   - 时间先验：对结果做滑动平均平滑（抗 30s 抖动，等价一个轻量 HMM 平滑）。
 *
 * 深度约定：100 = 当夜最沉，0 = 清醒/体动；离床或信号不足 = null（前端断开曲线）。
 */
import { QUALITY_MIN_SAMPLES } from './iotSleepEpochMath.js';
import { IN_BED_RATIO, MOTION_AWAKE } from './iotSleepEstimate.js';

/** 计算深度指数所需的最小 epoch 视图（便于单测，不依赖完整 SleepEpoch） */
export interface DepthEpochInput {
  epochStartMs: number;
  hrStd: number | null;
  motion: number;
  inBedRatio: number;
  quality: 'ok' | 'low';
  sampleCount: number;
}

export interface SleepDepthPoint {
  epochStartMs: number;
  /** 0–100，越大越沉；null 表示离床/信号不足，前端应断开 */
  depth: number | null;
}

/** 夜内归一化的前置门槛：有效样本过少或动态范围过窄，则判定“不足以画深度曲线” */
const MIN_VALID_SAMPLES = 20; // ≥10min 的在枕睡眠 epoch
const MIN_HRSTD_SPREAD = 0.4; // p90-p10 至少 0.4bpm 才有分层意义
const SMOOTH_RADIUS = 4; // 滑动平均半径（±4 epoch ≈ ±2min）
const AWAKE_DEPTH_CAP = 15; // 在枕但体动觉醒时的深度上限

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/** 线性插值分位数（p ∈ [0,1]，values 需非空且已排序） */
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 1) return sorted[0]!;
  const idx = clamp01(p) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo]!;
  const frac = idx - lo;
  return sorted[lo]! * (1 - frac) + sorted[hi]! * frac;
}

function isUsable(e: DepthEpochInput): boolean {
  return e.quality === 'ok' && e.sampleCount >= QUALITY_MIN_SAMPLES;
}

function isInBed(e: DepthEpochInput): boolean {
  return isUsable(e) && e.inBedRatio >= IN_BED_RATIO;
}

/** 在枕且非体动觉醒（可参与 hrStd 归一化的“平静睡眠段”） */
function isCalmSleep(e: DepthEpochInput): boolean {
  return isInBed(e) && e.motion < MOTION_AWAKE && e.hrStd != null;
}

/**
 * 计算整夜的睡眠深度指数序列。返回与输入等长、按时间排序的点数组。
 * 纯函数：给定同样输入返回同样输出，便于单测。
 */
export function computeSleepDepthSeries(epochs: DepthEpochInput[]): SleepDepthPoint[] {
  const ordered = [...epochs].sort((a, b) => a.epochStartMs - b.epochStartMs);
  if (!ordered.length) return [];

  // 1) 用当夜“平静睡眠段”的 hrStd 建立归一化区间 [p10, p90]
  const calmHrStd = ordered.filter(isCalmSleep).map((e) => e.hrStd as number);
  const nullSeries = (): SleepDepthPoint[] =>
    ordered.map((e) => ({ epochStartMs: e.epochStartMs, depth: null }));

  if (calmHrStd.length < MIN_VALID_SAMPLES) return nullSeries();
  const sorted = [...calmHrStd].sort((a, b) => a - b);
  const p10 = percentile(sorted, 0.1);
  const p90 = percentile(sorted, 0.9);
  const spread = p90 - p10;
  if (spread < MIN_HRSTD_SPREAD) return nullSeries();

  // 2) 逐 epoch 定深度（未平滑）
  const raw: (number | null)[] = ordered.map((e) => {
    if (!isInBed(e)) return null; // 离床 → 断开
    if (e.motion >= MOTION_AWAKE || e.hrStd == null) {
      // 在枕体动觉醒 / 无心率：算作很浅（不为 null，曲线连续），封顶
      return Math.min(AWAKE_DEPTH_CAP, e.hrStd == null ? AWAKE_DEPTH_CAP : 0);
    }
    // hrStd 越小越沉：归一化后取反
    const hrStdNorm = clamp01((e.hrStd - p10) / spread); // 0=最平静, 1=最活跃
    const base = 100 * (1 - hrStdNorm);
    // motion 衰减：静止=1，接近 MOTION_AWAKE=0；不完全清零，保留 0.35 底
    const motionFactor = clamp01(1 - e.motion / MOTION_AWAKE);
    const depth = base * (0.35 + 0.65 * motionFactor);
    return Math.round(clamp01(depth / 100) * 100);
  });

  // 3) 时间先验平滑：滑动平均（仅在同一在枕连续段内，跨 null 断开不平均）
  const smoothed: SleepDepthPoint[] = ordered.map((e, i) => {
    if (raw[i] == null) return { epochStartMs: e.epochStartMs, depth: null };
    let sum = 0;
    let cnt = 0;
    for (let k = i - SMOOTH_RADIUS; k <= i + SMOOTH_RADIUS; k += 1) {
      if (k < 0 || k >= raw.length) continue;
      const v = raw[k];
      if (v == null) continue;
      sum += v;
      cnt += 1;
    }
    return { epochStartMs: e.epochStartMs, depth: cnt ? Math.round(sum / cnt) : raw[i]! };
  });

  return smoothed;
}
