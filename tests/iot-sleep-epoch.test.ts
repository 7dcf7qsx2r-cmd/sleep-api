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
  extractReport,
  extractSleepReport,
  extractTick,
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

  test('in-bed heart/breath ignore person=0 samples; unreliable moving flag no longer floors motion', () => {
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
    // movingFlag 仍被记录，但 cis_ip movingFloor=0 → 不再把安静睡眠强抬到 0.5 清醒级
    assert.equal(got.movingFlag, 1);
    assert.ok(got.motion < 0.1, `安静在枕不应因 moving=1 被抬升 (实际 ${got.motion})`);
    assert.equal(got.snoreCount, 2);
    assert.equal(got.snoreDbMax, 38);
  });

  test('physiological pressure jitter is not counted as body motion (baseline subtraction)', () => {
    const start = Date.parse('2026-09-04T18:20:00.000Z');
    const ticks: PillowTick[] = [];
    // 右气囊每秒抖动 ~12Pa（呼吸/心搏），左气囊 ~2Pa —— 属安静睡眠底噪
    for (let i = 0; i < 30; i += 1) {
      ticks.push(
        tick(start + i * 1000, {
          person: 1,
          heart: 65,
          breathing: 15,
          pressureLeft: 550 + (i % 2) * 2,
          pressureRight: 1510 + (i % 2) * 12,
        }),
      );
    }
    const got = aggregatePillowEpoch(start, ticks);
    // 旧实现 raw≈14 /80 = 0.175（压在入睡门槛 0.2）；新实现扣除 16Pa 底噪 → ~0
    assert.ok(got.motion < 0.05, `生理底噪不应算作体动 (实际 ${got.motion})`);
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

describe('multi-device tick/report extraction (cis_ib / cis_iswb)', () => {
  const at = Date.parse('2026-09-04T18:00:00.000Z');

  test('cis_ib mattress: airbagsPerson occupancy + HR + zone pressure', () => {
    const raw = {
      params: {
        HR: [63, 15, 0, 0, 0, 0], // 左：心率63 呼吸15；右：无人全0
        airbagsPerson: [1, 2], // 左有人(1)，右无人(2)
        airbagsPressure: [510, 505, 512, 508, 40, 41, 39, 42], // 左半在压，右半空
      },
    };
    const t = extractTick('cis_ib', '/sys/cis_ib/AAA/thing/property/post', raw, at);
    assert.ok(t);
    assert.equal(t.person, 1);
    assert.equal(t.heart, 63);
    assert.equal(t.breathing, 15);
    assert.ok(t.pressureLeft != null && t.pressureLeft > t.pressureRight!);
  });

  test('cis_ib mattress: unoccupied bed yields person=0', () => {
    const raw = { params: { HR: [0, 0, 0, 0, 0, 0], airbagsPerson: [2, 2], airbagsPressure: [40, 41, 39, 42, 40, 41, 39, 42] } };
    const t = extractTick('cis_ib', '/sys/cis_ib/AAA/thing/property/post', raw, at);
    assert.ok(t);
    assert.equal(t.person, 0);
  });

  test('cis_iswb lumbar mattress: heartData occupancy + L/R pressure', () => {
    const raw = {
      params: {
        heartData: [66, 16, 0, 0, 0, 0],
        pressureLeft: 620,
        pressureRight: 90,
      },
    };
    const t = extractTick('cis_iswb', '/sys/cis_iswb/BBB/thing/property/post', raw, at);
    assert.ok(t);
    assert.equal(t.person, 1);
    assert.equal(t.heart, 66);
    assert.equal(t.breathing, 16);
    assert.equal(t.pressureLeft, 620);
    assert.equal(t.pressureRight, 90);
  });

  test('cis_iswb report exposes moving flag from ISWBSleepReport', () => {
    const raw = { params: { ISWBSleepReport: [1, 0, 16, 66, 1, 0, 0, 0, 0, 0] } };
    const report = extractReport('cis_iswb', raw, at);
    assert.ok(report);
    assert.equal(report.moving, 1);
  });

  test('cis_ip path is unchanged through the generic dispatcher', () => {
    const raw = { params: { deviceStatus: { person: 1, heart: 60, breathing: 14, pressureLeft: 7000, pressureRight: 7000 } } };
    const t = extractTick('cis_ip', '/sys/cis_ip/CCC/thing/property/post', raw, at);
    assert.ok(t);
    assert.equal(t.heart, 60);
    assert.equal(t.person, 1);
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
    // 分期不可信门控:cis_ip 目前深睡并入「睡眠中」(light),不虚报深睡;总时长不受影响
    assert.equal(got.deepMinutes, 0);
    assert.equal(got.lightMinutes, 30);
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

  test('16-min toilet trip mid-night is WASO, session continues after re-entry (续夜)', () => {
    const start = Date.parse('2026-09-04T16:00:00.000Z');
    const epochs: SleepEpoch[] = [];
    const push = (n: number, inBed: boolean) => {
      for (let k = 0; k < n; k += 1) {
        epochs.push(
          epoch(start + epochs.length * EPOCH_MS, {
            inBedRatio: inBed ? 1 : 0,
            hrMean: inBed ? 62 : null,
            brMean: inBed ? 14 : null,
            motion: inBed ? 0.05 : 0.04,
          }),
        );
      }
    };
    push(40, true); // 入睡 + 睡眠
    push(32, false); // 起夜 16 分钟（> 旧的 10 分钟起床阈值）
    push(40, true); // 重新上床继续睡
    push(20, false); // 早晨最终起床
    const gapEnd = 40 + 32 + 40; // 最后一个在枕 epoch 之后

    const got = estimatePillowSleep(epochs, '2026-09-05');
    // 旧实现会在 06:xx 的 32-epoch 起夜处截断，丢弃后 40 个在枕 epoch
    assert.equal(got.sleepEnd, new Date(start + gapEnd * EPOCH_MS).toISOString());
    assert.equal(got.durationMinutes, 40, '两段在枕都应计入睡眠时长');
    assert.equal(got.awakeMinutes, 16, '中途起夜计为觉醒');
    assert.ok(got.awakenings >= 1);
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
