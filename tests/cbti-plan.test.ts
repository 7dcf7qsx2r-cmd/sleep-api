/**
 * 6 周睡眠节律计划：加入 → 基线日记 → 问卷分轨 → 初始窗口 → 周结算 → 管理动作；夜间离床监测与推送去重。
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = mkdtempSync(join(tmpdir(), 'sleep-api-cbti-'));
process.env.USE_PGLITE = '1';
process.env.PGLITE_DATA_DIR = dataDir;

type Plans = typeof import('../src/services/cbti/plans.js');
type Monitor = typeof import('../src/services/cbti/nightMonitor.js');
type Push = typeof import('../src/services/push.js');
type Providers = typeof import('../src/services/pushProviders.js');

let db: typeof import('../src/db/client.js');
let plans: Plans;
let monitor: Monitor;
let push: Push;
let providers: Providers;
let addCivilDays: (d: string, n: number) => string;

const USER = '00000000-0000-4000-8000-00000000c001';
const USER2 = '00000000-0000-4000-8000-00000000c002';
const START = '2026-10-05';
const SN = 'CISIB0000000001';

function day(n: number): string {
  return addCivilDays(START, n);
}

const consent = (version: string) => ({
  version,
  items: [
    { key: 'sleepy', checkedAt: '2026-10-05T12:00:00+08:00' },
    { key: 'not_medical', checkedAt: '2026-10-05T12:00:00+08:00' },
    { key: 'health_data', checkedAt: '2026-10-05T12:00:00+08:00' },
  ],
  archiveOptIn: false,
  deviceInfo: {},
});

const intake = { frequency: 'gte3' as const, duration: 'gte3m' as const, isAdult: true, safety: {} };

before(async () => {
  db = await import('../src/db/client.js');
  const { runMigrations } = await import('../src/db/migrate.js');
  await runMigrations();
  plans = await import('../src/services/cbti/plans.js');
  monitor = await import('../src/services/cbti/nightMonitor.js');
  push = await import('../src/services/push.js');
  providers = await import('../src/services/pushProviders.js');
  ({ addCivilDays } = await import('../src/utils/civilDate.js'));
  for (const [id, name] of [[USER, 'cbti_user'], [USER2, 'cbti_user2']]) {
    await db.query(`INSERT INTO users (id, username, password_hash) VALUES ($1, $2, 'x')`, [id, name]);
  }
});

after(async () => {
  providers.setPushProviderOverrides({});
  await db.closeDb();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('计划主流程', () => {
  test('加入：同意不全、版本不符、自伤筛查都拒绝；成功后进入基线', async () => {
    await assert.rejects(
      plans.joinPlan(USER, { intake, consent: { ...consent(plans.CBTI_CONSENT_VERSION), items: [] }, wakeAnchor: '07:00', devices: [] }, START),
      /consent_incomplete/,
    );
    await assert.rejects(
      plans.joinPlan(USER, { intake, consent: consent('old'), wakeAnchor: '07:00', devices: [] }, START),
      /consent_version_mismatch/,
    );
    await assert.rejects(
      plans.joinPlan(USER, { intake: { ...intake, safety: { self_harm: true } }, consent: consent(plans.CBTI_CONSENT_VERSION), wakeAnchor: '07:00', devices: [] }, START),
      /crisis/,
    );
    const joined = await plans.joinPlan(USER, {
      intake,
      consent: consent(plans.CBTI_CONSENT_VERSION),
      wakeAnchor: '07:00',
      devices: [{ kind: 'cis_ib', id: SN }],
    }, START);
    assert.equal(joined.plan.status, 'baseline');
    assert.equal(joined.plan.planDay, 1);
    await assert.rejects(
      plans.joinPlan(USER, { intake, consent: consent(plans.CBTI_CONSENT_VERSION), wakeAnchor: '07:00', devices: [] }, START),
      /plan_exists/,
    );
  });

  test('日记：只能补记前 2 天；旧的客户端时间不覆盖新的', async () => {
    const input = { bedTime: '23:30', wakeTime: '07:00', solMin: 45, wasoMin: 45, emaMin: 0, clientUpdatedAt: '2026-10-05T08:00:00+08:00' };
    await assert.rejects(plans.upsertDiary(USER, day(0), input, day(3)), /outside_edit_window/);
    await assert.rejects(plans.upsertDiary(USER, day(-1), input, day(0)), /before_plan_start/);
    const first = await plans.upsertDiary(USER, day(0), input, day(0));
    assert.equal(first.created, true);
    const stale = await plans.upsertDiary(USER, day(0), { ...input, solMin: 10, clientUpdatedAt: '2026-10-05T07:00:00+08:00' }, day(0));
    assert.equal(stale.conflict, true);
    assert.equal(stale.entry.solMin, 45);
    const edited = await plans.upsertDiary(USER, day(0), { ...input, solMin: 20, clientUpdatedAt: '2026-10-05T09:00:00+08:00' }, day(0));
    assert.equal(edited.entry.solMin, 20);
    assert.equal(edited.entry.editCount, 1);
  });

  test('基线 7 晚 + 问卷 → 完整轨，初始窗口按平均睡眠', async () => {
    const base = { bedTime: '23:30', wakeTime: '07:00', solMin: 45, wasoMin: 45, emaMin: 0, leaveCount: 1 };
    for (let d = 0; d < 7; d += 1) {
      await plans.upsertDiary(USER, day(d), { ...base, clientUpdatedAt: `${day(d)}T10:00:00+08:00` }, day(d));
    }
    const early = await plans.runDueSettlement(USER, null, day(5));
    assert.equal(early.outcome, 'extend');
    const awaiting = await plans.runDueSettlement(USER, null, day(6));
    assert.equal(awaiting.outcome, 'awaiting_questionnaire');

    const isi = await plans.submitQuestionnaire(USER, { kind: 'isi', phase: 'baseline', answers: [3, 3, 3, 3, 3, 3, 2] }, day(6));
    assert.equal(isi.score, 20);
    const ess = await plans.submitQuestionnaire(USER, { kind: 'ess', phase: 'baseline', answers: [1, 1, 1, 1, 1, 0, 0, 0] }, day(6));
    assert.equal(ess.assignment?.track, 'full');

    const initial = await plans.runDueSettlement(USER, { planDay: 7, reason: 'from_avg_sleep', newTibMin: 360 }, day(6));
    assert.equal(initial.outcome, 'initial_window');
    assert.equal(initial.plan.status, 'active');
    assert.equal(initial.plan.prescribedTibMin, 360);
    assert.equal(initial.plan.earliestBedTime, '01:00');
    assert.equal(initial.settlement?.mismatch, false);

    const again = await plans.runDueSettlement(USER, null, day(6));
    assert.equal(again.outcome, 'none');
  });

  test('第 14 天周结算：效率 ≥ 90% 加 15 分钟；客户端不一致记录但以服务端为准', async () => {
    for (let d = 7; d < 14; d += 1) {
      await plans.upsertDiary(USER, day(d), {
        bedTime: '01:00', wakeTime: '07:00', solMin: 10, wasoMin: 20, emaMin: 0,
        clientUpdatedAt: `${day(d)}T10:00:00+08:00`,
      }, day(d));
    }
    const res = await plans.runDueSettlement(USER, { planDay: 14, reason: 'se_low', newTibMin: 345 }, day(13));
    assert.equal(res.outcome, 'settled');
    assert.equal(res.settlement?.reason, 'se_good');
    assert.equal(res.settlement?.newTibMin, 375);
    assert.equal(res.settlement?.mismatch, true);
    assert.equal(res.plan.prescribedTibMin, 375);
    assert.equal(res.plan.earliestBedTime, '00:45');
  });

  test('改起床锚每周一次，下次结算生效；暂停与恢复', async () => {
    const changed = await plans.applyPlanAction(USER, { action: 'set_wake_anchor', wakeAnchor: '07:30' }, day(14));
    assert.equal(changed.pendingWakeAnchor, '07:30');
    assert.equal(changed.wakeAnchor, '07:00');
    await assert.rejects(plans.applyPlanAction(USER, { action: 'set_wake_anchor', wakeAnchor: '06:30' }, day(15)), /wake_anchor_changed_this_week/);

    const paused = await plans.applyPlanAction(USER, { action: 'pause' }, day(15));
    assert.equal(paused.status, 'paused');
    const resumed = await plans.applyPlanAction(USER, { action: 'resume' }, day(25));
    assert.equal(resumed.status, 'active');
    assert.equal(resumed.pausedDaysTotal, 10);
    assert.equal(resumed.rebaselineUntil, day(28));
    const rebase = await plans.runDueSettlement(USER, null, day(26));
    assert.equal(rebase.outcome, 'rebaselining');
  });

  test('夜间偏好与熔断', async () => {
    const prefs = await plans.applyPlanAction(USER, { action: 'update_night_prefs', soundAllowed: false });
    assert.equal(prefs.nightPrefs.soundAllowed, false);
    await plans.setFlag('mode_kill_switch', true);
    const current = await plans.getCurrentPlan(USER);
    assert.equal(current.plan?.modeDisabled, true);
    await plans.setFlag('mode_kill_switch', false);
    assert.equal(await plans.setUserModeDisabled(USER, true), true);
    assert.equal((await plans.getCurrentPlan(USER)).plan?.modeDisabled, true);
    await plans.setUserModeDisabled(USER, false);
  });

  test('撤回同意：计划结束，夜摘要删除', async () => {
    await plans.saveNightSummary({ userId: USER, planId: null, nightDate: day(20), deviceId: SN, deviceKind: 'cis_ib', tier: 'bed', summary: {} });
    await plans.withdrawConsent(USER);
    const current = await plans.getCurrentPlan(USER);
    assert.equal(current.plan, null);
    assert.equal(current.lastExit?.reason, 'consent_withdrawn');
    assert.equal((await plans.listNightSummaries(USER, START)).length, 0);
  });
});

describe('夜间离床监测', () => {
  const NIGHT = '2026-10-20';
  let planId = '';

  before(async () => {
    await db.query(`INSERT INTO iot_products (product_key, name) VALUES ('cis_ib', '床垫') ON CONFLICT DO NOTHING`);
    await db.query(`INSERT INTO iot_device_bindings (product_key, sn, user_id) VALUES ('cis_ib', $1, $2)`, [SN, USER2]);
    const joined = await plans.joinPlan(USER2, {
      intake,
      consent: consent(plans.CBTI_CONSENT_VERSION),
      wakeAnchor: '07:00',
      devices: [{ kind: 'cis_ib', id: SN }],
    }, '2026-10-01');
    planId = joined.plan.planId;
    // 直接置为完整轨、已通过资格校验，最早上床 01:00
    await db.query(
      `UPDATE cbti_plans SET status = 'active', track = 'full', prescribed_tib_min = 360, active_since_day = 7,
         baseline_bed_time = '23:30', night_profile_json = '{"qualified":true,"sleepHrBaseline":55}'::jsonb
       WHERE id = $1`,
      [planId],
    );
    // 00:40 上床、睡到 02:30，之后辗转 30 分钟
    const t0 = Date.parse(`${NIGHT}T00:40:00+08:00`);
    for (let i = 0; i < 280; i += 1) {
      const restless = i >= 220;
      await db.query(
        `INSERT INTO iot_sleep_epochs (sn, epoch_start, product_key, night_date, sample_count, in_bed_ratio, hr_mean, hr_std, br_std, motion, quality)
         VALUES ($1, $2, 'cis_ib', $3, 30, 1, $4, $5, $6, $7, 'ok')`,
        [SN, new Date(t0 + i * 30_000), NIGHT, restless ? 70 : 55, restless ? 6 : 1, restless ? 3 : 0.8, restless ? 0.5 : 0.05],
      );
    }
  });

  test('夜间窗口外不判定', async () => {
    const row = (await plans.loadLivePlan(USER2))!;
    const status = await monitor.evaluatePlanNight(row, new Date(`${NIGHT}T00:10:00+08:00`));
    assert.equal(status.inWindow, false);
    assert.equal(status.blockedBy, 'outside_window');
  });

  test('辗转够久：记一次提醒并入队推送，重复评估不重复推送', async () => {
    const row = (await plans.loadLivePlan(USER2))!;
    const now = new Date(Date.parse(`${NIGHT}T00:40:00+08:00`) + 280 * 30_000);
    const status = await monitor.evaluatePlanNight(row, now);
    assert.equal(status.inWindow, true);
    assert.equal(status.source?.deviceId, SN);
    assert.equal(status.state, 'in_bed');
    assert.equal(status.prompt?.level, 'sound');
    const again = await monitor.evaluatePlanNight(row, new Date(now.getTime() + 20_000));
    assert.equal(again.blockedBy, 'already_prompted_this_stretch');
    const queued = await db.query<{ category: string; event_id: string }>(`SELECT category, event_id FROM push_queue WHERE user_id = $1`, [USER2]);
    assert.equal(queued.rows.length, 1);
    assert.equal(queued.rows[0]!.category, 'leave_bed_sound');
  });

  test('推送：离床类超 60 秒作废；未配置通道记为 skipped；已送达记录通道与时延', async () => {
    const nightNow = Date.parse(`${NIGHT}T00:40:00+08:00`) + 280 * 30_000;
    const expired = await push.dispatchPushQueue(new Date(nightNow + 5 * 60_000));
    assert.equal(expired.expired, 1);

    // 以下用没有进行中计划的账号，避免受计划夜间时段影响
    await db.query(`INSERT INTO push_devices (user_id, platform, token, provider, vendor) VALUES ($1, 'android', 'getui-cid-000001', 'getui', 'xiaomi')`, [USER]);
    await push.enqueuePush({ userId: USER, title: 't', body: 'b', category: 'settlement', eventId: 'settle:1' });
    const dup = await push.enqueuePush({ userId: USER, title: 't', body: 'b', category: 'settlement', eventId: 'settle:1' });
    assert.equal(dup, null);
    const skipped = await push.dispatchPushQueue();
    assert.equal(skipped.skipped, 1);

    const sent: string[] = [];
    providers.setPushProviderOverrides({
      getui: { name: 'getui', configured: () => true, send: async (target) => { sent.push(target.token); return { status: 'sent' }; } },
    });
    await push.enqueuePush({ userId: USER, title: 't', body: 'b', category: 'plan', eventId: 'plan:1' });
    const ok = await push.dispatchPushQueue();
    assert.equal(ok.sent, 1);
    assert.deepEqual(sent, ['getui-cid-000001']);
    const stats = await push.pushDeliveryStats(1);
    assert.ok(stats.some((s) => s.provider === 'getui' && s.vendor === 'xiaomi' && s.status === 'sent'));
  });

  test('计划模式夜间时段：非离床类推送延后到起床锚', async () => {
    const { cbtiPushGate } = await import('../src/services/cbti/pushGate.js');
    const night = new Date(`${NIGHT}T02:00:00+08:00`);
    const decision = await cbtiPushGate({ userId: USER2, category: 'plan', now: night, sentTodayNonExempt: 0 });
    assert.equal(decision.action, 'defer');
    assert.equal(decision.action === 'defer' && decision.until.toISOString(), new Date(`${NIGHT}T07:00:00+08:00`).toISOString());
    const bed = await cbtiPushGate({ userId: USER2, category: 'leave_bed_sound', now: night, sentTodayNonExempt: 9 });
    assert.equal(bed.action, 'send');
    const day = await cbtiPushGate({ userId: USER2, category: 'plan', now: new Date(`${NIGHT}T12:00:00+08:00`), sentTodayNonExempt: 3 });
    assert.equal(day.action, 'drop');
  });

  test('早晨预填：上床、起床时刻与待确认的有声提醒', async () => {
    const prefill = await monitor.getNightPrefill(USER2, NIGHT);
    assert.equal(prefill?.available, true);
    assert.equal(prefill?.bedTime, '00:40');
    assert.equal(prefill?.tier, 'bed');
    assert.equal(prefill?.soundPromptsToReview.length, 1);
  });
});
