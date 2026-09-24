import { query, withTransaction, type SqlQuery } from '../../db/client.js';
import { addCivilDays as addDays, shanghaiToday, toDateOnly } from '../../utils/civilDate.js';
import { claimReward } from '../energyLedger.js';
import {
  CBTI_ENGINE_VERSION,
  PAUSE_MAX_DAYS,
  assignTrack,
  canRequestFullTrack,
  civilDaysBetween,
  clampWakeAnchor,
  completionDayFrom,
  dueSettlementDay,
  earliestBedFor,
  evaluateBaseline,
  evaluateScreening,
  initialWindow,
  isValidNight,
  periodStats,
  planDayIndex,
  planWeekIndex,
  resumeRule,
  rollingWindow,
  sameSettlement,
  scoreEss,
  scoreIsi,
  settleWeek,
  type CbtiComplaintFrequency,
  type CbtiDiaryCore,
  type CbtiPlanStatus,
  type CbtiSafetyItem,
  type CbtiSpecialReason,
  type CbtiTrack,
} from './engine.js';

export const CBTI_CONSENT_VERSION = 'cbti-consent-2026-09';
export const REQUIRED_CONSENT_ITEMS = ['sleepy', 'not_medical', 'health_data'] as const;
export const DIARY_BACKFILL_DAYS = 2;
export const DIARY_ENERGY = 10;
export const ADHERENCE_WEEK_ENERGY = 60;
export const NIGHT_SUMMARY_RETAIN_DAYS = 90;

export class CbtiError extends Error {
  constructor(public code: string, public status: 400 | 403 | 404 | 409 | 422 = 400) {
    super(code);
  }
}

export interface CbtiDevice {
  kind: 'radar' | 'cis_ib' | 'cis_iswb' | 'cis_ip' | 'wearable';
  id: string;
  side?: 'left' | 'right' | 'center';
  sharedBed?: boolean;
  /** 双雷达时区分床区 */
  radarNumber?: number;
  /** 入组躺下测试测得的在床翻转延迟 */
  flipLatencyMs?: number;
}

export interface NightProfile {
  qualified?: boolean;
  qualificationReason?: string | null;
  evaluatedOn?: string;
  sleepHrBaseline?: number | null;
  soundThresholdMin?: number;
  autoDisabled?: boolean;
  /** 用户设置：只要静默提醒 */
  soundAllowed?: boolean;
  /** 用户设置：关闭夜间离床提醒 */
  promptsOff?: boolean;
}

export interface PlanRow {
  id: string;
  user_id: string;
  status: Exclude<CbtiPlanStatus, 'intro'>;
  track: CbtiTrack;
  track_reason: string | null;
  start_date: string | Date;
  wake_anchor: string;
  pending_wake_anchor: string | null;
  wake_anchor_changed_on: string | Date | null;
  pending_track: 'full' | 'gentle' | null;
  prescribed_tib_min: number | null;
  baseline_tib_min: number | null;
  baseline_tst_min: number | null;
  baseline_se: number | null;
  baseline_bed_time: string | null;
  safety_flags: string[];
  devices_json: CbtiDevice[];
  intake_json: Record<string, unknown>;
  isi_baseline: number | null;
  isi_final: number | null;
  ess_baseline: number | null;
  paused_at: string | Date | null;
  paused_from_status: string | null;
  paused_days_total: number;
  rebaseline_until: string | Date | null;
  active_since_day: number | null;
  exit_reason: string | null;
  exited_at: string | Date | null;
  completed_at: string | Date | null;
  consent_version: string;
  engine_version: string;
  mode_disabled: boolean;
  night_profile_json: NightProfile;
  version: number;
  updated_at: string | Date;
}

function dateOnly(value: string | Date | null | undefined): string | null {
  if (value == null) return null;
  if (typeof value === 'string') return value.slice(0, 10);
  return shanghaiToday(value);
}

const pgDate = toDateOnly;

/** 计划日按传入的 today 推进；today 就是今天时用真实时刻，否则取那天上海正午。 */
function instantOn(today: string): Date {
  return today === shanghaiToday() ? new Date() : new Date(`${today}T12:00:00+08:00`);
}

function currentPauseDays(row: PlanRow, today: string): number {
  if (row.status !== 'paused' || !row.paused_at) return 0;
  return Math.max(0, civilDaysBetween(dateOnly(row.paused_at)!, today));
}

export function planDayOf(row: PlanRow, today = shanghaiToday()): number {
  return planDayIndex(pgDate(row.start_date)!, today, row.paused_days_total + currentPauseDays(row, today));
}

export async function getFlags(): Promise<{ modeKillSwitch: boolean; leaveBedPromptsOff: boolean }> {
  const { rows } = await query<{ key: string; enabled: boolean }>(`SELECT key, enabled FROM cbti_flags`);
  const map = new Map(rows.map((r) => [r.key, r.enabled]));
  return {
    modeKillSwitch: map.get('mode_kill_switch') ?? false,
    leaveBedPromptsOff: map.get('leave_bed_prompts_off') ?? false,
  };
}

export async function setFlag(key: 'mode_kill_switch' | 'leave_bed_prompts_off', enabled: boolean): Promise<void> {
  await query(
    `INSERT INTO cbti_flags (key, enabled, updated_at) VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = NOW()`,
    [key, enabled],
  );
}

export function serializePlan(row: PlanRow, flags: { modeKillSwitch: boolean }, today = shanghaiToday()) {
  const planDay = planDayOf(row, today);
  const earliestBedTime = row.track === 'full' && row.prescribed_tib_min
    ? earliestBedFor(row.wake_anchor, row.prescribed_tib_min)
    : null;
  return {
    planId: row.id,
    status: row.status,
    track: row.track,
    trackReason: row.track_reason,
    startDate: pgDate(row.start_date),
    wakeAnchor: row.wake_anchor,
    pendingWakeAnchor: row.pending_wake_anchor,
    pendingTrack: row.pending_track,
    prescribedTibMin: row.prescribed_tib_min,
    earliestBedTime,
    baselineTibMin: row.baseline_tib_min,
    baselineTstMin: row.baseline_tst_min,
    baselineSe: row.baseline_se,
    baselineBedTime: row.baseline_bed_time,
    safetyFlags: row.safety_flags ?? [],
    devices: row.devices_json ?? [],
    isiBaseline: row.isi_baseline,
    isiFinal: row.isi_final,
    essBaseline: row.ess_baseline,
    pausedAt: row.paused_at ? new Date(row.paused_at).toISOString() : null,
    pausedDaysTotal: row.paused_days_total,
    rebaselineUntil: pgDate(row.rebaseline_until),
    activeSinceDay: row.active_since_day,
    exitReason: row.exit_reason,
    consentVersion: row.consent_version,
    engineVersion: row.engine_version,
    modeDisabled: row.mode_disabled || flags.modeKillSwitch,
    nightPrefs: {
      soundAllowed: row.night_profile_json?.soundAllowed ?? true,
      promptsOff: row.night_profile_json?.promptsOff ?? false,
      promptsQualified: row.night_profile_json?.qualified ?? false,
      promptsAutoDisabled: row.night_profile_json?.autoDisabled ?? false,
    },
    planDay,
    planWeek: planWeekIndex(planDay),
    version: row.version,
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

export type CbtiPlanDto = ReturnType<typeof serializePlan>;

export async function loadLivePlan(userId: string, q: SqlQuery = query): Promise<PlanRow | null> {
  const { rows } = await q<PlanRow>(
    `SELECT * FROM cbti_plans WHERE user_id = $1 AND status <> 'exited' ORDER BY created_at DESC LIMIT 1`,
    [userId],
  );
  return rows[0] ?? null;
}

async function requireLivePlan(userId: string, q: SqlQuery = query): Promise<PlanRow> {
  const row = await loadLivePlan(userId, q);
  if (!row) throw new CbtiError('no_active_plan', 404);
  return row;
}

export async function updatePlan(q: SqlQuery, id: string, patch: Record<string, unknown>): Promise<PlanRow> {
  const keys = Object.keys(patch);
  const sets = keys.map((k, i) => `${k} = $${i + 2}`);
  const { rows } = await q<PlanRow>(
    `UPDATE cbti_plans SET ${sets.join(', ')}${sets.length ? ', ' : ''}version = version + 1, updated_at = NOW()
     WHERE id = $1 RETURNING *`,
    [id, ...keys.map((k) => patch[k])],
  );
  return rows[0]!;
}

/** 暂停超过 14 天自动结束（CB-MGT-01）。 */
async function expireStalePause(row: PlanRow, today: string): Promise<PlanRow | null> {
  if (row.status !== 'paused' || currentPauseDays(row, today) <= PAUSE_MAX_DAYS) return row;
  await updatePlan(query, row.id, { status: 'exited', exit_reason: 'pause_expired', exited_at: new Date() });
  return null;
}

export async function getCurrentPlan(userId: string, today = shanghaiToday()) {
  const flags = await getFlags();
  const loaded = await loadLivePlan(userId);
  const row = loaded ? await expireStalePause(loaded, today) : null;
  const lastExit = await query<{ exited_at: Date; exit_reason: string | null }>(
    `SELECT exited_at, exit_reason FROM cbti_plans
     WHERE user_id = $1 AND status = 'exited' ORDER BY exited_at DESC NULLS LAST LIMIT 1`,
    [userId],
  );
  const consent = await query<{ consent_version: string; created_at: Date; withdrawn_at: Date | null; archive_opt_in: boolean }>(
    `SELECT consent_version, created_at, withdrawn_at, archive_opt_in FROM cbti_consents
     WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [userId],
  );
  const lastSettlement = row
    ? (await query(
        `SELECT kind, plan_day, night_date, reason, old_tib_min, new_tib_min, earliest_bed_time, stats_json, created_at
         FROM cbti_settlements WHERE plan_id = $1 ORDER BY plan_day DESC LIMIT 1`,
        [row.id],
      )).rows[0] ?? null
    : null;
  const c = consent.rows[0];
  return {
    plan: row ? serializePlan(row, flags, today) : null,
    flags,
    currentConsentVersion: CBTI_CONSENT_VERSION,
    consent: c
      ? {
          version: c.consent_version,
          acceptedAt: new Date(c.created_at).toISOString(),
          withdrawnAt: c.withdrawn_at ? new Date(c.withdrawn_at).toISOString() : null,
          archiveOptIn: c.archive_opt_in,
          needsReconsent: c.consent_version !== CBTI_CONSENT_VERSION,
        }
      : null,
    lastExit: lastExit.rows[0]
      ? { exitedOn: shanghaiToday(new Date(lastExit.rows[0].exited_at)), reason: lastExit.rows[0].exit_reason }
      : null,
    lastSettlement: lastSettlement ? serializeSettlement(lastSettlement) : null,
  };
}

/* ================================================================
   加入
   ================================================================ */

export interface JoinInput {
  intake: {
    frequency: CbtiComplaintFrequency;
    duration: 'lt1m' | '1_3m' | 'gte3m';
    isAdult: boolean;
    safety: Partial<Record<CbtiSafetyItem, boolean>>;
  };
  consent: {
    version: string;
    items: Array<{ key: string; checkedAt: string }>;
    archiveOptIn: boolean;
    deviceInfo: Record<string, unknown>;
  };
  wakeAnchor: string;
  devices: CbtiDevice[];
}

export async function joinPlan(userId: string, input: JoinInput, today = shanghaiToday()) {
  const screening = evaluateScreening(input.intake);
  if (screening.kind === 'crisis') throw new CbtiError('crisis', 422);
  if (screening.kind === 'not_eligible') throw new CbtiError(`not_eligible_${screening.reason}`, 422);
  if (input.consent.version !== CBTI_CONSENT_VERSION) throw new CbtiError('consent_version_mismatch', 409);
  const checked = new Set(input.consent.items.map((i) => i.key));
  if (!REQUIRED_CONSENT_ITEMS.every((k) => checked.has(k))) throw new CbtiError('consent_incomplete', 422);

  const flags = await getFlags();
  const row = await withTransaction(async (q) => {
    if (await loadLivePlan(userId, q)) throw new CbtiError('plan_exists', 409);
    const { rows } = await q<PlanRow>(
      `INSERT INTO cbti_plans (
         user_id, status, track, start_date, wake_anchor, safety_flags, devices_json, intake_json,
         consent_version, engine_version
       ) VALUES ($1, 'baseline', 'none', $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [
        userId,
        today,
        clampWakeAnchor(input.wakeAnchor),
        screening.safetyFlags,
        JSON.stringify(input.devices ?? []),
        JSON.stringify({ frequency: input.intake.frequency, duration: input.intake.duration, forcedGentle: screening.forcedGentle }),
        CBTI_CONSENT_VERSION,
        CBTI_ENGINE_VERSION,
      ],
    );
    const plan = rows[0]!;
    await q(
      `INSERT INTO cbti_consents (user_id, plan_id, consent_version, items_json, archive_opt_in, device_info_json)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        userId,
        plan.id,
        CBTI_CONSENT_VERSION,
        JSON.stringify(input.consent.items),
        input.consent.archiveOptIn,
        JSON.stringify(input.consent.deviceInfo ?? {}),
      ],
    );
    return plan;
  });
  return { plan: serializePlan(row, flags, today), screening };
}

export async function withdrawConsent(userId: string): Promise<void> {
  await withTransaction(async (q) => {
    await q(
      `UPDATE cbti_consents SET withdrawn_at = NOW() WHERE user_id = $1 AND withdrawn_at IS NULL`,
      [userId],
    );
    const plan = await loadLivePlan(userId, q);
    if (plan) {
      await updatePlan(q, plan.id, { status: 'exited', exit_reason: 'consent_withdrawn', exited_at: new Date() });
    }
    await q(`DELETE FROM cbti_night_summaries WHERE user_id = $1`, [userId]);
  });
}

/* ================================================================
   日记
   ================================================================ */

interface DiaryRow {
  night_date: string | Date;
  bed_time: string | null;
  wake_time: string | null;
  pre_lights_min: number | null;
  sol_min: number | null;
  waso_min: number | null;
  ema_min: number | null;
  leave_count: number | null;
  input_mode_json: Record<string, string>;
  nap_min: number | null;
  caffeine: boolean | null;
  alcohol: boolean | null;
  sleepiness: number | null;
  special: CbtiSpecialReason | null;
  device_tier: string | null;
  device_estimates_json: Record<string, unknown> | null;
  edit_history_json: unknown[];
  client_updated_at: string | Date;
  updated_at: string | Date;
}

export interface DiaryInput {
  bedTime: string | null;
  wakeTime: string | null;
  preLightsMin?: number | null;
  solMin: number | null;
  wasoMin: number | null;
  emaMin: number | null;
  leaveCount?: number | null;
  inputMode?: Record<string, string>;
  napMin?: number | null;
  caffeine?: boolean | null;
  alcohol?: boolean | null;
  sleepiness?: number | null;
  special?: CbtiSpecialReason | null;
  deviceTier?: string | null;
  deviceEstimates?: Record<string, unknown> | null;
  clientUpdatedAt: string;
}

export function serializeDiary(row: DiaryRow) {
  return {
    nightDate: pgDate(row.night_date)!,
    bedTime: row.bed_time,
    wakeTime: row.wake_time,
    preLightsMin: row.pre_lights_min,
    solMin: row.sol_min,
    wasoMin: row.waso_min,
    emaMin: row.ema_min,
    leaveCount: row.leave_count,
    inputMode: row.input_mode_json ?? {},
    napMin: row.nap_min,
    caffeine: row.caffeine,
    alcohol: row.alcohol,
    sleepiness: row.sleepiness,
    special: row.special,
    deviceTier: row.device_tier,
    deviceEstimates: row.device_estimates_json,
    editCount: Array.isArray(row.edit_history_json) ? row.edit_history_json.length : 0,
    clientUpdatedAt: new Date(row.client_updated_at).toISOString(),
  };
}

function toCore(row: ReturnType<typeof serializeDiary>): CbtiDiaryCore {
  return {
    nightDate: row.nightDate,
    bedTime: row.bedTime,
    wakeTime: row.wakeTime,
    preLightsMin: row.preLightsMin,
    solMin: row.solMin,
    wasoMin: row.wasoMin,
    emaMin: row.emaMin,
    sleepiness: row.sleepiness,
    special: row.special,
  };
}

const DIARY_TRACKED_FIELDS = [
  'bed_time', 'wake_time', 'pre_lights_min', 'sol_min', 'waso_min', 'ema_min', 'leave_count',
  'nap_min', 'caffeine', 'alcohol', 'sleepiness', 'special',
] as const;

export async function upsertDiary(userId: string, nightDate: string, input: DiaryInput, today = shanghaiToday()) {
  const plan = await requireLivePlan(userId);
  const start = pgDate(plan.start_date)!;
  if (nightDate < start) throw new CbtiError('before_plan_start', 422);
  if (nightDate > today || nightDate < addDays(today, -DIARY_BACKFILL_DAYS)) {
    throw new CbtiError('outside_edit_window', 422);
  }
  const values = {
    bed_time: input.bedTime,
    wake_time: input.wakeTime,
    pre_lights_min: input.preLightsMin ?? null,
    sol_min: input.solMin,
    waso_min: input.wasoMin,
    ema_min: input.emaMin,
    leave_count: input.leaveCount ?? null,
    nap_min: input.napMin ?? null,
    caffeine: input.caffeine ?? null,
    alcohol: input.alcohol ?? null,
    sleepiness: input.sleepiness ?? null,
    special: input.special ?? null,
  };

  const result = await withTransaction(async (q) => {
    const existing = (await q<DiaryRow & Record<string, unknown>>(
      `SELECT * FROM cbti_diary_entries WHERE plan_id = $1 AND night_date = $2 FOR UPDATE`,
      [plan.id, nightDate],
    )).rows[0];
    if (existing && new Date(existing.client_updated_at).getTime() > new Date(input.clientUpdatedAt).getTime()) {
      return { row: existing as DiaryRow, conflict: true, created: false };
    }
    const history = Array.isArray(existing?.edit_history_json) ? [...existing!.edit_history_json] : [];
    if (existing) {
      const before: Record<string, unknown> = {};
      for (const field of DIARY_TRACKED_FIELDS) {
        if (existing[field] !== values[field]) before[field] = existing[field];
      }
      if (Object.keys(before).length) history.push({ at: new Date().toISOString(), before });
    }
    const { rows } = await q<DiaryRow>(
      `INSERT INTO cbti_diary_entries (
         plan_id, user_id, night_date, bed_time, wake_time, pre_lights_min, sol_min, waso_min, ema_min, leave_count,
         input_mode_json, nap_min, caffeine, alcohol, sleepiness, special, device_tier, device_estimates_json,
         edit_history_json, client_updated_at, updated_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,NOW())
       ON CONFLICT (plan_id, night_date) DO UPDATE SET
         bed_time = EXCLUDED.bed_time, wake_time = EXCLUDED.wake_time,
         pre_lights_min = EXCLUDED.pre_lights_min, sol_min = EXCLUDED.sol_min,
         waso_min = EXCLUDED.waso_min, ema_min = EXCLUDED.ema_min, leave_count = EXCLUDED.leave_count,
         input_mode_json = EXCLUDED.input_mode_json, nap_min = EXCLUDED.nap_min,
         caffeine = EXCLUDED.caffeine, alcohol = EXCLUDED.alcohol, sleepiness = EXCLUDED.sleepiness,
         special = EXCLUDED.special, device_tier = EXCLUDED.device_tier,
         device_estimates_json = EXCLUDED.device_estimates_json,
         edit_history_json = EXCLUDED.edit_history_json,
         client_updated_at = EXCLUDED.client_updated_at, updated_at = NOW()
       RETURNING *`,
      [
        plan.id, userId, nightDate,
        values.bed_time, values.wake_time, values.pre_lights_min, values.sol_min, values.waso_min, values.ema_min, values.leave_count,
        JSON.stringify(input.inputMode ?? {}), values.nap_min, values.caffeine, values.alcohol, values.sleepiness,
        values.special, input.deviceTier ?? null,
        input.deviceEstimates ? JSON.stringify(input.deviceEstimates) : null,
        JSON.stringify(history), input.clientUpdatedAt,
      ],
    );
    return { row: rows[0]!, conflict: false, created: !existing };
  });

  const entry = serializeDiary(result.row);
  let energyEarned = 0;
  if (!result.conflict && isValidNight(toCore(entry))) {
    try {
      const claim = await claimReward(userId, 'cbti_diary', `${plan.id}:${nightDate}`, DIARY_ENERGY, '睡眠日记');
      energyEarned = claim.earned;
    } catch (err) {
      console.warn('[cbti] diary energy claim failed', err instanceof Error ? err.message : err);
    }
  }
  return { entry, conflict: result.conflict, created: result.created, energyEarned };
}

export async function listDiary(userId: string, planId?: string) {
  const plan = planId ? { id: planId } : await requireLivePlan(userId);
  const { rows } = await query<DiaryRow>(
    `SELECT * FROM cbti_diary_entries WHERE plan_id = $1 AND user_id = $2 ORDER BY night_date ASC`,
    [plan.id, userId],
  );
  return rows.map(serializeDiary);
}

async function loadCoreEntries(planId: string, q: SqlQuery = query): Promise<CbtiDiaryCore[]> {
  const { rows } = await q<DiaryRow>(
    `SELECT * FROM cbti_diary_entries WHERE plan_id = $1 ORDER BY night_date ASC`,
    [planId],
  );
  return rows.map((r) => toCore(serializeDiary(r)));
}

/* ================================================================
   夜间事件与问卷
   ================================================================ */

export interface NightEventInput {
  eventId: string;
  nightDate: string;
  kind: 'leave_bed' | 'return_bed' | 'prompt_silent' | 'prompt_sound' | 'prompt_feedback' | 'night_chat' | 'device_check' | 'app_foreground';
  occurredAt: string;
  source: 'button' | 'device' | 'server' | 'app';
  deviceSn?: string | null;
  confidence?: number | null;
  payload?: Record<string, unknown>;
}

export async function recordNightEvents(userId: string, events: NightEventInput[]): Promise<number> {
  const plan = await requireLivePlan(userId);
  let inserted = 0;
  for (const e of events) {
    const res = await query(
      `INSERT INTO cbti_night_events (user_id, plan_id, event_id, night_date, kind, occurred_at, source, device_sn, confidence, payload_json)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (user_id, event_id) DO NOTHING`,
      [userId, plan.id, e.eventId, e.nightDate, e.kind, e.occurredAt, e.source, e.deviceSn ?? null, e.confidence ?? null, JSON.stringify(e.payload ?? {})],
    );
    inserted += res.rowCount ?? 0;
  }
  return inserted;
}

export async function listNightEvents(userId: string, nightDate: string) {
  const plan = await requireLivePlan(userId);
  const { rows } = await query<{ event_id: string; kind: string; occurred_at: Date; source: string; device_sn: string | null; confidence: number | null; payload_json: Record<string, unknown> }>(
    `SELECT event_id, kind, occurred_at, source, device_sn, confidence, payload_json
     FROM cbti_night_events WHERE plan_id = $1 AND night_date = $2 ORDER BY occurred_at ASC`,
    [plan.id, nightDate],
  );
  return rows.map((r) => ({
    eventId: r.event_id,
    kind: r.kind,
    occurredAt: new Date(r.occurred_at).toISOString(),
    source: r.source,
    deviceSn: r.device_sn,
    confidence: r.confidence,
    payload: r.payload_json,
  }));
}

export async function submitQuestionnaire(
  userId: string,
  input: { kind: 'isi' | 'ess'; phase: 'baseline' | 'final'; answers: number[] },
  today = shanghaiToday(),
) {
  const plan = await requireLivePlan(userId);
  const score = input.kind === 'isi' ? scoreIsi(input.answers) : scoreEss(input.answers);
  if (score == null) throw new CbtiError('invalid_answers', 422);
  await query(
    `INSERT INTO cbti_questionnaires (user_id, plan_id, kind, phase, answers, score)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (plan_id, kind, phase) DO UPDATE SET answers = EXCLUDED.answers, score = EXCLUDED.score, created_at = NOW()`,
    [userId, plan.id, input.kind, input.phase, input.answers, score],
  );
  const column = input.kind === 'ess' ? 'ess_baseline' : input.phase === 'final' ? 'isi_final' : 'isi_baseline';
  let row = await updatePlan(query, plan.id, { [column]: score });

  let assignment: ReturnType<typeof assignTrack> | null = null;
  if (row.status === 'baseline' && row.isi_baseline != null && row.ess_baseline != null) {
    assignment = await previewTrack(row, today);
    if (assignment.track === 'none') {
      row = await updatePlan(query, row.id, {
        status: 'exited', track: 'none', track_reason: assignment.reason, exit_reason: 'isi_low', exited_at: new Date(),
      });
    } else {
      row = await updatePlan(query, row.id, { track: assignment.track, track_reason: assignment.reason });
    }
  }
  if (input.phase === 'final' && input.kind === 'isi' && row.status === 'completed') {
    row = await updatePlan(query, row.id, { status: 'maintenance' });
  }
  const flags = await getFlags();
  return { score, assignment, plan: serializePlan(row, flags, today) };
}

async function previewTrack(row: PlanRow, today: string) {
  const entries = await loadCoreEntries(row.id);
  const baseline = evaluateBaseline(entries, pgDate(row.start_date)!, planDayOf(row, today), row.wake_anchor);
  return assignTrack({
    isi: row.isi_baseline ?? 0,
    ess: row.ess_baseline,
    safetyFlags: row.safety_flags ?? [],
    baselineAvgTstMin: baseline.validNights > 0 ? baseline.avgTstMin : null,
  });
}

/* ================================================================
   结算
   ================================================================ */

function serializeSettlement(row: Record<string, unknown>) {
  return {
    kind: row.kind as 'initial' | 'weekly' | 'gentle_review',
    planDay: row.plan_day as number,
    nightDate: pgDate(row.night_date as Date | string),
    reason: row.reason as string,
    oldTibMin: row.old_tib_min as number | null,
    newTibMin: row.new_tib_min as number | null,
    earliestBedTime: row.earliest_bed_time as string | null,
    stats: row.stats_json as Record<string, unknown>,
    createdAt: new Date(row.created_at as Date).toISOString(),
  };
}

export async function listSettlements(userId: string) {
  const plan = await requireLivePlan(userId);
  const { rows } = await query(
    `SELECT * FROM cbti_settlements WHERE plan_id = $1 ORDER BY plan_day ASC`,
    [plan.id],
  );
  return rows.map(serializeSettlement);
}

export interface ClientSettlement {
  planDay: number;
  reason: string;
  newTibMin: number | null;
}

/**
 * 推进到期的结算：基线结束（初始窗口 / 分轨）、每周结算、第 42 天完成。
 * 同一计划日只结算一次；客户端结果只用于比对，不一致时以服务端为准。
 */
export async function runDueSettlement(userId: string, client?: ClientSettlement | null, today = shanghaiToday()) {
  const settled = await settleInTransaction(userId, client ?? null, today);
  const adherenceClaim = 'adherenceClaim' in settled ? settled.adherenceClaim : null;
  const result = { outcome: settled.outcome, settlement: settled.settlement, plan: settled.plan };
  if (adherenceClaim) {
    try {
      await claimReward(userId, 'cbti_adherence_week', adherenceClaim, ADHERENCE_WEEK_ENERGY, '计划执行满 5 晚');
    } catch (err) {
      console.warn('[cbti] adherence energy claim failed', err instanceof Error ? err.message : err);
    }
  }
  return result;
}

async function settleInTransaction(userId: string, client: ClientSettlement | null, today: string) {
  const flags = await getFlags();
  return withTransaction(async (q) => {
    const row = await requireLivePlan(userId, q);
    const planDay = planDayOf(row, today);
    const entries = await loadCoreEntries(row.id, q);
    const settled = (await q<{ plan_day: number }>(
      `SELECT plan_day FROM cbti_settlements WHERE plan_id = $1`,
      [row.id],
    )).rows.map((r) => r.plan_day);

    const record = async (kind: string, reason: string, stats: unknown, server: Record<string, unknown>, oldTib: number | null, newTib: number | null, bed: string | null) => {
      const mismatch = client != null && client.planDay === planDay
        && !sameSettlement({ reason: client.reason as never, newTibMin: client.newTibMin ?? 0 }, { reason: reason as never, newTibMin: newTib ?? 0 });
      if (mismatch) console.warn('[cbti] settlement mismatch', { planId: row.id, planDay, client, server: { reason, newTib } });
      const { rows } = await q(
        `INSERT INTO cbti_settlements (plan_id, user_id, kind, plan_day, night_date, reason, old_tib_min, new_tib_min,
           earliest_bed_time, stats_json, client_result_json, server_result_json, mismatch, engine_version)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
         ON CONFLICT (plan_id, plan_day) DO NOTHING RETURNING *`,
        [row.id, userId, kind, planDay, today, reason, oldTib, newTib, bed, JSON.stringify(stats),
          client ? JSON.stringify(client) : null, JSON.stringify(server), mismatch, CBTI_ENGINE_VERSION],
      );
      return rows[0] ? { ...serializeSettlement(rows[0]), mismatch } : null;
    };

    if (row.status === 'baseline') {
      const baseline = evaluateBaseline(entries, pgDate(row.start_date)!, planDay, row.wake_anchor);
      if (baseline.status !== 'ready') {
        return { outcome: baseline.status, settlement: null, plan: serializePlan(row, flags, today) };
      }
      const assignment = assignTrack({
        isi: row.isi_baseline ?? 0,
        ess: row.ess_baseline,
        safetyFlags: row.safety_flags ?? [],
        baselineAvgTstMin: baseline.avgTstMin,
      });
      if (row.isi_baseline == null) {
        return { outcome: 'awaiting_questionnaire', settlement: null, plan: serializePlan(row, flags, today) };
      }
      const baselineFields = {
        baseline_tib_min: Math.round(baseline.avgTibMin),
        baseline_tst_min: Math.round(baseline.avgTstMin),
        baseline_se: baseline.se,
        baseline_bed_time: baseline.avgBedTime,
        active_since_day: planDay,
      };
      if (assignment.track === 'none') {
        const next = await updatePlan(q, row.id, { ...baselineFields, status: 'exited', track: 'none', track_reason: assignment.reason, exit_reason: 'isi_low', exited_at: new Date() });
        return { outcome: 'not_eligible', settlement: null, plan: serializePlan(next, flags, today) };
      }
      if (assignment.track === 'full') {
        const win = initialWindow({
          baselineAvgTstMin: baseline.avgTstMin,
          baselineAvgTibMin: baseline.avgTibMin,
          baselineSe: baseline.se,
          wakeAnchor: row.wake_anchor,
        });
        const settlement = await record('initial', win.reason, baseline, { ...win, assignment }, null, win.prescribedTibMin, win.earliestBedTime);
        const next = await updatePlan(q, row.id, { ...baselineFields, status: 'active', track: 'full', track_reason: assignment.reason, prescribed_tib_min: win.prescribedTibMin });
        return { outcome: 'initial_window', settlement, plan: serializePlan(next, flags, today) };
      }
      const settlement = await record('initial', assignment.reason, baseline, { assignment }, null, null, null);
      const next = await updatePlan(q, row.id, { ...baselineFields, status: 'active', track: 'gentle', track_reason: assignment.reason });
      return { outcome: 'gentle_start', settlement, plan: serializePlan(next, flags, today) };
    }

    if (row.status !== 'active' || row.active_since_day == null) {
      return { outcome: 'none', settlement: null, plan: serializePlan(row, flags, today) };
    }
    const rebaselineUntil = pgDate(row.rebaseline_until);
    if (rebaselineUntil && today < rebaselineUntil) {
      return { outcome: 'rebaselining', settlement: null, plan: serializePlan(row, flags, today) };
    }

    if (planDay >= completionDayFrom(row.active_since_day)) {
      const next = await updatePlan(q, row.id, { status: 'completed', completed_at: new Date() });
      return { outcome: 'completed', settlement: null, plan: serializePlan(next, flags, today) };
    }

    const due = dueSettlementDay(row.active_since_day, planDay, settled);
    if (due == null) return { outcome: 'none', settlement: null, plan: serializePlan(row, flags, today) };

    const pendingAnchor = row.pending_wake_anchor;
    const wakeAnchor = row.wake_anchor;
    let result: Awaited<ReturnType<typeof record>>;
    let patch: Record<string, unknown> = {};
    let adherentNights: number;

    if (row.track === 'full' && row.prescribed_tib_min) {
      const s = settleWeek({
        entries,
        settlementNightDate: today,
        prescribedTibMin: row.prescribed_tib_min,
        baselineTibMin: row.baseline_tib_min,
        wakeAnchor,
      });
      adherentNights = s.stats.adherentNights;
      const nextAnchor = pendingAnchor ?? wakeAnchor;
      result = await record('weekly', s.reason, s.stats, s as unknown as Record<string, unknown>, s.oldTibMin, s.newTibMin, earliestBedFor(nextAnchor, s.newTibMin));
      patch = { prescribed_tib_min: s.newTibMin };
    } else {
      const stats = periodStats(rollingWindow(entries, today), { wakeAnchor, earliestBedTime: null });
      adherentNights = stats.keptWakeNights;
      result = await record('gentle_review', 'gentle_review', stats, { stats }, null, null, null);
    }

    if (pendingAnchor) patch = { ...patch, wake_anchor: pendingAnchor, pending_wake_anchor: null };
    if (row.pending_track === 'full' && row.track === 'gentle') {
      const baselineTib = row.baseline_tst_min ?? row.baseline_tib_min ?? 390;
      patch = {
        ...patch,
        track: 'full',
        track_reason: 'user_request',
        pending_track: null,
        prescribed_tib_min: row.prescribed_tib_min ?? Math.max(330, Math.round(baselineTib / 15) * 15),
      };
    }
    const next = Object.keys(patch).length ? await updatePlan(q, row.id, patch) : row;
    return {
      outcome: result ? 'settled' : 'none',
      settlement: result,
      plan: serializePlan(next, flags, today),
      adherenceClaim: result && adherentNights >= 5 ? `${row.id}:${due}` : null,
    };
  });
}

/* ================================================================
   计划管理
   ================================================================ */

export type PlanAction =
  | { action: 'pause' }
  | { action: 'resume' }
  | { action: 'switch_gentle'; reason?: string }
  | { action: 'request_full' }
  | { action: 'set_wake_anchor'; wakeAnchor: string }
  | { action: 'exit'; reason: string }
  | { action: 'safety_pause'; reason: string }
  | { action: 'safety_resume' }
  | { action: 'restart_baseline' }
  | { action: 'relapse_restart' }
  | { action: 'update_devices'; devices: CbtiDevice[] }
  | { action: 'update_night_prefs'; soundAllowed?: boolean; promptsOff?: boolean };

export async function applyPlanAction(userId: string, input: PlanAction, today = shanghaiToday()) {
  const flags = await getFlags();
  const next = await withTransaction(async (q) => {
    const row = await requireLivePlan(userId, q);
    switch (input.action) {
      case 'pause': {
        if (row.status !== 'active' && row.status !== 'baseline') throw new CbtiError('invalid_state', 409);
        return updatePlan(q, row.id, { status: 'paused', paused_at: instantOn(today), paused_from_status: row.status });
      }
      case 'resume': {
        if (row.status !== 'paused') throw new CbtiError('invalid_state', 409);
        const days = currentPauseDays(row, today);
        const rule = resumeRule(days);
        if (rule === 'expired') {
          return updatePlan(q, row.id, { status: 'exited', exit_reason: 'pause_expired', exited_at: new Date() });
        }
        return updatePlan(q, row.id, {
          status: row.paused_from_status ?? 'active',
          paused_at: null,
          paused_from_status: null,
          paused_days_total: row.paused_days_total + days,
          rebaseline_until: rule === 'rebaseline_3' ? addDays(today, 3) : null,
        });
      }
      case 'switch_gentle': {
        if (row.track !== 'full') throw new CbtiError('invalid_state', 409);
        return updatePlan(q, row.id, { track: 'gentle', track_reason: input.reason ?? 'user_switch', pending_track: null });
      }
      case 'request_full': {
        if (row.track !== 'gentle' || row.status !== 'active') throw new CbtiError('invalid_state', 409);
        if (!canRequestFullTrack({ safetyFlags: row.safety_flags ?? [], ess: row.ess_baseline, isi: row.isi_baseline })) {
          throw new CbtiError('full_track_not_allowed', 422);
        }
        return updatePlan(q, row.id, { pending_track: 'full' });
      }
      case 'set_wake_anchor': {
        const changedOn = pgDate(row.wake_anchor_changed_on);
        if (changedOn && planWeekIndex(planDayIndex(pgDate(row.start_date)!, changedOn, row.paused_days_total)) === planWeekIndex(planDayOf(row, today))) {
          throw new CbtiError('wake_anchor_changed_this_week', 409);
        }
        const anchor = clampWakeAnchor(input.wakeAnchor);
        if (row.status === 'baseline') {
          return updatePlan(q, row.id, { wake_anchor: anchor, wake_anchor_changed_on: today });
        }
        return updatePlan(q, row.id, { pending_wake_anchor: anchor, wake_anchor_changed_on: today });
      }
      case 'exit':
        return updatePlan(q, row.id, { status: 'exited', exit_reason: input.reason.slice(0, 64), exited_at: new Date() });
      case 'safety_pause': {
        if (row.status === 'safety_paused') return row;
        return updatePlan(q, row.id, { status: 'safety_paused', paused_from_status: row.status, track_reason: `safety:${input.reason.slice(0, 48)}` });
      }
      case 'safety_resume': {
        if (row.status !== 'safety_paused') throw new CbtiError('invalid_state', 409);
        return updatePlan(q, row.id, {
          status: row.active_since_day != null ? 'active' : 'baseline',
          track: row.active_since_day != null ? 'gentle' : row.track,
          track_reason: 'safety_resume',
          paused_from_status: null,
        });
      }
      case 'restart_baseline':
      case 'relapse_restart': {
        if (input.action === 'relapse_restart' && row.status !== 'maintenance') throw new CbtiError('invalid_state', 409);
        return updatePlan(q, row.id, {
          status: 'baseline',
          start_date: today,
          track: 'none',
          track_reason: null,
          prescribed_tib_min: null,
          active_since_day: null,
          paused_days_total: 0,
          rebaseline_until: null,
          pending_track: null,
          pending_wake_anchor: null,
          night_profile_json: JSON.stringify({
            soundAllowed: row.night_profile_json?.soundAllowed,
            promptsOff: row.night_profile_json?.promptsOff,
          }),
        });
      }
      case 'update_devices':
        return updatePlan(q, row.id, { devices_json: JSON.stringify(input.devices) });
      case 'update_night_prefs': {
        const profile: NightProfile = { ...(row.night_profile_json ?? {}) };
        if (input.soundAllowed != null) profile.soundAllowed = input.soundAllowed;
        if (input.promptsOff != null) profile.promptsOff = input.promptsOff;
        return updatePlan(q, row.id, { night_profile_json: JSON.stringify(profile) });
      }
      default:
        throw new CbtiError('unknown_action', 400);
    }
  });
  return serializePlan(next, flags, today);
}

export async function setUserModeDisabled(userId: string, disabled: boolean): Promise<boolean> {
  const res = await query(
    `UPDATE cbti_plans SET mode_disabled = $2, version = version + 1, updated_at = NOW()
     WHERE user_id = $1 AND status <> 'exited'`,
    [userId, disabled],
  );
  return (res.rowCount ?? 0) > 0;
}

/* ================================================================
   设备夜摘要（CB-DEV-09）
   ================================================================ */

export async function saveNightSummary(input: {
  userId: string;
  planId: string | null;
  nightDate: string;
  deviceId: string;
  deviceKind: string;
  tier: string;
  summary: Record<string, unknown>;
  baseline?: Record<string, unknown> | null;
  planEndDate?: string | null;
}): Promise<void> {
  const retainUntil = addDays(input.planEndDate ?? addDays(input.nightDate, 42), NIGHT_SUMMARY_RETAIN_DAYS);
  await query(
    `INSERT INTO cbti_night_summaries (user_id, plan_id, night_date, device_id, device_kind, tier, summary_json, baseline_json, retain_until)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (user_id, night_date, device_id) DO UPDATE SET
       tier = EXCLUDED.tier, summary_json = EXCLUDED.summary_json,
       baseline_json = EXCLUDED.baseline_json, retain_until = EXCLUDED.retain_until`,
    [input.userId, input.planId, input.nightDate, input.deviceId, input.deviceKind, input.tier,
      JSON.stringify(input.summary), input.baseline ? JSON.stringify(input.baseline) : null, retainUntil],
  );
}

export async function listNightSummaries(userId: string, fromNightDate: string) {
  const { rows } = await query<{ night_date: Date | string; device_id: string; device_kind: string; tier: string; summary_json: Record<string, unknown>; baseline_json: Record<string, unknown> | null }>(
    `SELECT night_date, device_id, device_kind, tier, summary_json, baseline_json
     FROM cbti_night_summaries WHERE user_id = $1 AND night_date >= $2 ORDER BY night_date ASC`,
    [userId, fromNightDate],
  );
  return rows.map((r) => ({
    nightDate: pgDate(r.night_date)!,
    deviceId: r.device_id,
    deviceKind: r.device_kind,
    tier: r.tier,
    summary: r.summary_json,
    baseline: r.baseline_json,
  }));
}

export async function purgeExpiredNightSummaries(today = shanghaiToday()): Promise<number> {
  const res = await query(`DELETE FROM cbti_night_summaries WHERE retain_until < $1`, [today]);
  return res.rowCount ?? 0;
}

export async function deleteUserCbtiData(q: SqlQuery, userId: string): Promise<void> {
  await q(`DELETE FROM cbti_night_summaries WHERE user_id = $1`, [userId]);
  await q(`DELETE FROM cbti_consents WHERE user_id = $1`, [userId]);
  await q(`DELETE FROM cbti_plans WHERE user_id = $1`, [userId]);
}
