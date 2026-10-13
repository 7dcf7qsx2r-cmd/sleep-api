/**
 * 生物雷达 / BR 系列床垫：厂商推送鉴权、双雷达分侧存取、旧表主键升级。
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = mkdtempSync(join(tmpdir(), 'sleep-api-radar-'));
process.env.USE_PGLITE = '1';
process.env.PGLITE_DATA_DIR = dataDir;
process.env.RADAR_PUSH_SECRET = 'push-secret-1';

let closeDb: typeof import('../src/db/client.js').closeDb;
let query: typeof import('../src/db/client.js').query;
let radar: typeof import('../src/services/radar.js');
let routes: typeof import('../src/routes/radar.js');
let RADAR_MIGRATION_STATEMENTS: string[];

before(async () => {
  ({ closeDb, query } = await import('../src/db/client.js'));
  ({ RADAR_MIGRATION_STATEMENTS } = await import('../src/db/radarSchema.js'));
  const { CBTI_MIGRATION_STATEMENTS } = await import('../src/db/cbtiSchema.js');
  radar = await import('../src/services/radar.js');
  routes = await import('../src/routes/radar.js');

  // 上线前的旧结构：主键只有 mac，radar_number 可空，报告表没有 radar_number
  await query(`CREATE TABLE radar_realtime_latest (
    mac TEXT PRIMARY KEY,
    radar_number INT,
    heart_rate INT,
    respiratory_rate INT,
    isbed INT,
    signal INT,
    alarm_type INT,
    online INT,
    time_stamp TIMESTAMPTZ,
    raw_json JSONB NOT NULL DEFAULT '{}',
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await query(`CREATE TABLE radar_sleep_reports (
    sleep_id TEXT PRIMARY KEY,
    mac TEXT NOT NULL,
    inbed_time INT,
    outbed_time INT,
    deep_sleeptime INT,
    light_sleeptime INT,
    rem_time INT,
    wake_time INT,
    sleep_score INT,
    sdate TIMESTAMPTZ,
    edate TIMESTAMPTZ,
    assess_json JSONB,
    heartlist_json JSONB,
    resplist_json JSONB,
    datelist_json JSONB,
    raw_json JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await query(
    `INSERT INTO radar_realtime_latest (mac, heart_rate, isbed, online) VALUES ('246F28ABC618', 72, 1, 1)`,
  );
  for (const sql of CBTI_MIGRATION_STATEMENTS.filter((s) => s.includes('radar_realtime_series'))) {
    await query(sql);
  }
});

after(async () => {
  await closeDb();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('radar push token', () => {
  test('no secret configured keeps the endpoint open', () => {
    assert.equal(routes.radarPushTokenOk('', {}), true);
  });

  test('accepts Bearer, ?token= or path token; rejects others', () => {
    const secret = 'abc123';
    assert.equal(routes.radarPushTokenOk(secret, { authorization: 'Bearer abc123' }), true);
    assert.equal(routes.radarPushTokenOk(secret, { queryToken: 'abc123' }), true);
    assert.equal(routes.radarPushTokenOk(secret, { pathToken: 'abc123' }), true);
    assert.equal(routes.radarPushTokenOk(secret, {}), false);
    assert.equal(routes.radarPushTokenOk(secret, { queryToken: 'abc12' }), false);
    assert.equal(routes.radarPushTokenOk(secret, { authorization: 'abc123' }), false);
  });
});

describe('radar storage', { concurrency: false }, () => {
  test('migration upgrades the single-column primary key and is idempotent', async () => {
    for (let pass = 0; pass < 2; pass += 1) {
      for (const sql of RADAR_MIGRATION_STATEMENTS) await query(sql);
    }
    const { rows: pk } = await query<{ cols: number }>(
      `SELECT array_length(conkey, 1) AS cols FROM pg_constraint
       WHERE conrelid = 'radar_realtime_latest'::regclass AND contype = 'p'`,
    );
    assert.equal(Number(pk[0]?.cols), 2);
    const { rows } = await query<{ radar_number: number }>(
      `SELECT radar_number FROM radar_realtime_latest WHERE mac = '246F28ABC618'`,
    );
    assert.equal(Number(rows[0]?.radar_number), 1);
  });

  test('two sides of a dual-radar mattress are stored separately', async () => {
    await radar.upsertRealtime([
      { mac: '3C:71:BF:2E:99:99', radarNumber: 1, heartRate: 0, isbed: 0, online: 1, timeStamp: '2026-10-13 22:00:00', raw: { deviceModel: 35, turn: 0 } },
      { mac: '3C71BF2E9999', radarNumber: 2, heartRate: 66, respiratoryRate: 20, isbed: 1, online: 1, timeStamp: '2026-10-13 22:00:00', raw: { deviceModel: 35, turn: 3 } },
    ]);
    const both = await radar.getLatestRealtime('3c71bf2e9999');
    assert.equal(both?.radarNumber, 1);
    assert.equal(both?.isbed, 0);
    assert.equal(both?.radars.length, 2);
    assert.equal(both?.deviceModel, 35);

    const right = await radar.getLatestRealtime('3C71BF2E9999', 2);
    assert.equal(right?.radarNumber, 2);
    assert.equal(right?.heartRate, 66);
    assert.equal(right?.turn, 3);
    assert.equal(right?.radars.length, 1);

    const known = await radar.listKnownDevices();
    assert.equal(known.filter((d) => d.mac === '3C71BF2E9999').length, 1);
  });

  test('reports keep radar_number and can be filtered by side', async () => {
    await radar.upsertReports([
      { sleep_id: 'r-left', mac: '3C71BF2E9999', radar_number: 1, deep_sleeptime: 60, sdate: '2026-10-12 23:00:00' },
      { sleep_id: 'r-right', mac: '3C71BF2E9999', radar_number: 2, deep_sleeptime: 90, sdate: '2026-10-12 23:10:00' },
    ]);
    const right = await radar.getSleepReport('3C71BF2E9999', undefined, 2);
    assert.equal(right?.sleep_id, 'r-right');
    assert.equal(right?.radar_number, 2);
    const left = await radar.listSleepReports('3C71BF2E9999', 90, 1);
    assert.deepEqual(left.map((r) => r.sleep_id), ['r-left']);
  });
});

describe('radar push routes', { concurrency: false }, () => {
  test('path token and query token both authorize the vendor push', async () => {
    const { Hono } = await import('hono');
    const app = new Hono();
    app.route('/api/radar', routes.radarRoutes);
    const body = JSON.stringify([{ mac: 'AABBCCDDEEFF', radarNumber: 1, heartRate: 60, isbed: 1, online: 1 }]);
    const headers = { 'Content-Type': 'application/json' };

    const denied = await app.request('/api/radar/datapost', { method: 'POST', body, headers });
    assert.equal(denied.status, 401);

    const byPath = await app.request('/api/radar/datapost/push-secret-1', { method: 'POST', body, headers });
    assert.equal(byPath.status, 200);
    assert.deepEqual(await byPath.json(), { ret: 0, msg: 'ok', stored: 1 });

    const byQuery = await app.request('/api/radar/reportpost?token=push-secret-1', {
      method: 'POST',
      body: JSON.stringify([{ sleep_id: 's1', mac: 'AABBCCDDEEFF' }]),
      headers,
    });
    assert.equal(byQuery.status, 200);

    const wrongPath = await app.request('/api/radar/datapost/nope', { method: 'POST', body, headers });
    assert.equal(wrongPath.status, 401);
  });
});
