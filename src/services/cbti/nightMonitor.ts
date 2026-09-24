/**
 * 计划夜间监测：选设备 → 30 秒 epoch → 离床估计器 → 夜间事件、提醒推送、早晨预填。
 * 设计见 sleep-app-rn/docs/cbti-night-leave-bed-design.md 第 3–7 节。
 */
import { query } from '../../db/client.js';
import { addCivilDays, shanghaiHour, sleepDisplayNightDate, sleepNightDate, toDateOnly } from '../../utils/civilDate.js';
import { enqueuePush } from '../push.js';
import { listRealtimeSeries, purgeExpiredRadarSeries } from '../radar.js';
import {
  PLAN_TOTAL_DAYS,
  earliestBedFor,
  minutesToBucket,
  nightModeWindow,
  type CbtiBucket,
} from './engine.js';
import {
  EPOCH_MS,
  estimateNight,
  evaluateQualification,
  promptsAutoDisabled,
  soundThresholdFromFeedback,
  summarizeNight,
  type EstimatorEpoch,
  type EstimatorTier,
  type NightSummary,
  type PromptFeedback,
  type QualificationNight,
} from './leaveBedEstimator.js';
import {
  getFlags,
  listNightSummaries,
  loadLivePlan,
  planDayOf,
  purgeExpiredNightSummaries,
  saveNightSummary,
  updatePlan,
  type CbtiDevice,
  type NightProfile,
  type PlanRow,
} from './plans.js';

export const PROMPT_TEXT = '好像醒了一阵了，起来坐一会儿吧，困了再回来。';
const SOURCE_FRESH_MS = 3.5 * 60_000;
const DEVICE_CHECK_LEAD_MS = 60 * 60_000;
const PRIORITY: Record<CbtiDevice['kind'], number> = { cis_ib: 0, cis_iswb: 0, radar: 1, cis_ip: 2, wearable: 9 };
const IOT_KINDS = new Set(['cis_ib', 'cis_iswb', 'cis_ip']);

/* ================================================================
   时间
   ================================================================ */

export function shanghaiInstant(date: string, hm: string): number {
  return Date.parse(`${date}T${hm}:00+08:00`);
}

export function shanghaiHm(ms: number): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(ms));
}

/** 起床日 nightDate 这一夜的夜间模式起止时刻。 */
export function nightWindowInstants(row: PlanRow, nightDate: string): { startMs: number; endMs: number; start: string; end: string } {
  const earliest = row.track === 'full' && row.prescribed_tib_min ? earliestBedFor(row.wake_anchor, row.prescribed_tib_min) : null;
  const win = nightModeWindow({
    track: row.track,
    status: row.status,
    wakeAnchor: row.wake_anchor,
    earliestBedTime: earliest,
    baselineBedTime: row.baseline_bed_time,
  });
  const endMs = shanghaiInstant(nightDate, win.end);
  let startMs = shanghaiInstant(nightDate, win.start);
  if (startMs >= endMs) startMs = shanghaiInstant(addCivilDays(nightDate, -1), win.start);
  return { startMs, endMs, ...win };
}

function nightRange(nightDate: string): { fromMs: number; toMs: number } {
  return { fromMs: shanghaiInstant(addCivilDays(nightDate, -1), '12:00'), toMs: shanghaiInstant(nightDate, '12:00') };
}

/* ================================================================
   设备 epoch
   ================================================================ */

function tierOf(device: CbtiDevice): EstimatorTier {
  return device.kind === 'cis_ip' ? 'pillow' : 'bed';
}

async function ownsIotDevice(userId: string, sn: string): Promise<boolean> {
  const { rows } = await query<{ user_id: string }>(`SELECT user_id FROM iot_device_bindings WHERE sn = $1`, [sn]);
  return rows.some((r) => r.user_id === userId);
}

export async function loadDeviceEpochs(userId: string, device: CbtiDevice, fromMs: number, toMs: number): Promise<EstimatorEpoch[]> {
  if (IOT_KINDS.has(device.kind)) {
    if (!(await ownsIotDevice(userId, device.id))) return [];
    const { rows } = await query<{ epoch_start: Date | string; sample_count: number; in_bed_ratio: number; motion: number; hr_mean: number | null; hr_std: number | null; br_std: number | null; quality: string }>(
      `SELECT epoch_start, sample_count, in_bed_ratio, motion, hr_mean, hr_std, br_std, quality
       FROM iot_sleep_epochs WHERE sn = $1 AND epoch_start >= $2 AND epoch_start < $3
       ORDER BY epoch_start ASC LIMIT 3000`,
      [device.id, new Date(fromMs), new Date(toMs)],
    );
    return rows.map((r) => {
      const usable = Number(r.sample_count) > 0 && r.quality !== 'low';
      const hr = r.hr_mean == null || Number(r.hr_mean) <= 0 ? null : Number(r.hr_mean);
      return {
        startMs: new Date(r.epoch_start).getTime(),
        inBed: usable ? Number(r.in_bed_ratio) >= 0.8 : null,
        motion: usable ? Number(r.motion) : null,
        hrMean: hr,
        hrStd: hr == null || r.hr_std == null ? null : Number(r.hr_std),
        brStd: hr == null || r.br_std == null ? null : Number(r.br_std),
      };
    });
  }
  if (device.kind === 'radar') {
    const series = await listRealtimeSeries(device.id, fromMs, toMs, device.radarNumber);
    return series.map((s) => ({
      startMs: s.startMs,
      inBed: s.inBed,
      motion: null,
      hrMean: s.hrMean,
      hrStd: s.hrStd,
      brStd: s.rrStd,
    }));
  }
  return [];
}

interface SourcePick {
  device: CbtiDevice;
  tier: EstimatorTier;
  epochs: EstimatorEpoch[];
  fresh: boolean;
}

/** 第 4.2 节：按优先级选在床主来源，主来源 3 分钟没数据就换下一台。 */
export async function pickSource(userId: string, devices: CbtiDevice[], fromMs: number, nowMs: number): Promise<SourcePick | null> {
  const candidates = devices.filter((d) => d.kind !== 'wearable').sort((a, b) => PRIORITY[a.kind] - PRIORITY[b.kind]);
  let fallback: SourcePick | null = null;
  for (const device of candidates) {
    const epochs = await loadDeviceEpochs(userId, device, fromMs, nowMs);
    if (!epochs.length) continue;
    const last = epochs[epochs.length - 1]!;
    const pick = { device, tier: tierOf(device), epochs, fresh: nowMs - (last.startMs + EPOCH_MS) <= SOURCE_FRESH_MS };
    if (pick.fresh) return pick;
    if (!fallback || epochs.length > fallback.epochs.length) fallback = pick;
  }
  return fallback;
}

function singleZoneSharedBed(device: CbtiDevice): boolean {
  // 现有 epoch 聚合不分左右侧；只有双雷达（指定 radarNumber）能分人
  if (!device.sharedBed) return false;
  return !(device.kind === 'radar' && device.radarNumber != null);
}

/* ================================================================
   夜间事件
   ================================================================ */

interface EventRow {
  event_id: string;
  kind: string;
  occurred_at: Date | string;
  source: string;
  payload_json: Record<string, unknown>;
}

async function loadNightEvents(planId: string, nightDate: string): Promise<EventRow[]> {
  const { rows } = await query<EventRow>(
    `SELECT event_id, kind, occurred_at, source, payload_json FROM cbti_night_events
     WHERE plan_id = $1 AND night_date = $2 ORDER BY occurred_at ASC`,
    [planId, nightDate],
  );
  return rows;
}

async function insertEvent(row: PlanRow, e: { eventId: string; nightDate: string; kind: string; atMs: number; source: string; deviceSn?: string | null; confidence?: number | null; payload?: Record<string, unknown> }): Promise<boolean> {
  const res = await query(
    `INSERT INTO cbti_night_events (user_id, plan_id, event_id, night_date, kind, occurred_at, source, device_sn, confidence, payload_json)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (user_id, event_id) DO NOTHING`,
    [row.user_id, row.id, e.eventId, e.nightDate, e.kind, new Date(e.atMs), e.source, e.deviceSn ?? null, e.confidence ?? null, JSON.stringify(e.payload ?? {})],
  );
  return (res.rowCount ?? 0) > 0;
}

function atMs(e: EventRow): number {
  return new Date(e.occurred_at).getTime();
}

/* ================================================================
   夜间估计
   ================================================================ */

export interface NightStatus {
  nightDate: string;
  inWindow: boolean;
  window: { start: string; end: string };
  source: { deviceId: string; kind: CbtiDevice['kind']; tier: EstimatorTier; fresh: boolean } | null;
  state: 'in_bed' | 'out_of_bed' | 'unknown';
  userOutByButton: boolean;
  prompt: { eventId: string; level: 'silent' | 'sound'; atMs: number } | null;
  promptsEnabled: boolean;
  shadow: boolean;
  blockedBy: string | null;
}

function promptsActive(row: PlanRow, flags: { leaveBedPromptsOff: boolean }): boolean {
  const p = row.night_profile_json ?? {};
  return !flags.leaveBedPromptsOff && !p.promptsOff && !p.autoDisabled;
}

export async function evaluatePlanNight(row: PlanRow, now = new Date()): Promise<NightStatus> {
  const flags = await getFlags();
  const nightDate = sleepNightDate(now);
  const win = nightWindowInstants(row, nightDate);
  const nowMs = now.getTime();
  const inWindow = nowMs >= win.startMs && nowMs < win.endMs;
  const profile: NightProfile = row.night_profile_json ?? {};
  const shadow = row.status === 'baseline';
  const base: NightStatus = {
    nightDate,
    inWindow,
    window: { start: win.start, end: win.end },
    source: null,
    state: 'unknown',
    userOutByButton: false,
    prompt: null,
    promptsEnabled: promptsActive(row, flags) && !shadow && (profile.qualified ?? false),
    shadow,
    blockedBy: null,
  };
  const live = row.status === 'baseline' || row.status === 'active';
  if (!live || row.mode_disabled || flags.modeKillSwitch) return { ...base, blockedBy: 'plan_mode_off' };

  const events = await loadNightEvents(row.id, nightDate);
  const buttons = events.filter((e) => e.source === 'button' && (e.kind === 'leave_bed' || e.kind === 'return_bed'));
  const userOutByButton = buttons.length > 0 && buttons[buttons.length - 1]!.kind === 'leave_bed';
  const promptEvents = events.filter((e) => e.kind === 'prompt_silent' || e.kind === 'prompt_sound');
  const latestPrompt = [...promptEvents].reverse().find((e) => !e.payload_json?.shadow);
  const status: NightStatus = {
    ...base,
    userOutByButton,
    prompt: latestPrompt
      ? { eventId: latestPrompt.event_id, level: latestPrompt.kind === 'prompt_sound' ? 'sound' : 'silent', atMs: atMs(latestPrompt) }
      : null,
  };
  if (!inWindow) return { ...status, blockedBy: 'outside_window' };

  const devices = (row.devices_json ?? []) as CbtiDevice[];
  const pick = await pickSource(row.user_id, devices, win.startMs - 60 * 60_000, nowMs);
  if (!pick) return { ...status, blockedBy: 'no_device_data' };

  const last = pick.epochs[pick.epochs.length - 1]!;
  const lagMs = nowMs - (last.startMs + EPOCH_MS);
  const evalNowMs = lagMs <= 150_000 ? last.startMs + EPOCH_MS : nowMs;
  const result = estimateNight(pick.epochs, {
    tier: pick.tier,
    nowMs: evalNowMs,
    wakeAnchorMs: win.endMs,
    sleepHrBaseline: profile.sleepHrBaseline ?? null,
    preLightsMin: 0,
    flipLatencyMs: pick.device.flipLatencyMs ?? 0,
    qualified: profile.qualified ?? false,
    shadow,
    soundAllowed: profile.soundAllowed ?? true,
    soundThresholdMin: profile.soundThresholdMin ?? 20,
    singleZoneSharedBed: singleZoneSharedBed(pick.device),
    promptsOff: !promptsActive(row, flags),
    appForegroundAtMs: events.filter((e) => e.kind === 'app_foreground').map(atMs),
    priorPrompts: promptEvents.map((e) => ({ level: e.kind === 'prompt_sound' ? 'sound' as const : 'silent' as const, atMs: atMs(e) })),
    userOutByButton,
  });

  for (const t of result.transitions) {
    if (t.atMs < win.startMs - 60 * 60_000) continue;
    await insertEvent(row, {
      eventId: `dev:${pick.device.id}:${t.kind}:${t.atMs}`,
      nightDate,
      kind: t.kind,
      atMs: t.atMs,
      source: 'device',
      deviceSn: pick.device.id,
      confidence: pick.tier === 'pillow' ? 0.6 : 0.9,
      payload: { tier: pick.tier },
    });
  }

  const level = result.prompt ?? result.shadowPrompt;
  let prompt = status.prompt;
  if (level && result.inBedSinceMs != null) {
    const eventId = `prompt:${row.id}:${nightDate}:${result.inBedSinceMs}`;
    const inserted = await insertEvent(row, {
      eventId,
      nightDate,
      kind: level === 'sound' ? 'prompt_sound' : 'prompt_silent',
      atMs: nowMs,
      source: 'server',
      deviceSn: pick.device.id,
      payload: {
        shadow: result.prompt == null,
        lowerBoundAwakeMin: result.lowerBoundAwakeMin,
        expectedAwakeMin: result.expectedAwakeMin,
        cues: result.cues,
      },
    });
    if (inserted && result.prompt) {
      await enqueuePush({
        userId: row.user_id,
        title: '小眠',
        body: PROMPT_TEXT,
        category: level === 'sound' ? 'leave_bed_sound' : 'leave_bed_silent',
        eventId,
        expiresAt: new Date(nowMs + 60_000),
        data: { type: 'cbti_leave_bed_prompt', nightDate, level },
      });
      prompt = { eventId, level, atMs: nowMs };
    }
  }

  return {
    ...status,
    source: { deviceId: pick.device.id, kind: pick.device.kind, tier: pick.tier, fresh: pick.fresh },
    state: userOutByButton ? 'out_of_bed' : result.state,
    prompt,
    blockedBy: result.blockedBy,
  };
}

export async function getNightStatus(userId: string, now = new Date()): Promise<NightStatus | null> {
  const row = await loadLivePlan(userId);
  if (!row) return null;
  return evaluatePlanNight(row, now);
}

/* ================================================================
   每晚自检（第 3.2 节）
   ================================================================ */

export async function runDeviceCheck(row: PlanRow, now = new Date()): Promise<{ ran: boolean; passed?: boolean }> {
  const nightDate = sleepNightDate(now);
  const win = nightWindowInstants(row, nightDate);
  const nowMs = now.getTime();
  if (nowMs < win.startMs - DEVICE_CHECK_LEAD_MS || nowMs >= win.startMs) return { ran: false };
  const devices = ((row.devices_json ?? []) as CbtiDevice[]).filter((d) => d.kind !== 'wearable');
  if (!devices.length) return { ran: false };
  const eventId = `devcheck:${row.id}:${nightDate}`;
  const existing = await query(`SELECT 1 FROM cbti_night_events WHERE user_id = $1 AND event_id = $2`, [row.user_id, eventId]);
  if (existing.rows.length) return { ran: false };

  const results: Array<{ deviceId: string; kind: string; online: boolean; complete: boolean }> = [];
  for (const device of devices) {
    const epochs = await loadDeviceEpochs(row.user_id, device, nowMs - 30 * 60_000, nowMs);
    const last = epochs[epochs.length - 1];
    const online = last != null && nowMs - (last.startMs + EPOCH_MS) <= 5 * 60_000;
    const complete = epochs.length >= 54 && epochs.filter((e) => e.inBed != null).length / Math.max(1, epochs.length) >= 0.9;
    results.push({ deviceId: device.id, kind: device.kind, online, complete });
  }
  const passed = results.some((r) => r.online && r.complete);
  await insertEvent(row, { eventId, nightDate, kind: 'device_check', atMs: nowMs, source: 'server', payload: { passed, results } });
  if (!passed) {
    const name = devices[0]!.kind === 'radar' ? '生物雷达' : devices[0]!.kind === 'cis_ip' ? '智能枕' : '床垫';
    await enqueuePush({
      userId: row.user_id,
      title: '小眠',
      body: `${name}今晚没连上，今晚夜里用手机按钮记录起床和回床`,
      category: 'device_check',
      eventId: `${eventId}:push`,
      data: { type: 'cbti_device_check', nightDate, open: 'devices' },
    });
  }
  return { ran: true, passed };
}

/* ================================================================
   早晨夜摘要与预填（第 5.5 节、CB-DEV-09）
   ================================================================ */

function planEndDate(row: PlanRow): string {
  return addCivilDays(toDateOnly(row.start_date)!, PLAN_TOTAL_DAYS + row.paused_days_total);
}

export async function summarizePlanNight(row: PlanRow, nightDate: string, persist = true, final = false): Promise<{ device: CbtiDevice; tier: EstimatorTier; summary: NightSummary } | null> {
  const { fromMs, toMs } = nightRange(nightDate);
  const devices = ((row.devices_json ?? []) as CbtiDevice[]).filter((d) => d.kind !== 'wearable').sort((a, b) => PRIORITY[a.kind] - PRIORITY[b.kind]);
  let best: { device: CbtiDevice; tier: EstimatorTier; epochs: EstimatorEpoch[] } | null = null;
  for (const device of devices) {
    const epochs = await loadDeviceEpochs(row.user_id, device, fromMs, toMs);
    if (epochs.filter((e) => e.inBed === true).length < 20) continue;
    if (!best || PRIORITY[device.kind] < PRIORITY[best.device.kind]) best = { device, tier: tierOf(device), epochs };
  }
  if (!best) return null;
  const profile = row.night_profile_json ?? {};
  const summary = summarizeNight(best.epochs, profile.sleepHrBaseline ?? null, best.device.flipLatencyMs ?? 0, best.tier);
  if (persist) {
    await saveNightSummary({
      userId: row.user_id,
      planId: row.id,
      nightDate,
      deviceId: best.device.id,
      deviceKind: best.device.kind,
      tier: best.tier,
      summary: { ...summary, final } as unknown as Record<string, unknown>,
      baseline: { sleepHrMedian: summary.sleepHrMedian },
      planEndDate: planEndDate(row),
    });
  }
  return { device: best.device, tier: best.tier, summary };
}

export interface NightPrefill {
  nightDate: string;
  available: boolean;
  tier: EstimatorTier | null;
  deviceKind: CbtiDevice['kind'] | null;
  lowConfidence: boolean;
  bedTime: string | null;
  wakeTime: string | null;
  leaveCount: number | null;
  solBucket: CbtiBucket | null;
  wasoBucket: CbtiBucket | null;
  coverage: number | null;
  soundPromptsToReview: Array<{ eventId: string; atHm: string }>;
}

export async function getNightPrefill(userId: string, nightDate: string): Promise<NightPrefill | null> {
  const row = await loadLivePlan(userId);
  if (!row) return null;
  const events = await loadNightEvents(row.id, nightDate);
  const feedbackFor = new Set(events.filter((e) => e.kind === 'prompt_feedback').map((e) => String(e.payload_json?.promptEventId ?? '')));
  const soundPromptsToReview = events
    .filter((e) => e.kind === 'prompt_sound' && !e.payload_json?.shadow && !feedbackFor.has(e.event_id))
    .map((e) => ({ eventId: e.event_id, atHm: shanghaiHm(atMs(e)) }));
  const buttonLeaves = events.filter((e) => e.source === 'button' && e.kind === 'leave_bed').length;

  const result = await summarizePlanNight(row, nightDate, true, Date.now() >= nightRange(nightDate).toMs);
  if (!result) {
    return {
      nightDate, available: false, tier: null, deviceKind: null, lowConfidence: true,
      bedTime: null, wakeTime: null, leaveCount: buttonLeaves || null, solBucket: null, wasoBucket: null, coverage: null,
      soundPromptsToReview,
    };
  }
  const { summary, tier, device } = result;
  const covered = summary.coverage >= 0.9;
  return {
    nightDate,
    available: true,
    tier,
    deviceKind: device.kind,
    lowConfidence: tier === 'pillow' || singleZoneSharedBed(device) || !covered,
    bedTime: summary.inBedStartMs == null ? null : shanghaiHm(summary.inBedStartMs),
    wakeTime: summary.finalOutMs == null ? null : shanghaiHm(summary.finalOutMs),
    leaveCount: Math.max(summary.leaveCount, buttonLeaves),
    solBucket: covered && summary.estSolMin != null ? minutesToBucket(summary.estSolMin) : null,
    wasoBucket: covered && summary.estWasoMin != null ? minutesToBucket(summary.estWasoMin) : null,
    coverage: summary.coverage,
    soundPromptsToReview,
  };
}

/* ================================================================
   个人资格、心率基线与阈值（第 5.4、7.2、7.4 节）
   ================================================================ */

function median(values: number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

export async function refreshNightProfile(row: PlanRow, today = sleepDisplayNightDate()): Promise<NightProfile> {
  const start = toDateOnly(row.start_date)!;
  const baselineEndDay = row.active_since_day ?? planDayOf(row, today);
  const baselineEnd = addCivilDays(start, Math.max(0, baselineEndDay - 1));
  const summaries = await listNightSummaries(row.user_id, start);
  const baselineSummaries = summaries.filter((s) => s.nightDate <= baselineEnd);
  const hrValues = baselineSummaries
    .map((s) => (s.summary as { sleepHrMedian?: number | null }).sleepHrMedian)
    .filter((v): v is number => typeof v === 'number');
  const profile: NightProfile = { ...(row.night_profile_json ?? {}) };
  profile.sleepHrBaseline = hrValues.length >= 3 ? median(hrValues) : null;

  if (row.status === 'active' && profile.qualified == null) {
    const { rows: diaries } = await query<{ night_date: Date | string; sol_min: number | null; waso_min: number | null; leave_count: number | null }>(
      `SELECT night_date, sol_min, waso_min, leave_count FROM cbti_diary_entries WHERE plan_id = $1 AND night_date <= $2`,
      [row.id, baselineEnd],
    );
    const diaryBy = new Map(diaries.map((d) => [toDateOnly(d.night_date)!, d]));
    const nights: QualificationNight[] = baselineSummaries
      .filter((s) => s.tier === 'bed')
      .map((s) => {
        const sum = s.summary as unknown as NightSummary;
        const d = diaryBy.get(s.nightDate);
        return {
          coverage: sum.coverage,
          deviceLeaveCount: sum.leaveCount,
          diaryLeaveCount: d?.leave_count ?? null,
          deviceSolMin: sum.estSolMin,
          diarySolMin: d?.sol_min ?? null,
          deviceWasoMin: sum.estWasoMin,
          diaryWasoMin: d?.waso_min ?? null,
        };
      });
    const q = evaluateQualification(nights);
    profile.qualified = q.qualified && profile.sleepHrBaseline != null;
    profile.qualificationReason = q.qualified && profile.sleepHrBaseline == null ? 'hr_baseline' : q.reason;
    profile.evaluatedOn = today;
  }

  const { rows: feedback } = await query<{ occurred_at: Date | string; payload_json: { feedback?: PromptFeedback } }>(
    `SELECT occurred_at, payload_json FROM cbti_night_events WHERE plan_id = $1 AND kind = 'prompt_feedback' ORDER BY occurred_at ASC`,
    [row.id],
  );
  const history = feedback.map((f) => f.payload_json?.feedback).filter((f): f is PromptFeedback => f === 'accurate' || f === 'was_asleep' || f === 'not_noticed');
  profile.soundThresholdMin = soundThresholdFromFeedback(history);
  const weekly = new Map<number, { accurate: number; total: number }>();
  for (const f of feedback) {
    const fb = f.payload_json?.feedback;
    if (fb !== 'accurate' && fb !== 'was_asleep') continue;
    const week = Math.floor(new Date(f.occurred_at).getTime() / (7 * 86_400_000));
    const w = weekly.get(week) ?? { accurate: 0, total: 0 };
    w.total += 1;
    if (fb === 'accurate') w.accurate += 1;
    weekly.set(week, w);
  }
  profile.autoDisabled = profile.autoDisabled || promptsAutoDisabled([...weekly.entries()].sort((a, b) => a[0] - b[0]).map(([, w]) => w));

  await updatePlan(query, row.id, { night_profile_json: JSON.stringify(profile) });
  return profile;
}

/* ================================================================
   后台循环
   ================================================================ */

async function listMonitoredPlans(): Promise<PlanRow[]> {
  const { rows } = await query<PlanRow>(
    `SELECT * FROM cbti_plans
     WHERE status IN ('baseline', 'active') AND mode_disabled = FALSE
       AND jsonb_array_length(devices_json) > 0`,
  );
  return rows;
}

export async function runNightTick(now = new Date()): Promise<{ plans: number; prompts: number }> {
  const flags = await getFlags();
  if (flags.modeKillSwitch) return { plans: 0, prompts: 0 };
  const plans = await listMonitoredPlans();
  let prompts = 0;
  for (const row of plans) {
    try {
      await runDeviceCheck(row, now);
      const status = await evaluatePlanNight(row, now);
      if (status.prompt && status.prompt.atMs === now.getTime()) prompts += 1;
    } catch (err) {
      console.error('[cbti-night] plan tick failed', row.id, err instanceof Error ? err.message : err);
    }
  }
  return { plans: plans.length, prompts };
}

export async function runMorningMaintenance(now = new Date()): Promise<{ summarized: number }> {
  const closedNight = sleepDisplayNightDate(now);
  const afterCutoff = shanghaiHour(now) >= 12;
  const { rows } = await query<PlanRow>(
    `SELECT * FROM cbti_plans WHERE status IN ('baseline', 'active', 'paused') AND jsonb_array_length(devices_json) > 0`,
  );
  let summarized = 0;
  for (const row of rows) {
    try {
      if (afterCutoff) {
        const have = await query(
          `SELECT 1 FROM cbti_night_summaries WHERE user_id = $1 AND night_date = $2 AND summary_json->>'final' = 'true'`,
          [row.user_id, closedNight],
        );
        if (!have.rows.length && (await summarizePlanNight(row, closedNight, true, true))) summarized += 1;
      }
      await refreshNightProfile(row, closedNight);
    } catch (err) {
      console.error('[cbti-night] morning maintenance failed', row.id, err instanceof Error ? err.message : err);
    }
  }
  await purgeExpiredNightSummaries();
  await purgeExpiredRadarSeries();
  return { summarized };
}

export function startCbtiNightLoop(): void {
  let nightRunning = false;
  let morningRunning = false;
  setInterval(() => {
    if (nightRunning) return;
    nightRunning = true;
    void runNightTick().catch((err) => console.error('[cbti-night]', err)).finally(() => { nightRunning = false; });
  }, EPOCH_MS);
  setInterval(() => {
    if (morningRunning) return;
    morningRunning = true;
    void runMorningMaintenance().catch((err) => console.error('[cbti-night] maintenance', err)).finally(() => { morningRunning = false; });
  }, 30 * 60_000);
}
