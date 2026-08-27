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

    await assert.rejects(
      () => iot.getOwnedIotLatest(USER_B, 'SNDEMO0001'),
      (err: unknown) => err instanceof iot.IotBindError && err.code === 'not_found',
    );

    const mine = await iot.listBoundIotDevices(USER_A);
    assert.equal(mine.length, 1);
    const other = await iot.listBoundIotDevices(USER_B);
    assert.equal(other.length, 0);
  });

  test('unbind removes ownership', async () => {
    await iot.unbindIotDevice(USER_A, 'SNDEMO0001');
    await assert.rejects(
      () => iot.getOwnedIotLatest(USER_A, 'SNDEMO0001'),
      (err: unknown) => err instanceof iot.IotBindError && err.code === 'not_found',
    );
  });
});
