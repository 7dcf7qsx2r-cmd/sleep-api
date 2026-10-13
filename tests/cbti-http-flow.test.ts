/**
 * 6 周睡眠节律计划 HTTP 联调：走和 App `cbtiApi.ts` 相同的路径与报文。
 * 日期用 SQL 快进，因为路由里的「今天」是上海时区的真实日期。
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = mkdtempSync(join(tmpdir(), 'sleep-api-cbti-http-'));
process.env.USE_PGLITE = '1';
process.env.PGLITE_DATA_DIR = dataDir;
process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'dev-only-jwt-secret-change-me';

type App = ReturnType<typeof import('../src/app.js').createApp>;

let app: App;
let db: typeof import('../src/db/client.js');
let signToken: typeof import('../src/lib/jwt.js').signToken;
let addCivilDays: (d: string, n: number) => string;
let shanghaiToday: () => string;
let CONSENT: string;

const USER = '00000000-0000-4000-8000-00000000d101';
const USER_B = '00000000-0000-4000-8000-00000000d102';
const GUEST = '00000000-0000-4000-8000-00000000d199';
const EXPERT = '00000000-0000-4000-8000-00000000d1e1';

let today = '';
let userToken = '';
let userBToken = '';
let guestToken = '';

function consent(version: string) {
  const at = `${today}T08:00:00+08:00`;
  return {
    version,
    items: [
      { key: 'sleepy', checkedAt: at },
      { key: 'not_medical', checkedAt: at },
      { key: 'health_data', checkedAt: at },
    ],
    archiveOptIn: false,
    deviceInfo: { platform: 'integration' },
  };
}

const intake = { frequency: 'gte3', duration: 'gte3m', isAdult: true, safety: {} as Record<string, boolean> };

async function call(method: string, path: string, token: string | null, body?: unknown) {
  const res = await app.request(path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body == null ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = text ? JSON.parse(text) as Record<string, unknown> : {};
  } catch {
    json = { raw: text };
  }
  return { status: res.status, json };
}

function diaryBody(overrides: Record<string, unknown> = {}, stamp = `${today}T09:00:00+08:00`) {
  return {
    bedTime: '23:30',
    wakeTime: '07:00',
    solMin: 45,
    wasoMin: 45,
    emaMin: 0,
    leaveCount: 1,
    sleepiness: 1,
    clientUpdatedAt: stamp,
    ...overrides,
  };
}

before(async () => {
  db = await import('../src/db/client.js');
  const { runMigrations } = await import('../src/db/migrate.js');
  await runMigrations();
  app = (await import('../src/app.js')).createApp();
  ({ signToken } = await import('../src/lib/jwt.js'));
  ({ addCivilDays, shanghaiToday } = await import('../src/utils/civilDate.js'));
  ({ CBTI_CONSENT_VERSION: CONSENT } = await import('../src/services/cbti/plans.js'));
  today = shanghaiToday();
  for (const [id, name] of [[USER, 'cbti_http_a'], [USER_B, 'cbti_http_b']] as const) {
    await db.query(
      `INSERT INTO users (id, username, password_hash, status) VALUES ($1, $2, 'x', 'active')`,
      [id, name],
    );
    await db.query(`INSERT INTO energy_accounts (user_id) VALUES ($1)`, [id]);
  }
  userToken = await signToken({ sub: USER, type: 'user' });
  userBToken = await signToken({ sub: USER_B, type: 'user' });
  guestToken = await signToken({ sub: GUEST, type: 'guest' });
  await db.query(
    `INSERT INTO experts (id, name, title, bio, status) VALUES ($1, '联调专家', '睡眠咨询', '仅用于联调', 'published')`,
    [EXPERT],
  );
});

after(async () => {
  await db.closeDb();
  rmSync(dataDir, { recursive: true, force: true });
});

test('未登录 401，游客 403，空账号没有计划', async () => {
  assert.equal((await call('GET', '/cbti/plans/current', null)).status, 401);
  const guest = await call('GET', '/cbti/plans/current', guestToken);
  assert.equal(guest.status, 403);
  assert.equal(guest.json.error, 'guest_not_allowed');
  const current = await call('GET', '/cbti/plans/current', userToken);
  assert.equal(current.status, 200);
  assert.equal((current.json.plan as null), null);
  assert.equal(current.json.currentConsentVersion, CONSENT);
});

test('加入：同意不全、版本不对、自伤、频率不够都拒绝，成功后是基线周', async () => {
  const incomplete = await call('POST', '/cbti/plans', userToken, {
    intake, consent: { ...consent(CONSENT), items: [] }, wakeAnchor: '07:00', devices: [],
  });
  assert.equal(incomplete.status, 422);
  assert.equal(incomplete.json.error, 'consent_incomplete');

  const version = await call('POST', '/cbti/plans', userToken, {
    intake, consent: consent('old'), wakeAnchor: '07:00', devices: [],
  });
  assert.equal(version.status, 409);
  assert.equal(version.json.error, 'consent_version_mismatch');

  const crisis = await call('POST', '/cbti/plans', userToken, {
    intake: { ...intake, safety: { self_harm: true } },
    consent: consent(CONSENT),
    wakeAnchor: '07:00',
    devices: [],
  });
  assert.equal(crisis.status, 422);
  assert.equal(crisis.json.error, 'crisis');

  const young = await call('POST', '/cbti/plans', userToken, {
    intake: { ...intake, isAdult: false },
    consent: consent(CONSENT),
    wakeAnchor: '07:00',
    devices: [],
  });
  assert.equal(young.status, 422);
  assert.equal(young.json.error, 'not_eligible_age');

  const rare = await call('POST', '/cbti/plans', userToken, {
    intake: { ...intake, frequency: '1_2' },
    consent: consent(CONSENT),
    wakeAnchor: '07:00',
    devices: [],
  });
  assert.equal(rare.status, 422);
  assert.equal(rare.json.error, 'not_eligible_frequency');

  const joined = await call('POST', '/cbti/plans', userToken, {
    intake, consent: consent(CONSENT), wakeAnchor: '07:07', devices: [],
  });
  assert.equal(joined.status, 200, JSON.stringify(joined.json));
  const plan = joined.json.plan as { status: string; track: string; planDay: number; wakeAnchor: string };
  assert.equal(plan.status, 'baseline');
  assert.equal(plan.track, 'none');
  assert.equal(plan.planDay, 1);
  assert.equal(plan.wakeAnchor, '07:00');

  const again = await call('POST', '/cbti/plans', userToken, {
    intake, consent: consent(CONSENT), wakeAnchor: '07:00', devices: [],
  });
  assert.equal(again.status, 409);
  assert.equal(again.json.error, 'plan_exists');
});

test('日记、夜间按钮、夜间状态', async () => {
  const before = await call('PUT', `/cbti/diary/${addCivilDays(today, -1)}`, userToken, diaryBody());
  assert.equal(before.status, 422);
  assert.equal(before.json.error, 'before_plan_start');

  const saved = await call('PUT', `/cbti/diary/${today}`, userToken, diaryBody());
  assert.equal(saved.status, 200, JSON.stringify(saved.json));
  assert.equal(saved.json.created, true);
  assert.equal(saved.json.energyEarned, 10);

  const stale = await call('PUT', `/cbti/diary/${today}`, userToken, diaryBody({ solMin: 10 }, `${today}T08:30:00+08:00`));
  assert.equal(stale.json.conflict, true);
  assert.equal((stale.json.entry as { solMin: number }).solMin, 45);

  const edited = await call('PUT', `/cbti/diary/${today}`, userToken, diaryBody({ solMin: 20 }, `${today}T10:00:00+08:00`));
  assert.equal((edited.json.entry as { solMin: number }).solMin, 20);

  const list = await call('GET', '/cbti/diary', userToken);
  assert.equal((list.json.entries as unknown[]).length, 1);

  const events = await call('POST', '/cbti/night-events', userToken, {
    events: [
      {
        eventId: 'leave-http-0001',
        nightDate: today,
        kind: 'leave_bed',
        occurredAt: `${today}T02:40:00+08:00`,
        source: 'button',
      },
      {
        eventId: 'return-http-0001',
        nightDate: today,
        kind: 'return_bed',
        occurredAt: `${today}T03:05:00+08:00`,
        source: 'button',
      },
    ],
  });
  assert.equal(events.status, 200, JSON.stringify(events.json));
  assert.equal(events.json.inserted, 2);
  const dup = await call('POST', '/cbti/night-events', userToken, {
    events: [{
      eventId: 'leave-http-0001',
      nightDate: today,
      kind: 'leave_bed',
      occurredAt: `${today}T02:40:00+08:00`,
      source: 'button',
    }],
  });
  assert.equal(dup.json.inserted, 0);
  const listed = await call('GET', `/cbti/night-events?nightDate=${today}`, userToken);
  assert.equal((listed.json.events as unknown[]).length, 2);

  const old = await call('POST', '/cbti/night-events', userToken, {
    events: [{
      eventId: 'leave-http-old1',
      nightDate: addCivilDays(today, -5),
      kind: 'leave_bed',
      occurredAt: `${addCivilDays(today, -5)}T02:00:00+08:00`,
      source: 'button',
    }],
  });
  assert.equal(old.status, 422);
  assert.equal(old.json.error, 'night_date_out_of_range');

  const status = await call('GET', '/cbti/night/status', userToken);
  assert.equal(status.status, 200);
  assert.ok(status.json.status);
  const prefill = await call('GET', `/cbti/night/prefill?nightDate=${today}`, userToken);
  assert.equal(prefill.status, 200);
  const summaries = await call('GET', `/cbti/night/summaries?from=${addCivilDays(today, -7)}`, userToken);
  assert.equal(summaries.status, 200);
});

test('快进到第 7 天：问卷后完整轨，初始窗口 01:00', async () => {
  const start = addCivilDays(today, -6);
  await db.query(`UPDATE cbti_plans SET start_date = $2 WHERE user_id = $1 AND status <> 'exited'`, [USER, start]);
  const planId = (await db.query<{ id: string }>(
    `SELECT id FROM cbti_plans WHERE user_id = $1 AND status <> 'exited'`,
    [USER],
  )).rows[0]!.id;
  for (let i = 0; i < 7; i += 1) {
    const night = addCivilDays(start, i);
    await db.query(
      `INSERT INTO cbti_diary_entries
         (plan_id, user_id, night_date, bed_time, wake_time, sol_min, waso_min, ema_min, leave_count, sleepiness, client_updated_at)
       VALUES ($1,$2,$3,'23:30','07:00',45,45,0,1,1,$4)
       ON CONFLICT (plan_id, night_date) DO UPDATE
         SET bed_time = '23:30', wake_time = '07:00', sol_min = 45, waso_min = 45, ema_min = 0, sleepiness = 1`,
      [planId, USER, night, `${night}T08:00:00+08:00`],
    );
  }

  const early = await call('POST', '/cbti/settlements', userToken, { client: null });
  assert.equal(early.status, 200, JSON.stringify(early.json));
  assert.equal(early.json.outcome, 'awaiting_questionnaire');

  const badIsi = await call('POST', '/cbti/questionnaires', userToken, {
    kind: 'isi', phase: 'baseline', answers: [1, 2, 3],
  });
  assert.equal(badIsi.status, 400);

  const isi = await call('POST', '/cbti/questionnaires', userToken, {
    kind: 'isi', phase: 'baseline', answers: [3, 3, 3, 3, 3, 3, 2],
  });
  assert.equal(isi.status, 200, JSON.stringify(isi.json));
  assert.equal(isi.json.score, 20);
  const ess = await call('POST', '/cbti/questionnaires', userToken, {
    kind: 'ess', phase: 'baseline', answers: [1, 1, 1, 1, 1, 0, 0, 0],
  });
  assert.equal(ess.status, 200, JSON.stringify(ess.json));

  const initial = await call('POST', '/cbti/settlements', userToken, {
    client: { planDay: 7, reason: 'from_avg_sleep', newTibMin: 360 },
  });
  assert.equal(initial.status, 200, JSON.stringify(initial.json));
  assert.equal(initial.json.outcome, 'initial_window');
  const plan = initial.json.plan as { status: string; track: string; prescribedTibMin: number; earliestBedTime: string };
  assert.equal(plan.status, 'active');
  assert.equal(plan.track, 'full');
  assert.equal(plan.prescribedTibMin, 360);
  assert.equal(plan.earliestBedTime, '01:00');
  assert.equal((initial.json.settlement as { mismatch: boolean }).mismatch, false);
});

test('第 14 天周结算以服务端为准；专家咨询带上窗口', async () => {
  const start = addCivilDays(today, -13);
  await db.query(`UPDATE cbti_plans SET start_date = $2 WHERE user_id = $1 AND status = 'active'`, [USER, start]);
  const planId = (await db.query<{ id: string }>(
    `SELECT id FROM cbti_plans WHERE user_id = $1 AND status = 'active'`,
    [USER],
  )).rows[0]!.id;
  for (let i = 0; i < 7; i += 1) {
    const night = addCivilDays(today, -i);
    await db.query(
      `INSERT INTO cbti_diary_entries
         (plan_id, user_id, night_date, bed_time, wake_time, sol_min, waso_min, ema_min, leave_count, sleepiness, client_updated_at)
       VALUES ($1,$2,$3,'01:00','07:00',10,20,0,0,NULL,$4)
       ON CONFLICT (plan_id, night_date) DO UPDATE
         SET bed_time = '01:00', wake_time = '07:00', sol_min = 10, waso_min = 20, ema_min = 0, sleepiness = NULL, special = NULL`,
      [planId, USER, night, `${night}T08:00:00+08:00`],
    );
  }
  const settled = await call('POST', '/cbti/settlements', userToken, {
    client: { planDay: 14, reason: 'se_low', newTibMin: 345 },
  });
  assert.equal(settled.status, 200, JSON.stringify(settled.json));
  assert.equal(settled.json.outcome, 'settled');
  const settlement = settled.json.settlement as { reason: string; newTibMin: number; mismatch: boolean };
  assert.equal(settlement.reason, 'se_good');
  assert.equal(settlement.newTibMin, 375);
  assert.equal(settlement.mismatch, true);
  const plan = settled.json.plan as { prescribedTibMin: number; earliestBedTime: string };
  assert.equal(plan.prescribedTibMin, 375);
  assert.equal(plan.earliestBedTime, '00:45');

  const listed = await call('GET', '/cbti/settlements', userToken);
  assert.ok((listed.json.settlements as unknown[]).length >= 2);

  const consult = await call('POST', '/experts/consultations', userToken, {
    expertId: EXPERT,
    question: '计划期间夜里醒来很多次，想问接下来怎么走。',
    preferredTime: '工作日晚上',
    privacyConsent: true,
  });
  assert.equal(consult.status, 201, JSON.stringify(consult.json));
  const ctx = (consult.json.consultation as { planContext: { status: string; track: string; earliestBedTime: string } }).planContext;
  assert.equal(ctx.status, 'active');
  assert.equal(ctx.track, 'full');
  assert.equal(ctx.earliestBedTime, '00:45');
});

test('起床锚、换轨、暂停、安全暂停、熔断、退出', async () => {
  const anchor = await call('PATCH', '/cbti/plans/current', userToken, { action: 'set_wake_anchor', wakeAnchor: '07:30' });
  assert.equal(anchor.status, 200, JSON.stringify(anchor.json));
  const pending = anchor.json.plan as { wakeAnchor: string; pendingWakeAnchor: string };
  assert.equal(pending.wakeAnchor, '07:00');
  assert.equal(pending.pendingWakeAnchor, '07:30');
  const twice = await call('PATCH', '/cbti/plans/current', userToken, { action: 'set_wake_anchor', wakeAnchor: '06:30' });
  assert.equal(twice.status, 409);
  assert.equal(twice.json.error, 'wake_anchor_changed_this_week');

  const gentle = await call('PATCH', '/cbti/plans/current', userToken, { action: 'switch_gentle', reason: 'user' });
  assert.equal((gentle.json.plan as { track: string }).track, 'gentle');
  const ask = await call('PATCH', '/cbti/plans/current', userToken, { action: 'request_full' });
  assert.equal(ask.status, 200, JSON.stringify(ask.json));
  assert.equal((ask.json.plan as { pendingTrack: string }).pendingTrack, 'full');

  const prefs = await call('PATCH', '/cbti/plans/current', userToken, { action: 'update_night_prefs', soundAllowed: false });
  assert.equal((prefs.json.plan as { nightPrefs: { soundAllowed: boolean } }).nightPrefs.soundAllowed, false);

  const paused = await call('PATCH', '/cbti/plans/current', userToken, { action: 'pause' });
  assert.equal((paused.json.plan as { status: string }).status, 'paused');
  const resumed = await call('PATCH', '/cbti/plans/current', userToken, { action: 'resume' });
  assert.equal((resumed.json.plan as { status: string }).status, 'active');

  const safety = await call('PATCH', '/cbti/plans/current', userToken, { action: 'safety_pause', reason: 'sleepy' });
  assert.equal((safety.json.plan as { status: string }).status, 'safety_paused');
  const back = await call('PATCH', '/cbti/plans/current', userToken, { action: 'safety_resume' });
  const afterSafety = back.json.plan as { status: string; track: string };
  assert.equal(afterSafety.status, 'active');
  assert.equal(afterSafety.track, 'gentle');

  await db.query(
    `INSERT INTO cbti_flags (key, enabled, updated_at) VALUES ('mode_kill_switch', true, NOW())
     ON CONFLICT (key) DO UPDATE SET enabled = true, updated_at = NOW()`,
  );
  const killed = await call('GET', '/cbti/plans/current', userToken);
  assert.equal((killed.json.plan as { modeDisabled: boolean }).modeDisabled, true);
  assert.equal((killed.json.flags as { modeKillSwitch: boolean }).modeKillSwitch, true);
  await db.query(`UPDATE cbti_flags SET enabled = false WHERE key = 'mode_kill_switch'`);

  const push = await call('POST', '/push/register', userToken, {
    platform: 'android', token: 'getui-cid-http-01', provider: 'getui', vendor: 'xiaomi',
  });
  assert.equal(push.status, 200, JSON.stringify(push.json));
  const off = await call('POST', '/push/unregister', userToken, { platform: 'android', token: 'getui-cid-http-01' });
  assert.equal(off.status, 200);

  const exited = await call('PATCH', '/cbti/plans/current', userToken, { action: 'exit', reason: 'integration' });
  assert.equal((exited.json.plan as { status: string }).status, 'exited');
  const current = await call('GET', '/cbti/plans/current', userToken);
  assert.equal(current.json.plan, null);
  assert.equal((current.json.lastExit as { reason: string }).reason, 'integration');
});

test('安全项强制温和轨且不能申请完整轨；撤回同意结束计划', async () => {
  const joined = await call('POST', '/cbti/plans', userBToken, {
    intake: { ...intake, safety: { pregnant: true } },
    consent: consent(CONSENT),
    wakeAnchor: '07:00',
    devices: [],
  });
  assert.equal(joined.status, 200, JSON.stringify(joined.json));
  const start = addCivilDays(today, -6);
  await db.query(`UPDATE cbti_plans SET start_date = $2 WHERE user_id = $1 AND status <> 'exited'`, [USER_B, start]);
  const planId = (await db.query<{ id: string }>(
    `SELECT id FROM cbti_plans WHERE user_id = $1 AND status <> 'exited'`,
    [USER_B],
  )).rows[0]!.id;
  for (let i = 0; i < 7; i += 1) {
    const night = addCivilDays(start, i);
    await db.query(
      `INSERT INTO cbti_diary_entries
         (plan_id, user_id, night_date, bed_time, wake_time, sol_min, waso_min, ema_min, sleepiness, client_updated_at)
       VALUES ($1,$2,$3,'23:30','07:00',45,45,0,1,$4)`,
      [planId, USER_B, night, `${night}T08:00:00+08:00`],
    );
  }
  assert.equal((await call('POST', '/cbti/questionnaires', userBToken, {
    kind: 'isi', phase: 'baseline', answers: [3, 3, 3, 3, 3, 3, 2],
  })).status, 200);
  assert.equal((await call('POST', '/cbti/questionnaires', userBToken, {
    kind: 'ess', phase: 'baseline', answers: [0, 0, 0, 0, 0, 0, 0, 0],
  })).status, 200);
  const settled = await call('POST', '/cbti/settlements', userBToken, { client: null });
  assert.equal(settled.json.outcome, 'gentle_start', JSON.stringify(settled.json));
  assert.equal((settled.json.plan as { track: string }).track, 'gentle');
  const denied = await call('PATCH', '/cbti/plans/current', userBToken, { action: 'request_full' });
  assert.equal(denied.status, 422);
  assert.equal(denied.json.error, 'full_track_not_allowed');

  const withdrawn = await call('POST', '/cbti/consent/withdraw', userBToken);
  assert.equal(withdrawn.status, 200);
  assert.equal(withdrawn.json.ok, true);
  const current = await call('GET', '/cbti/plans/current', userBToken);
  assert.equal(current.json.plan, null);
  assert.equal((current.json.lastExit as { reason: string }).reason, 'consent_withdrawn');
  assert.ok((current.json.consent as { withdrawnAt: string }).withdrawnAt);
});
