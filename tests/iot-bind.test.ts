/**
 * MQTT 床旁设备：账号绑定 + 仅本人可读原文。
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IOT_MIGRATION_STATEMENTS } from '../src/db/iotSchema.js';

const dataDir = mkdtempSync(join(tmpdir(), 'sleep-api-iot-'));
process.env.USE_PGLITE = '1';
process.env.PGLITE_DATA_DIR = dataDir;

let closeDb: typeof import('../src/db/client.js').closeDb;
let query: typeof import('../src/db/client.js').query;
let iot: typeof import('../src/services/iot.js');

const USER_A = '00000000-0000-4000-8000-0000000000a1';
const USER_B = '00000000-0000-4000-8000-0000000000b2';

before(async () => {
  ({ closeDb, query } = await import('../src/db/client.js'));
  iot = await import('../src/services/iot.js');

  await query(`CREATE TABLE users (
    id UUID PRIMARY KEY,
    username TEXT NOT NULL,
    password_hash TEXT NOT NULL DEFAULT 'x',
    status TEXT NOT NULL DEFAULT 'active',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at TIMESTAMPTZ
  )`);
  for (const sql of IOT_MIGRATION_STATEMENTS) {
    await query(sql);
  }
  await query(`INSERT INTO users (id, username) VALUES ($1, 'a'), ($2, 'b')`, [USER_A, USER_B]);
});

after(async () => {
  await closeDb();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('iot bind', { concurrency: false }, () => {
  test('bind is idempotent for the same user and blocks another account', async () => {
    const first = await iot.bindIotDevice({ userId: USER_A, sn: 'sndemo0001', model: 'CIS IB' });
    assert.equal(first.sn, 'SNDEMO0001');
    assert.equal(first.model, 'CIS-IB');
    assert.equal(first.productKey, 'cis_ib');
    const again = await iot.bindIotDevice({ userId: USER_A, sn: 'SNDEMO0001', alias: '床旁' });
    assert.equal(again.alias, '床旁');
    assert.equal(again.model, 'CIS-IB');
    await assert.rejects(
      () => iot.bindIotDevice({ userId: USER_B, sn: 'SNDEMO0001' }),
      (err: unknown) => err instanceof iot.IotBindError && err.code === 'already_bound',
    );
  });

  test('latest and messages are scoped to the bound user', async () => {
    await query(
      `INSERT INTO iot_products (product_key, name) VALUES ('xiaomian_mvp', 'mvp')
       ON CONFLICT (product_key) DO NOTHING`,
    );
    await query(
      `INSERT INTO iot_messages_latest (sn, topic, product_key, raw_json, received_at)
       VALUES ('SNDEMO0001', 'xiaomian_mvp/SNDEMO0001/up/realtime', 'xiaomian_mvp', '{"hr": 61}'::jsonb, NOW())
       ON CONFLICT (sn, topic) DO UPDATE SET raw_json = EXCLUDED.raw_json`,
    );
    await query(
      `INSERT INTO iot_messages (product_key, sn, topic, raw_json)
       VALUES ('xiaomian_mvp', 'SNDEMO0001', 'xiaomian_mvp/SNDEMO0001/up/realtime', '{"hr": 61}'::jsonb)`,
    );

    const latest = await iot.getOwnedIotLatest(USER_A, 'sndemo0001');
    assert.equal((latest?.raw as { hr?: number })?.hr, 61);
    assert.equal(latest?.sleepRaw, undefined);

    await assert.rejects(
      () => iot.getOwnedIotLatest(USER_B, 'SNDEMO0001'),
      (err: unknown) => err instanceof iot.IotBindError && err.code === 'not_found',
    );

    const mine = await iot.listBoundIotDevices(USER_A);
    assert.equal(mine.length, 1);
    const other = await iot.listBoundIotDevices(USER_B);
    assert.equal(other.length, 0);
  });

  test('latest keeps realtime raw and attaches the last SleepReportNew', async () => {
    await iot.bindIotDevice({ userId: USER_A, sn: '14639369CE28', model: 'CIS IP' });
    const sleepPayload = {
      method: 'thing.property.post',
      params: {
        deviceName: '14639369CE28',
        SleepReportNew: {
          moving: 1,
          person: 1,
          snoreStatus: 2,
          snoreKill: 0,
          db: 38,
          heartRate: 66,
          breathing: 16,
        },
      },
    };
    const realtimePayload = {
      method: 'thing.property.post',
      params: {
        deviceName: '14639369CE28',
        deviceStatus: { heart: 0, person: 0, breathing: 0 },
      },
    };
    await query(
      `INSERT INTO iot_messages (product_key, sn, topic, raw_json, received_at)
       VALUES
         ('cis_ip', '14639369CE28', '/sys/cis_ip/14639369CE28/thing/property/post', $1::jsonb, NOW() - INTERVAL '2 minutes'),
         ('cis_ip', '14639369CE28', '/sys/cis_ip/14639369CE28/thing/property/post', $2::jsonb, NOW())`,
      [JSON.stringify(sleepPayload), JSON.stringify(realtimePayload)],
    );
    await query(
      `INSERT INTO iot_messages_latest (sn, topic, product_key, raw_json, received_at)
       VALUES ('14639369CE28', '/sys/cis_ip/14639369CE28/thing/property/post', 'cis_ip', $1::jsonb, NOW())
       ON CONFLICT (sn, topic) DO UPDATE SET raw_json = EXCLUDED.raw_json, received_at = EXCLUDED.received_at`,
      [JSON.stringify(realtimePayload)],
    );

    const latest = await iot.getOwnedIotLatest(USER_A, '14639369CE28');
    assert.equal((latest?.raw as { params?: { deviceStatus?: { heart?: number } } })?.params?.deviceStatus?.heart, 0);
    assert.equal(
      (latest?.sleepRaw as { params?: { SleepReportNew?: { heartRate?: number; moving?: number } } })
        ?.params?.SleepReportNew?.heartRate,
      66,
    );
    assert.equal(
      (latest?.sleepRaw as { params?: { SleepReportNew?: { moving?: number } } })?.params?.SleepReportNew?.moving,
      1,
    );
    assert.ok(latest?.sleepReceivedAt);
  });

  test('latest attaches characteristic separately from realtime', async () => {
    await iot.bindIotDevice({ userId: USER_A, sn: '94A990CA5268', model: 'CIS ISWB' });
    const configPayload = {
      method: 'thing.property.post',
      params: {
        productKey: 'cis_iswb',
        deviceName: '94A990CA5268',
        firmwareVer: 'ALISWB21-260827A',
        characteristic: {
          bleName: 'AL-ISWB21200-94A990CA5268',
          reportIerVal: 60,
          heatNum: 2,
          minPressure: 800,
          maxPressure: 12000,
        },
      },
    };
    const realtimePayload = {
      method: 'thing.property.post',
      params: {
        deviceName: '94A990CA5268',
        heartData: [0, 0, 0, 0, 0, 0],
        pressureLeft: 686,
      },
    };
    await query(
      `INSERT INTO iot_messages (product_key, sn, topic, raw_json, received_at)
       VALUES
         ('cis_iswb', '94A990CA5268', '/sys/cis_iswb/94A990CA5268/thing/property/post', $1::jsonb, NOW() - INTERVAL '1 hour'),
         ('cis_iswb', '94A990CA5268', '/sys/cis_iswb/94A990CA5268/thing/property/post', $2::jsonb, NOW())`,
      [JSON.stringify(configPayload), JSON.stringify(realtimePayload)],
    );
    await query(
      `INSERT INTO iot_messages_latest (sn, topic, product_key, raw_json, received_at)
       VALUES ('94A990CA5268', '/sys/cis_iswb/94A990CA5268/thing/property/post', 'cis_iswb', $1::jsonb, NOW())
       ON CONFLICT (sn, topic) DO UPDATE SET raw_json = EXCLUDED.raw_json, received_at = EXCLUDED.received_at`,
      [JSON.stringify(realtimePayload)],
    );

    const latest = await iot.getOwnedIotLatest(USER_A, '94A990CA5268');
    assert.equal((latest?.raw as { params?: { pressureLeft?: number } })?.params?.pressureLeft, 686);
    assert.equal(
      (latest?.configRaw as { params?: { firmwareVer?: string } })?.params?.firmwareVer,
      'ALISWB21-260827A',
    );
    assert.equal(
      (latest?.configRaw as { params?: { characteristic?: { heatNum?: number } } })?.params?.characteristic?.heatNum,
      2,
    );
  });

  test('unbind removes ownership', async () => {
    await iot.unbindIotDevice(USER_A, 'SNDEMO0001');
    await assert.rejects(
      () => iot.getOwnedIotLatest(USER_A, 'SNDEMO0001'),
      (err: unknown) => err instanceof iot.IotBindError && err.code === 'not_found',
    );
  });

  test('only the bound account can invoke, and payload is published', async () => {
    const { setIotDownlinkPublisher } = await import('../src/services/iotDownlink.js');
    await iot.bindIotDevice({ userId: USER_A, sn: '744DBD7785D4', model: 'CIS IB' });
    const published: Array<{ productKey: string; sn: string; payload: unknown }> = [];
    setIotDownlinkPublisher(async (input) => {
      published.push(input);
      return { topic: `/sys/${input.productKey}/${input.sn}/thing/service/invoke` };
    });
    try {
      const result = await iot.invokeOwnedIotCommand({
        userId: USER_A,
        sn: '744dbd7785d4',
        productKey: 'cis_ib',
        service: 'socketStatus',
        params: { status: 1 },
      });
      assert.equal(result.topic, '/sys/cis_ib/744DBD7785D4/thing/service/invoke');
      assert.equal(published.length, 1);
      assert.deepEqual(published[0]?.payload, {
        method: 'thing.service.invoke',
        params: { socketStatus: { status: 1 } },
      });

      await assert.rejects(
        () => iot.invokeOwnedIotCommand({
          userId: USER_B,
          sn: '744DBD7785D4',
          service: 'socketStatus',
          params: { status: 0 },
        }),
        (err: unknown) => err instanceof iot.IotBindError && err.code === 'not_found',
      );

      await assert.rejects(
        () => iot.invokeOwnedIotCommand({
          userId: USER_A,
          sn: '744DBD7785D4',
          service: 'setAppInit',
          params: {},
        }),
        (err: unknown) => err instanceof iot.IotBindError && err.code === 'invalid_command',
      );
    } finally {
      setIotDownlinkPublisher(null);
    }
  });

  test('CIS-IP bind prefers cis_ip even if client sends xiaomian_mvp', async () => {
    const bound = await iot.bindIotDevice({
      userId: USER_A,
      sn: '14639369CE28',
      model: 'CIS-IP',
      productKey: 'xiaomian_mvp',
    });
    assert.equal(bound.productKey, 'cis_ip');
    const listed = await iot.listBoundIotDevices(USER_A);
    const pillow = listed.filter((d) => d.sn === '14639369CE28');
    assert.equal(pillow.length, 1);
    assert.equal(pillow[0]?.productKey, 'cis_ip');
  });
});
