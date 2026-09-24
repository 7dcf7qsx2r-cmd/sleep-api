/**
 * 6 周睡眠节律计划 · 规则引擎（纯函数，无依赖）。
 *
 * 与 sleep-api `src/services/cbti/engine.ts` 必须逐字一致：服务端用同一份规则复算客户端结算。
 * 改规则时同时改两边，并提升 CBTI_ENGINE_VERSION。
 */

export const CBTI_ENGINE_VERSION = 'cbti-rules-1';

export const TIB_FLOOR_MIN = 330;
export const TIB_HARD_CEILING_MIN = 540;
export const TIB_STEP_MIN = 15;
export const PLAN_TOTAL_DAYS = 42;
export const BASELINE_DAYS = 7;
export const BASELINE_MAX_DAYS = 14;
export const MIN_VALID_NIGHTS = 5;
export const SHORT_SLEEP_MIN = 300;
export const ADHERENCE_BED_GRACE_MIN = 15;
export const ADHERENCE_WAKE_GRACE_MIN = 30;
export const WAKE_ANCHOR_MIN = '05:00';
export const WAKE_ANCHOR_MAX = '10:00';
export const PAUSE_MAX_DAYS = 14;
export const PAUSE_KEEP_WINDOW_DAYS = 7;
export const SETTLEMENT_DAYS = [14, 21, 28, 35] as const;
export const CARE_DAYS = [3, 7, 10] as const;

export type CbtiTrack = 'full' | 'gentle' | 'none';
export type CbtiPlanStatus =
  | 'intro'
  | 'baseline'
  | 'active'
  | 'paused'
  | 'safety_paused'
  | 'completed'
  | 'maintenance'
  | 'exited';

export type CbtiBucket = 'none' | 'lt15' | '15_30' | '30_60' | '1_2h' | 'gt2h';

/** 第 6.1 节档位代表值，按区间中值。 */
export const BUCKET_MINUTES: Record<CbtiBucket, number> = {
  none: 0,
  lt15: 10,
  '15_30': 20,
  '30_60': 45,
  '1_2h': 90,
  gt2h: 150,
};

export const BUCKET_ORDER: CbtiBucket[] = ['none', 'lt15', '15_30', '30_60', '1_2h', 'gt2h'];

export type CbtiSpecialReason = 'sick' | 'travel' | 'alcohol' | 'childcare' | 'other';

export interface CbtiDiaryCore {
  /** 起床日 YYYY-MM-DD（上海时间 12 点切分） */
  nightDate: string;
  bedTime: string | null;
  wakeTime: string | null;
  preLightsMin?: number | null;
  solMin: number | null;
  wasoMin: number | null;
  emaMin: number | null;
  /** 0 不困 … 4 撑不住 */
  sleepiness?: number | null;
  special?: CbtiSpecialReason | null;
}

export interface CbtiNightMetrics {
  tibMin: number;
  tstMin: number;
  /** 0–1 */
  se: number;
}

/* ================================================================
   时间工具
   ================================================================ */

export function parseHm(hm: string): number {
  const match = /^(\d{1,2}):(\d{2})$/.exec(hm.trim());
  if (!match) return Number.NaN;
  const h = Number(match[1]);
  const m = Number(match[2]);
  if (h > 23 || m > 59) return Number.NaN;
  return h * 60 + m;
}

export function formatHm(minutes: number): string {
  const wrapped = ((Math.round(minutes) % 1440) + 1440) % 1440;
  return `${String(Math.floor(wrapped / 60)).padStart(2, '0')}:${String(wrapped % 60).padStart(2, '0')}`;
}

export function addMinutesHm(hm: string, delta: number): string {
  return formatHm(parseHm(hm) + delta);
}

export function roundTo15(minutes: number): number {
  return Math.round(minutes / TIB_STEP_MIN) * TIB_STEP_MIN;
}

function floorTo15(minutes: number): number {
  return Math.floor(minutes / TIB_STEP_MIN) * TIB_STEP_MIN;
}

export function addCivilDays(isoDate: string, days: number): string {
  const [year, month, day] = isoDate.split('-').map(Number);
  const shifted = new Date(Date.UTC(year!, (month ?? 1) - 1, (day ?? 1) + days));
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, '0')}-${String(shifted.getUTCDate()).padStart(2, '0')}`;
}

export function civilDaysBetween(earlier: string, later: string): number {
  const toUtc = (iso: string) => {
    const [y, m, d] = iso.split('-').map(Number);
    return Date.UTC(y!, (m ?? 1) - 1, d ?? 1);
  };
  return Math.round((toUtc(later) - toUtc(earlier)) / 86_400_000);
}

/** 上床时刻相对中午展开，用于跨午夜的平均。 */
function bedClockToEvening(minutes: number): number {
  return minutes < 12 * 60 ? minutes + 1440 : minutes;
}

export function averageBedTime(times: string[]): string | null {
  const values = times.map(parseHm).filter((v) => Number.isFinite(v)).map(bedClockToEvening);
  if (values.length === 0) return null;
  return formatHm(values.reduce((a, b) => a + b, 0) / values.length);
}

/* ================================================================
   单晚口径
   ================================================================ */

export function bucketToMinutes(bucket: CbtiBucket): number {
  return BUCKET_MINUTES[bucket];
}

export function minutesToBucket(minutes: number): CbtiBucket {
  if (minutes <= 0) return 'none';
  if (minutes < 15) return 'lt15';
  if (minutes < 30) return '15_30';
  if (minutes < 60) return '30_60';
  if (minutes < 120) return '1_2h';
  return 'gt2h';
}

/** 两个分钟值相差是否超过一个档位（CB-DIA-08）。 */
export function differsByMoreThanOneBucket(a: number, b: number): boolean {
  return Math.abs(BUCKET_ORDER.indexOf(minutesToBucket(a)) - BUCKET_ORDER.indexOf(minutesToBucket(b))) > 1;
}

export function timeInBedMinutes(bedTime: string, wakeTime: string): number {
  const bed = parseHm(bedTime);
  const wake = parseHm(wakeTime);
  if (!Number.isFinite(bed) || !Number.isFinite(wake)) return Number.NaN;
  const diff = wake - bed;
  return diff <= 0 ? diff + 1440 : diff;
}

export function hasRequiredFields(entry: CbtiDiaryCore): boolean {
  return Boolean(entry.bedTime && entry.wakeTime)
    && entry.solMin != null
    && entry.wasoMin != null
    && entry.emaMin != null;
}

export function nightMetrics(entry: CbtiDiaryCore): CbtiNightMetrics | null {
  if (!hasRequiredFields(entry)) return null;
  const tibMin = timeInBedMinutes(entry.bedTime!, entry.wakeTime!);
  if (!Number.isFinite(tibMin) || tibMin < 60 || tibMin > 18 * 60) return null;
  const awake = (entry.preLightsMin ?? 0) + entry.solMin! + entry.wasoMin! + entry.emaMin!;
  const tstMin = Math.max(0, tibMin - awake);
  return { tibMin, tstMin, se: tstMin / tibMin };
}

/** 有效夜：五项必填齐全、口径合理、未标特殊夜。 */
export function isValidNight(entry: CbtiDiaryCore): boolean {
  return !entry.special && nightMetrics(entry) != null;
}

export interface CbtiWindow {
  wakeAnchor: string;
  /** 完整轨才有 */
  earliestBedTime: string | null;
}

/** 距起床锚还有多少分钟上床；上床晚于起床锚时为负。 */
function bedLeadMinutes(bedTime: string, wakeAnchor: string): number {
  const lead = (parseHm(wakeAnchor) - parseHm(bedTime) + 1440) % 1440;
  return lead > 20 * 60 ? lead - 1440 : lead;
}

function wakeDeviationMinutes(wakeTime: string, wakeAnchor: string): number {
  const diff = Math.abs(parseHm(wakeTime) - parseHm(wakeAnchor));
  return Math.min(diff, 1440 - diff);
}

export function keptWakeAnchor(entry: CbtiDiaryCore, wakeAnchor: string): boolean {
  return Boolean(entry.wakeTime) && wakeDeviationMinutes(entry.wakeTime!, wakeAnchor) <= ADHERENCE_WAKE_GRACE_MIN;
}

/** 执行夜：上床不早于最早上床 15 分钟以上，且起床在起床锚 ±30 分钟内。无窗口时只看起床。 */
export function isAdherentNight(entry: CbtiDiaryCore, window: CbtiWindow): boolean {
  if (!entry.bedTime || !entry.wakeTime) return false;
  if (!keptWakeAnchor(entry, window.wakeAnchor)) return false;
  if (!window.earliestBedTime) return true;
  const allowedLead = bedLeadMinutes(window.earliestBedTime, window.wakeAnchor) + ADHERENCE_BED_GRACE_MIN;
  return bedLeadMinutes(entry.bedTime, window.wakeAnchor) <= allowedLead;
}

/* ================================================================
   卧床时长上下限与窗口
   ================================================================ */

export function tibCeiling(baselineTibMin: number | null | undefined): number {
  const base = baselineTibMin && baselineTibMin > 0 ? baselineTibMin : TIB_HARD_CEILING_MIN;
  return Math.max(TIB_FLOOR_MIN, floorTo15(Math.min(base, TIB_HARD_CEILING_MIN)));
}

export function clampTib(tibMin: number, baselineTibMin: number | null | undefined): number {
  return Math.min(Math.max(roundTo15(tibMin), TIB_FLOOR_MIN), tibCeiling(baselineTibMin));
}

export function earliestBedFor(wakeAnchor: string, tibMin: number): string {
  return addMinutesHm(wakeAnchor, -tibMin);
}

export interface CbtiPeriodStats {
  nights: number;
  validNights: number;
  adherentNights: number;
  avgTibMin: number;
  avgTstMin: number;
  /** 0–1；按总睡着 ÷ 总卧床 */
  se: number;
  avgSolMin: number;
  avgWasoMin: number;
  sleepinessAvg: number | null;
  keptWakeNights: number;
  specialNights: number;
}

export function periodStats(entries: CbtiDiaryCore[], window: CbtiWindow): CbtiPeriodStats {
  const valid = entries.filter(isValidNight);
  const metrics = valid.map((e) => nightMetrics(e)!);
  const sumTib = metrics.reduce((s, m) => s + m.tibMin, 0);
  const sumTst = metrics.reduce((s, m) => s + m.tstMin, 0);
  const sleepiness = valid
    .map((e) => e.sleepiness)
    .filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  const n = valid.length;
  return {
    nights: entries.length,
    validNights: n,
    adherentNights: valid.filter((e) => isAdherentNight(e, window)).length,
    avgTibMin: n ? sumTib / n : 0,
    avgTstMin: n ? sumTst / n : 0,
    se: sumTib > 0 ? sumTst / sumTib : 0,
    avgSolMin: n ? valid.reduce((s, e) => s + (e.solMin ?? 0), 0) / n : 0,
    avgWasoMin: n ? valid.reduce((s, e) => s + (e.wasoMin ?? 0), 0) / n : 0,
    sleepinessAvg: sleepiness.length ? sleepiness.reduce((a, b) => a + b, 0) / sleepiness.length : null,
    keptWakeNights: entries.filter((e) => keptWakeAnchor(e, window.wakeAnchor)).length,
    specialNights: entries.filter((e) => Boolean(e.special)).length,
  };
}

/** 取结算日（含）往前 7 个起床日的日记。 */
export function rollingWindow(entries: CbtiDiaryCore[], endNightDate: string, days = 7): CbtiDiaryCore[] {
  const start = addCivilDays(endNightDate, -(days - 1));
  return entries.filter((e) => e.nightDate >= start && e.nightDate <= endNightDate);
}

/* ================================================================
   入组、分轨、初始窗口
   ================================================================ */

export type CbtiSafetyItem =
  | 'bipolar_epilepsy'
  | 'pregnant'
  | 'apnea'
  | 'shift_or_hazard'
  | 'low_mood'
  | 'self_harm';

export const SAFETY_ITEMS: CbtiSafetyItem[] = [
  'bipolar_epilepsy',
  'pregnant',
  'apnea',
  'shift_or_hazard',
  'low_mood',
  'self_harm',
];

export type CbtiScreeningOutcome =
  | { kind: 'crisis' }
  | { kind: 'not_eligible'; reason: 'frequency' | 'age' }
  | { kind: 'eligible'; forcedGentle: boolean; safetyFlags: CbtiSafetyItem[] };

export type CbtiComplaintFrequency = 'lt1' | '1_2' | 'gte3';

export function evaluateScreening(input: {
  frequency: CbtiComplaintFrequency;
  isAdult: boolean;
  safety: Partial<Record<CbtiSafetyItem, boolean>>;
}): CbtiScreeningOutcome {
  if (input.safety.self_harm) return { kind: 'crisis' };
  if (!input.isAdult) return { kind: 'not_eligible', reason: 'age' };
  if (input.frequency !== 'gte3') return { kind: 'not_eligible', reason: 'frequency' };
  const safetyFlags = SAFETY_ITEMS.filter((item) => item !== 'self_harm' && input.safety[item]);
  return { kind: 'eligible', forcedGentle: safetyFlags.length > 0, safetyFlags };
}

export type CbtiTrackReason =
  | 'isi_low'
  | 'safety'
  | 'ess_high'
  | 'short_sleep'
  | 'isi_moderate'
  | 'isi_high';

export const ESS_HIGH = 11;
export const ISI_NONE_MAX = 7;
export const ISI_GENTLE_MAX = 14;

export function assignTrack(input: {
  isi: number;
  ess: number | null;
  safetyFlags: string[];
  baselineAvgTstMin: number | null;
}): { track: CbtiTrack; reason: CbtiTrackReason } {
  if (input.isi <= ISI_NONE_MAX) return { track: 'none', reason: 'isi_low' };
  if (input.safetyFlags.length > 0) return { track: 'gentle', reason: 'safety' };
  if (input.ess != null && input.ess >= ESS_HIGH) return { track: 'gentle', reason: 'ess_high' };
  if (input.baselineAvgTstMin != null && input.baselineAvgTstMin > 0 && input.baselineAvgTstMin < SHORT_SLEEP_MIN) {
    return { track: 'gentle', reason: 'short_sleep' };
  }
  if (input.isi <= ISI_GENTLE_MAX) return { track: 'gentle', reason: 'isi_moderate' };
  return { track: 'full', reason: 'isi_high' };
}

/** 温和轨 → 完整轨的申请条件（CB-MGT-03）。 */
export function canRequestFullTrack(input: { safetyFlags: string[]; ess: number | null; isi: number | null }): boolean {
  return input.safetyFlags.length === 0
    && (input.ess == null || input.ess < ESS_HIGH)
    && input.isi != null
    && input.isi >= 8;
}

export const ISI_ITEM_COUNT = 7;
export const ESS_ITEM_COUNT = 8;

export function scoreIsi(answers: number[]): number | null {
  if (answers.length !== ISI_ITEM_COUNT) return null;
  if (answers.some((a) => !Number.isInteger(a) || a < 0 || a > 4)) return null;
  return answers.reduce((a, b) => a + b, 0);
}

export function scoreEss(answers: number[]): number | null {
  if (answers.length !== ESS_ITEM_COUNT) return null;
  if (answers.some((a) => !Number.isInteger(a) || a < 0 || a > 3)) return null;
  return answers.reduce((a, b) => a + b, 0);
}

export interface CbtiBaselineResult {
  status: 'ready' | 'extend' | 'restart';
  validNights: number;
  avgTibMin: number;
  avgTstMin: number;
  se: number;
  avgBedTime: string | null;
}

/** 基线结束判定：第 7 天起有效夜 ≥ 5 即可；不足则延长到第 14 天；仍不足提示重新开始（CB-BAS-04）。 */
export function evaluateBaseline(
  entries: CbtiDiaryCore[],
  startDate: string,
  planDay: number,
  wakeAnchor: string,
): CbtiBaselineResult {
  const lastDay = Math.min(planDay, BASELINE_MAX_DAYS);
  const end = addCivilDays(startDate, lastDay - 1);
  const inBaseline = entries.filter((e) => e.nightDate >= startDate && e.nightDate <= end);
  const stats = periodStats(inBaseline, { wakeAnchor, earliestBedTime: null });
  const avgBedTime = averageBedTime(inBaseline.filter(isValidNight).map((e) => e.bedTime!));
  const base = {
    validNights: stats.validNights,
    avgTibMin: stats.avgTibMin,
    avgTstMin: stats.avgTstMin,
    se: stats.se,
    avgBedTime,
  };
  if (planDay >= BASELINE_DAYS && stats.validNights >= MIN_VALID_NIGHTS) return { status: 'ready', ...base };
  if (planDay >= BASELINE_MAX_DAYS) return { status: 'restart', ...base };
  return { status: 'extend', ...base };
}

export type CbtiInitialReason = 'from_avg_sleep' | 'se_already_good';

export function initialWindow(input: {
  baselineAvgTstMin: number;
  baselineAvgTibMin: number;
  baselineSe: number;
  wakeAnchor: string;
}): { prescribedTibMin: number; earliestBedTime: string; reason: CbtiInitialReason } {
  const seGood = input.baselineSe >= 0.85;
  const raw = seGood ? input.baselineAvgTibMin : input.baselineAvgTstMin;
  const prescribedTibMin = clampTib(raw, input.baselineAvgTibMin);
  return {
    prescribedTibMin,
    earliestBedTime: earliestBedFor(input.wakeAnchor, prescribedTibMin),
    reason: seGood ? 'se_already_good' : 'from_avg_sleep',
  };
}

/* ================================================================
   每周结算（完整轨）
   ================================================================ */

export type CbtiSettlementReason =
  | 'insufficient_nights'
  | 'low_adherence'
  | 'short_sleep'
  | 'sleepy'
  | 'se_high'
  | 'se_good'
  | 'se_ok'
  | 'se_low';

export type CbtiSuggestion = 'offer_gentle' | 'offer_pause' | 'backfill';

export interface CbtiSettlementResult {
  engineVersion: string;
  reason: CbtiSettlementReason;
  stats: CbtiPeriodStats;
  oldTibMin: number;
  newTibMin: number;
  deltaMin: number;
  earliestBedTime: string;
  suggestions: CbtiSuggestion[];
}

function settlementDelta(stats: CbtiPeriodStats): { reason: CbtiSettlementReason; delta: number; suggestions: CbtiSuggestion[] } {
  if (stats.validNights < MIN_VALID_NIGHTS) return { reason: 'insufficient_nights', delta: 0, suggestions: ['backfill'] };
  if (stats.adherentNights < stats.validNights / 2) return { reason: 'low_adherence', delta: 0, suggestions: [] };
  if (stats.avgTstMin < SHORT_SLEEP_MIN) return { reason: 'short_sleep', delta: 0, suggestions: ['offer_gentle'] };
  if (stats.sleepinessAvg != null && stats.sleepinessAvg >= 3) {
    return { reason: 'sleepy', delta: stats.se >= 0.85 ? 15 : 0, suggestions: ['offer_gentle', 'offer_pause'] };
  }
  if (stats.se >= 0.9 && stats.sleepinessAvg != null && stats.sleepinessAvg <= 2) return { reason: 'se_high', delta: 30, suggestions: [] };
  if (stats.se >= 0.85) return { reason: 'se_good', delta: 15, suggestions: [] };
  if (stats.se >= 0.8) return { reason: 'se_ok', delta: 0, suggestions: [] };
  return { reason: 'se_low', delta: -15, suggestions: [] };
}

export function settleWeek(input: {
  entries: CbtiDiaryCore[];
  settlementNightDate: string;
  prescribedTibMin: number;
  baselineTibMin: number | null;
  wakeAnchor: string;
}): CbtiSettlementResult {
  const window: CbtiWindow = {
    wakeAnchor: input.wakeAnchor,
    earliestBedTime: earliestBedFor(input.wakeAnchor, input.prescribedTibMin),
  };
  const stats = periodStats(rollingWindow(input.entries, input.settlementNightDate), window);
  const { reason, delta, suggestions } = settlementDelta(stats);
  const newTibMin = delta === 0 ? input.prescribedTibMin : clampTib(input.prescribedTibMin + delta, input.baselineTibMin);
  return {
    engineVersion: CBTI_ENGINE_VERSION,
    reason,
    stats,
    oldTibMin: input.prescribedTibMin,
    newTibMin,
    deltaMin: newTibMin - input.prescribedTibMin,
    earliestBedTime: earliestBedFor(input.wakeAnchor, newTibMin),
    suggestions,
  };
}

/** 两次结算是否一致（服务端复算校验用）。 */
export function sameSettlement(a: Pick<CbtiSettlementResult, 'reason' | 'newTibMin'>, b: Pick<CbtiSettlementResult, 'reason' | 'newTibMin'>): boolean {
  return a.reason === b.reason && a.newTibMin === b.newTibMin;
}

/* ================================================================
   计划日历、夜间时段、暂停
   ================================================================ */

/** 计划第几天（入组日为第 1 天），扣除暂停天数。 */
export function planDayIndex(startDate: string, today: string, pausedDays = 0): number {
  return Math.max(1, civilDaysBetween(startDate, today) + 1 - Math.max(0, pausedDays));
}

export function planWeekIndex(planDay: number): number {
  return Math.min(6, Math.max(1, Math.ceil(planDay / 7)));
}

export function isSettlementDay(planDay: number): boolean {
  return (SETTLEMENT_DAYS as readonly number[]).includes(planDay);
}

/** 进入完整轨或温和轨那天（通常第 7 天，基线延长时更晚）起每满 7 天结算一次，共 4 次；再满 7 天完成。 */
export function settlementDaysFrom(activeSinceDay: number): number[] {
  return [1, 2, 3, 4].map((k) => activeSinceDay + 7 * k);
}

export function completionDayFrom(activeSinceDay: number): number {
  return activeSinceDay + PLAN_TOTAL_DAYS - BASELINE_DAYS;
}

/** 截至今天最近一个应结算、还没结算的计划日；错过的更早结算日不补算。 */
export function dueSettlementDay(activeSinceDay: number, planDay: number, settledDays: number[]): number | null {
  const lastSettled = settledDays.length ? Math.max(...settledDays) : 0;
  const due = settlementDaysFrom(activeSinceDay).filter((d) => d <= planDay && d > lastSettled);
  return due.length ? due[due.length - 1]! : null;
}

export const DEFAULT_BED_TIME = '23:00';

export function nightModeWindow(input: {
  track: CbtiTrack;
  status: CbtiPlanStatus;
  wakeAnchor: string;
  earliestBedTime: string | null;
  baselineBedTime: string | null;
}): { start: string; end: string } {
  if (input.track === 'full' && input.status === 'active' && input.earliestBedTime) {
    return { start: addMinutesHm(input.earliestBedTime, -30), end: input.wakeAnchor };
  }
  return { start: addMinutesHm(input.baselineBedTime ?? DEFAULT_BED_TIME, -60), end: input.wakeAnchor };
}

/** 时刻是否落在 [start, end) 内，支持跨午夜。 */
export function isWithinClockRange(nowHm: string, start: string, end: string): boolean {
  const now = parseHm(nowHm);
  const s = parseHm(start);
  const e = parseHm(end);
  if (s === e) return false;
  return s < e ? now >= s && now < e : now >= s || now < e;
}

export type CbtiResumeRule = 'keep_window' | 'rebaseline_3' | 'expired';

export function resumeRule(pauseDays: number): CbtiResumeRule {
  if (pauseDays <= PAUSE_KEEP_WINDOW_DAYS) return 'keep_window';
  if (pauseDays <= PAUSE_MAX_DAYS) return 'rebaseline_3';
  return 'expired';
}

/* ================================================================
   邀请与起床锚
   ================================================================ */

export interface CbtiInviteNight {
  nightDate: string;
  solMin?: number | null;
  wasoMin?: number | null;
  emaMin?: number | null;
}

export function isInviteEligible(input: {
  recentNights: CbtiInviteNight[];
  today: string;
  isAdult: boolean | null;
  lastExitDate: string | null;
  lastInviteDismissedDate: string | null;
}): boolean {
  if (input.isAdult === false) return false;
  if (input.lastExitDate && civilDaysBetween(input.lastExitDate, input.today) < 30) return false;
  if (input.lastInviteDismissedDate && civilDaysBetween(input.lastInviteDismissedDate, input.today) < 14) return false;
  const start = addCivilDays(input.today, -6);
  const nights = input.recentNights.filter((n) => n.nightDate >= start && n.nightDate <= input.today);
  const unique = new Map(nights.map((n) => [n.nightDate, n]));
  if (unique.size < 5) return false;
  const troubled = [...unique.values()].filter(
    (n) => (n.solMin ?? 0) >= 30 || (n.wasoMin ?? 0) >= 30 || (n.emaMin ?? 0) >= 30,
  );
  return troubled.length >= 3;
}

export function clampWakeAnchor(hm: string): string {
  const v = parseHm(hm);
  if (!Number.isFinite(v)) return '07:00';
  const rounded = roundTo15(v);
  return formatHm(Math.min(Math.max(rounded, parseHm(WAKE_ANCHOR_MIN)), parseHm(WAKE_ANCHOR_MAX)));
}

/** 起床锚默认值：近 7 天最常见的醒来时间，取整到 15 分钟；并列时取较晚者。 */
export function defaultWakeAnchor(wakeTimes: string[]): string {
  const counts = new Map<number, number>();
  for (const t of wakeTimes) {
    const v = parseHm(t);
    if (!Number.isFinite(v)) continue;
    const key = roundTo15(v);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  if (counts.size === 0) return '07:00';
  const [best] = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0]!;
  return clampWakeAnchor(formatHm(best));
}

/** 完成后复发信号：连续两周平均入睡用时都比前一周变慢（CB-FIN-05）。 */
export function isRelapseSignal(weeklyAvgSolMin: number[]): boolean {
  if (weeklyAvgSolMin.length < 3) return false;
  const [a, b, c] = weeklyAvgSolMin.slice(-3);
  return b! > a! && c! > b!;
}
