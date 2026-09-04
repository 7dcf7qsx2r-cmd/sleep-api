import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  aggregatePillowEpoch,
  aggregateTickGroups,
  epochStartMs,
  extractPillowTick,
  extractSleepReport,
  type PillowTick,
  type SleepEpoch,
} from '../src/services/iotSleepEpochMath.js';
import { estimatePillowSleep } from '../src/services/iotSleepEstimate.js';
import { sleepNightDate } from '../src/utils/civilDate.js';

const dataDir = mkdtempSync(join(tmpdir(), 'sleep-api-epoch-'));
process.env.USE_PGLITE = '1';
process.env.PGLITE_DATA_DIR = dataDir;

const EPOCH_MS = 30_000;

function tick(atMs: number, extra: Partial<PillowTick> = {}): PillowTick {
  return {
    atMs,
    person: 0,
    heart: 0,
    breathing: 0,
    pressureLeft: 3005,
    pressureRight: 2920,
    ...extra,
  };
}

function epoch(startMs: number, extra: Partial<SleepEpoch> = {}): SleepEpoch {
  return {
    epochStartMs: startMs,
    nightDate: '2026-09-05',
    sampleCount: 30,
    inBedRatio: 1,
    hrMean: 62,
    hrMin: 60,
    hrStd: 1,
    brMean: 14,
    brStd: 0.4,
    pMean: 7600,
    motion: 0.05,
    snoreCount: null,
    snoreDbMax: null,
    movingFlag: 0,
    quality: 'ok',
    ...extra,
  };
}

describe('cis_ip epoch math', () => {
  test('sleepNightDate uses Shanghai noon as the cut', () => {
    assert.equal(sleepNightDate(new Date('2026-09-04T03:59:00.000Z')), '2026-09-04');
    assert.equal(sleepNightDate(new Date('2026-09-04T04:00:00.000Z')), '2026-09-05');
    assert.equal(sleepNightDate(new Date('2026-09-04T08:28:00.000Z')), '2026-09-05');
  });

  test('off-pillow zeros are not a heart rate of 0', () => {
    const start = Date.parse('2026-09-04T08:28:00.000Z');
    const pressures: Array<[number, number]> = [
      [3005, 2917],
      [3007, 2920],
      [3008, 2922],
      [3005, 2920],
    ];
    const ticks: PillowTick[] = [];
    for (let i = 0; i < 30; i += 1) {
      const pair = pressures[Math.min(i, pressures.length - 1)]!;
      ticks.push(
        tick(start + i * 1000, {
          person: 0,
          heart: 0,
          breathing: 0,
          pressureLeft: pair[0],
          pressureRight: pair[1],
        }),
      );
    }
    const got = aggregatePillowEpoch(start, ticks);
    assert.equal(got.sampleCount, 30);
    assert.equal(got.inBedRatio, 0);
    assert.equal(got.hrMean, null);
    assert.equal(got.brMean, null);
    assert.equal(got.quality, 'ok');
    assert.ok(got.motion < 0.1);
    assert.equal(got.nightDate, '2026-09-05');
  });

  test('in-bed heart/breath ignore person=0 samples and use SleepReport moving floor', () => {
    const start = Date.parse('2026-09-04T18:14:00.000Z');
    const ticks: PillowTick[] = [];
    for (let i = 0; i < 30; i += 1) {
      ticks.push(
        tick(start + i * 1000, {
          person: 1,
          heart: 62,
          breathing: 14,
          pressureLeft: 7410 + (i % 3),
          pressureRight: 7880 + (i % 2),
        }),
      );
    }
    ticks[3] = tick(start + 3000, { person: 0, heart: 0, breathing: 0, pressureLeft: 7410, pressureRight: 7880 });
    const got = aggregatePillowEpoch(start, ticks, [
      { atMs: start + 11_000, moving: 1, snoreCount: 2, snoreDb: 38 },
    ]);
    assert.equal(got.inBedRatio, 29 / 30);
    assert.equal(got.hrMean, 62);
    assert.equal(got.brMean, 14);
    assert.equal(got.movingFlag, 1);
    assert.ok(got.motion >= 0.5);
    assert.equal(got.snoreCount, 2);
    assert.equal(got.snoreDbMax, 38);
  });

  test('realtime snoreStatus is not a snore count', () => {
    const raw = {
      params: {
        deviceStatus: { person: 1, heart: 60, breathing: 14, snoreStatus: 1, pressureLeft: 7000, pressureRight: 7000 },
        SleepReportNew: { moving: 0, snoreStatus: 4, db: 41 },
      },
    };
    const at = Date.parse('2026-09-04T18:00:00.000Z');
    const t = extractPillowTick('/sys/cis_ip/14639369CCDC/thing/property/post', raw, at);
    const report = extractSleepReport(raw, at);
    assert.ok(t);
    assert.equal(t.heart, 60);
    assert.equal(report?.snoreCount, 4);
    const grouped = aggregateTickGroups([t!], [report!]);
    assert.equal(grouped[0]?.snoreCount, 4);
  });

  test('epochStart floors to 30s', () => {
    const t = Date.parse('2026-09-04T08:28:17.000Z');
    assert.equal(epochStartMs(t), Date.parse('2026-09-04T08:28:00.000Z'));
  });
});

describe('cis_ip sleep estimate', () => {
  test('needs ~15 min quiet in-bed before onset, then 10 min off-bed to wake', () => {
    const start = Date.parse('2026-09-04T18:00:00.000Z');
    const epochs: SleepEpoch[] = [];
    for (let i = 0; i < 60; i += 1) {
      epochs.push(epoch(start + i * EPOCH_MS, { motion: 0.05 }));
    }
    for (let i = 60; i < 80; i += 1) {
      epochs.push(epoch(start + i * EPOCH_MS, { inBedRatio: 0, hrMean: null, brMean: null, motion: 0.04 }));
    }
    const got = estimatePillowSleep(epochs, '2026-09-05');
    assert.equal(got.sleepStart, new Date(start).toISOString());
    assert.equal(got.sleepEnd, new Date(start + 60 * EPOCH_MS).toISOString());
    assert.equal(got.durationMinutes, 30);
    assert.equal(got.deepMinutes, 20);
    assert.equal(got.lightMinutes, 10);
    assert.equal(got.remMinutes, 0);
    assert.equal(got.awakeMinutes, 0);
    assert.equal(got.awakenings, 0);
    assert.equal(got.source, 'cis_ip');
  });

  test('off-pillow afternoon does not look like sleep', () => {
    const start = Date.parse('2026-09-04T08:00:00.000Z');
    const epochs = Array.from({ length: 40 }, (_, i) =>
      epoch(start + i * EPOCH_MS, { inBedRatio: 0, hrMean: null, motion: 0.05 }),
    );
    const got = estimatePillowSleep(epochs);
    assert.equal(got.durationMinutes, 0);
    assert.equal(got.sleepStart, null);
    assert.equal(got.confidence, 'low');
  });

  test('short off-bed after onset counts as WASO, not a new night', () => {
    const start = Date.parse('2026-09-04T18:00:00.000Z');
    const epochs: SleepEpoch[] = [];
    for (let i = 0; i < 40; i += 1) {
      const off = i >= 32 && i < 40;
      epochs.push(
        epoch(start + i * EPOCH_MS, {
          inBedRatio: off ? 0 : 1,
          motion: 0.05,
          hrMean: off ? null : 62,
        }),
      );
    }
    const got = estimatePillowSleep(epochs, '2026-09-05');
    assert.ok(got.sleepStart);
    assert.equal(got.awakenings, 1);
    assert.equal(got.awakeMinutes, 4);
    assert.equal(got.durationMinutes, 16);
  });
});

describe('cis_ip epoch catch-up', { concurrency: false }, () => {
  let closeDb: typeof import('../src/db/client.js').closeDb;
  let query: typeof import('../src/db/client.js').query;
  let catchUp: typeof import('../src/services/iotSleepEpochs.js').catchUpPillowSleepEpochs;
  let listEpochs: typeof import('../src/services/iotSleepEpochs.js').listSleepEpochs;
  let purge: typeof import('../src/services/iotSleepEpochs.js').purgeExpiredSleepEpochs;

  before(async () => {
    const { IOT_MIGRATION_STATEMENTS } = await import('../src/db/iotSchema.js');
    ({ closeDb, query } = await import('../src/db/client.js'));
    const svc = await import('../src/services/iotSleepEpochs.js');
    catchUp = svc.catchUpPillowSleepEpochs;
    listEpochs = svc.listSleepEpochs;
    purge = svc.purgeExpiredSleepEpochs;
    for (const sql of IOT_MIGRATION_STATEMENTS) {
      await query(sql);
    }
    await query(
      `INSERT INTO iot_products (product_key, name) VALUES ('cis_ip', 'pillow')
       ON CONFLICT (product_key) DO NOTHING`,
    );
    await query(
      `INSERT INTO iot_devices (sn, product_key, device_secret)
       VALUES ('14639369CCDC', 'cis_ip', 'x')
       ON CONFLICT (sn) DO NOTHING`,
    );
  });

  after(async () => {
    await closeDb();
    rmSync(dataDir, { recursive: true, force: true });
  });

  test('aggregates a closed 30s window and drops 4-day-old epochs', async () => {
    const start = Math.floor((Date.now() - 120_000) / EPOCH_MS) * EPOCH_MS;
    const topic = '/sys/cis_ip/14639369CCDC/thing/property/post';
    for (let i = 0; i < 30; i += 1) {
      const payload = {
        method: 'thing.property.post',
        params: {
          deviceName: '14639369CCDC',
          deviceStatus: {
            person: 1,
            heart: 64,
            breathing: 15,
            pressureLeft: 7410,
            pressureRight: 7880,
          },
        },
      };
      await query(
        `INSERT INTO iot_messages (product_key, sn, topic, raw_json, received_at)
         VALUES ('cis_ip', '14639369CCDC', $1, $2::jsonb, $3::timestamptz)`,
        [topic, JSON.stringify(payload), new Date(start + i * 1000).toISOString()],
      );
    }
    const result = await catchUp('14639369CCDC', Date.now());
    assert.ok(result.epochs >= 1);
    const nightDate = sleepNightDate(new Date(start));
    const rows = await listEpochs('14639369CCDC', nightDate);
    const hit = rows.find((r) => r.epochStartMs === start);
    assert.ok(hit);
    assert.equal(hit.sampleCount, 30);
    assert.equal(hit.inBedRatio, 1);
    assert.equal(hit.hrMean, 64);
    assert.equal(hit.quality, 'ok');

    await query(
      `INSERT INTO iot_sleep_epochs (
         sn, epoch_start, product_key, night_date, sample_count, in_bed_ratio, motion, quality
       ) VALUES (
         '14639369CCDC', NOW() - INTERVAL '4 days', 'cis_ip', '2026-08-30', 30, 0, 0.01, 'ok'
       )`,
    );
    await purge();
    const leftover = await query(
      `SELECT count(*)::int AS n FROM iot_sleep_epochs
       WHERE sn = '14639369CCDC' AND epoch_start < NOW() - INTERVAL '3 days'`,
    );
    assert.equal(leftover.rows[0]?.n, 0);
  });
});
