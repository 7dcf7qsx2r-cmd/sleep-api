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

  test('latest prefers fresh iot_messages over stale iot_messages_latest', async () => {
    await iot.bindIotDevice({ userId: USER_A, sn: '14639369D06C', model: 'CIS-IP' });
    const stalePayload = {
      method: 'thing.property.post',
      params: { deviceStatus: { person: 0, pressureLeft: 100, pressureRight: 100 } },
    };
    const freshPayload = {
      method: 'thing.property.post',
      params: { deviceStatus: { person: 0, pressureLeft: 137, pressureRight: 805 } },
    };
    await query(
      `INSERT INTO iot_messages_latest (sn, topic, product_key, raw_json, received_at)
       VALUES ('14639369D06C', '/sys/cis_ip/14639369D06C/thing/property/post', 'cis_ip', $1::jsonb, NOW() - INTERVAL '1 day')
       ON CONFLICT (sn, topic) DO UPDATE SET raw_json = EXCLUDED.raw_json, received_at = EXCLUDED.received_at`,
      [JSON.stringify(stalePayload)],
    );
    await query(
      `INSERT INTO iot_messages (product_key, sn, topic, raw_json, received_at)
       VALUES ('cis_ip', '14639369D06C', '/sys/cis_ip/14639369D06C/thing/property/post', $1::jsonb, NOW())`,
      [JSON.stringify(freshPayload)],
    );

    const latest = await iot.getOwnedIotLatest(USER_A, '14639369D06C');
    assert.equal(
      (latest?.raw as { params?: { deviceStatus?: { pressureLeft?: number } } })?.params?.deviceStatus?.pressureLeft,
      137,
    );
    const listed = await iot.listBoundIotDevices(USER_A);
    assert.equal(listed.find((d) => d.sn === '14639369D06C')?.online, true);
  });

  test('newer sleep-only property post does not replace realtime', async () => {
    await iot.bindIotDevice({ userId: USER_A, sn: '14639369CE29', model: 'CIS-IP' });
    const realtimePayload = {
      method: 'thing.property.post',
      params: { deviceStatus: { person: 1, heart: 61, breathing: 14, pressureLeft: 1594 } },
    };
    const sleepOnly = {
      method: 'thing.property.post',
      params: { deviceName: '14639369CE29', SleepReportNew: { moving: 1, person: 1, heartRate: 61, breathing: 14 } },
    };
    await query(
      `INSERT INTO iot_messages (product_key, sn, topic, raw_json, received_at)
       VALUES
         ('cis_ip', '14639369CE29', '/sys/cis_ip/14639369CE29/thing/property/post', $1::jsonb, NOW() - INTERVAL '2 seconds'),
         ('cis_ip', '14639369CE29', '/sys/cis_ip/14639369CE29/thing/property/post', $2::jsonb, NOW())`,
      [JSON.stringify(realtimePayload), JSON.stringify(sleepOnly)],
    );

    const latest = await iot.getOwnedIotLatest(USER_A, '14639369CE29');
    assert.equal(
      (latest?.raw as { params?: { deviceStatus?: { pressureLeft?: number } } })?.params?.deviceStatus?.pressureLeft,
      1594,
    );
    assert.equal(
      (latest?.sleepRaw as { params?: { SleepReportNew?: { moving?: number } } })?.params?.SleepReportNew?.moving,
      1,
    );
  });

  test('mattress and lumbar realtime posts survive a newer sleep-only post', async () => {
    for (const [sn, model, realtimeParams, sleepParams] of [
      [
        '14639369AB01', 'CIS-IB',
        { deviceName: 'IB', airbagsPressure: [6, 206, 249, -52, 39, 48, 86, -100], motorHeight: [1350, 1550] },
        { deviceName: 'IB', ibNew: [1, 0, 0, 15, 61, 0, 2, 0, 0, 0, 0, 0] },
      ],
      [
        '14639369AB02', 'CIS-ISWB',
        { deviceName: 'ISWB', heatData: [1, 35, 1, 0, 28, 0] },
        { deviceName: 'ISWB', ISWBSleepReport: [1, 0, 16, 72, 0, 0, 0, 0, 0, 0] },
      ],
    ] as const) {
      const bound = await iot.bindIotDevice({ userId: USER_A, sn, model });
      await query(
        `INSERT INTO iot_messages (product_key, sn, topic, raw_json, received_at)
         VALUES
           ($1, $2, $3, $4::jsonb, NOW() - INTERVAL '2 seconds'),
           ($1, $2, $3, $5::jsonb, NOW())`,
        [
          bound.productKey,
          sn,
          `/sys/${bound.productKey}/${sn}/thing/property/post`,
          JSON.stringify({ method: 'thing.property.post', params: realtimeParams }),
          JSON.stringify({ method: 'thing.property.post', params: sleepParams }),
        ],
      );

      const latest = await iot.getOwnedIotLatest(USER_A, sn);
      const params = (latest?.raw as { params?: Record<string, unknown> })?.params ?? {};
      assert.ok(params.airbagsPressure || params.heatData, `${model} latest should be the realtime post`);
      assert.equal(params.ibNew, undefined);
      assert.equal(params.ISWBSleepReport, undefined);
      const listed = await iot.listBoundIotDevices(USER_A);
      assert.equal(listed.find((d) => d.sn === sn)?.online, true);
    }
  });

  test('latest ignores service invoke even if it is newer', async () => {
    await iot.bindIotDevice({ userId: USER_A, sn: '14639369CCDC', model: 'CIS-IP' });
    const propertyPayload = {
      method: 'thing.property.post',
      params: { deviceStatus: { person: 0, heart: 0, breathing: 0, pressureLeft: 137 } },
    };
    const invokePayload = {
      method: 'thing.service.invoke',
      params: { duration: 20, sleepStall: 1, sleepLowTime: 3, sleepHeightTime: 3 },
    };
    await query(
      `INSERT INTO iot_messages (product_key, sn, topic, raw_json, received_at)
       VALUES
         ('cis_ip', '14639369CCDC', '/sys/cis_ip/14639369CCDC/thing/property/post', $1::jsonb, NOW() - INTERVAL '30 seconds'),
         ('cis_ip', '14639369CCDC', '/sys/cis_ip/14639369CCDC/thing/service/invoke', $2::jsonb, NOW())`,
      [JSON.stringify(propertyPayload), JSON.stringify(invokePayload)],
    );

    const latest = await iot.getOwnedIotLatest(USER_A, '14639369CCDC');
    assert.equal(latest?.topic, '/sys/cis_ip/14639369CCDC/thing/property/post');
    assert.equal(
      (latest?.raw as { params?: { deviceStatus?: { pressureLeft?: number } } })?.params?.deviceStatus?.pressureLeft,
      137,
    );

    const listed = await iot.listBoundIotDevices(USER_A);
    const pillow = listed.find((d) => d.sn === '14639369CCDC');
    assert.equal(pillow?.online, true);
  });

  test('latest returns null when only downlink invoke exists', async () => {
    await iot.bindIotDevice({ userId: USER_A, sn: '14639369DDEE', model: 'CIS-IP' });
    await query(
      `INSERT INTO iot_messages_latest (sn, topic, product_key, raw_json, received_at)
       VALUES ('14639369DDEE', '/sys/cis_ip/14639369DDEE/thing/service/invoke', 'cis_ip', $1::jsonb, NOW())
       ON CONFLICT (sn, topic) DO UPDATE SET raw_json = EXCLUDED.raw_json, received_at = EXCLUDED.received_at`,
      [JSON.stringify({ method: 'thing.service.invoke', params: { duration: 20 } })],
    );
    const latest = await iot.getOwnedIotLatest(USER_A, '14639369DDEE');
    assert.equal(latest, null);
    const listed = await iot.listBoundIotDevices(USER_A);
    assert.equal(listed.find((d) => d.sn === '14639369DDEE')?.online, false);
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

  test('unbind drops CIS binding even if client sends the default productKey', async () => {
    const sn = 'CISUNBIND0001';
    await iot.bindIotDevice({ userId: USER_A, sn, model: 'CIS-IP' });
    const before = await iot.listBoundIotDevices(USER_A);
    assert.equal(before.some((d) => d.sn === sn && d.productKey === 'cis_ip'), true);

    await iot.unbindIotDevice(USER_A, sn, 'xiaomian_mvp');

    const after = await iot.listBoundIotDevices(USER_A);
    assert.equal(after.some((d) => d.sn === sn), false);
    const rebound = await iot.bindIotDevice({ userId: USER_B, sn, model: 'CIS-IP' });
    assert.equal(rebound.productKey, 'cis_ip');
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
