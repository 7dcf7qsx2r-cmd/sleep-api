import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  EPOCH_MS,
  MOTION_CALIBRATION,
  aggregatePillowEpoch,
  respirationFromTicks,
  smoothedMotionPa,
  type PillowTick,
  type SleepEpoch,
} from '../src/services/iotSleepEpochMath.js';
import { classifyPillowNight } from '../src/services/iotSleepEstimate.js';

const T0 = Date.parse('2026-09-09T17:00:00.000Z');

function seeded(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648 - 0.5;
  };
}

function pressureTicks(
  startMs: number,
  seconds: number,
  right: (t: number) => number,
  left: (t: number) => number = () => 255,
  extra: Partial<PillowTick> = {},
): PillowTick[] {
  return Array.from({ length: seconds }, (_, t) => ({
    atMs: startMs + t * 1000,
    person: 1,
    heart: 66,
    breathing: 15,
    pressureLeft: Math.round(left(t)),
    pressureRight: Math.round(right(t)),
    actuating: 0 as const,
    ...extra,
  }));
}

describe('气压呼吸提取', () => {
  test('头压气囊上 15 次/分 的呼吸起伏可被检出', () => {
    const noise = seeded(7);
    const ticks = pressureTicks(T0, 120, (t) => 1110 + 12 * Math.sin(2 * Math.PI * 0.25 * t) + 3 * noise());
    const r = respirationFromTicks(ticks, T0 + 120_000);
    assert.ok(r);
    assert.ok(Math.abs(r.rate - 15) < 1, `rate=${r.rate}`);
    assert.ok(r.prom > 50, `prom=${r.prom}`);
  });

  test('空枕（仅 ±1Pa 量化噪声）不应出现显著呼吸峰', () => {
    const noise = seeded(11);
    const ticks = pressureTicks(T0, 120, () => 55 + Math.round(2 * noise()), () => 273 + Math.round(2 * noise()), { person: 0 });
    const r = respirationFromTicks(ticks, T0 + 120_000);
    assert.ok(!r || r.prom < 20, `prom=${r?.prom}`);
  });

  test('呼吸起伏不算体动，翻身算', () => {
    const breathing = pressureTicks(T0, 60, (t) => 1110 + 14 * Math.sin(2 * Math.PI * 0.25 * t));
    const quiet = smoothedMotionPa(breathing, T0 + 30_000)!;
    assert.ok(quiet < 15, `breathing TV=${quiet}`);
    const turn = pressureTicks(T0, 60, (t) => (t < 45 ? 1110 : 300), (t) => (t < 45 ? 255 : 1050));
    const moved = smoothedMotionPa(turn, T0 + 30_000)!;
    assert.ok(moved > 1000, `turn TV=${moved}`);
  });

  test('epoch 聚合带出呼吸特征与左右气压；气囊动作被标记', () => {
    const window = pressureTicks(T0, 120, (t) => 1110 + 12 * Math.sin(2 * Math.PI * 0.25 * t));
    window[100]!.actuating = 1;
    const start = T0 + 90_000;
    const own = window.filter((t) => t.atMs >= start);
    const e = aggregatePillowEpoch(start, own, [], MOTION_CALIBRATION.cis_ip, window);
    assert.ok(e.respRate != null && Math.abs(e.respRate - 15) < 1);
    assert.equal(e.actuating, 1);
    assert.ok(e.pRight != null && Math.abs(e.pRight - 1110) < 15);
    assert.ok(e.motion < 0.05);
  });
});

type Kind = 'sleepRegular' | 'sleep' | 'sideNoFw' | 'levelOnly' | 'airbag' | 'restless' | 'empty';

function epochOf(i: number, kind: Kind, rate = 15): SleepEpoch {
  const base: SleepEpoch = {
    epochStartMs: T0 + i * EPOCH_MS,
    nightDate: '2026-09-10',
    sampleCount: 30,
    inBedRatio: 1,
    hrMean: 66,
    hrMin: 60,
    hrStd: 4,
    brMean: 15,
    brStd: 0.8,
    pMean: 680,
    motion: 0,
    snoreCount: null,
    snoreDbMax: null,
    movingFlag: 1,
    quality: 'ok',
    respRate: rate,
    respProm: 35,
    respAmp: 8,
    actuating: 0,
    pLeft: 255,
    pRight: 1110,
  };
  switch (kind) {
    case 'sleepRegular':
      return { ...base, respProm: 150, respAmp: 10 };
    case 'sleep':
      return base;
    case 'sideNoFw':
      return { ...base, inBedRatio: 0, respProm: 45 };
    case 'levelOnly':
      return { ...base, inBedRatio: 0, respProm: 6, respAmp: 1.5, respRate: 22 };
    case 'airbag':
      return { ...base, motion: 1, actuating: 1, respProm: 4, respAmp: 300 };
    case 'restless':
      return { ...base, motion: 0.6, respProm: 5, respAmp: 120 };
    case 'empty':
      return { ...base, inBedRatio: 0, motion: 0, respProm: 8, respAmp: 1.2, respRate: 20 + (i % 3) * 3, pLeft: 270, pRight: 60, pMean: 165 };
  }
}

function night(plan: Array<[Kind, number]>): SleepEpoch[] {
  const out: SleepEpoch[] = [];
  for (const [kind, count] of plan) {
    for (let k = 0; k < count; k += 1) out.push(epochOf(out.length, kind));
  }
  return out;
}

const iso = (i: number) => new Date(T0 + i * EPOCH_MS).toISOString();

describe('气压呼吸分期（cis_ip）', () => {
  test('助眠气囊动作不算清醒，也不推迟入睡', () => {
    const epochs = night([['empty', 40], ['airbag', 40], ['sleep', 60], ['empty', 60]]);
    const { estimate, stages } = classifyPillowNight(epochs, '2026-09-10', 'cis_ip');
    // 气囊停止后再屏蔽 ACTUATOR_SETTLE_EPOCHS(2) 个 epoch 等气压回稳
    assert.equal(estimate.sleepStart, iso(82));
    assert.equal(stages[50]!.stage, 'unknown');
    assert.equal(estimate.durationMinutes, 29);
  });

  test('固件误报离枕（侧睡/偏头）但呼吸仍在 → 不截断这一夜', () => {
    const epochs = night([['empty', 40], ['sleep', 200], ['sideNoFw', 300], ['empty', 80]]);
    const { estimate } = classifyPillowNight(epochs, '2026-09-10', 'cis_ip');
    assert.equal(estimate.sleepStart, iso(40));
    assert.equal(estimate.sleepEnd, iso(540));
    assert.equal(estimate.durationMinutes, 250);
  });

  test('无呼吸峰但气压明显高于空枕基线 → 仍在枕', () => {
    const epochs = night([['empty', 60], ['sleep', 120], ['levelOnly', 60], ['sleep', 60], ['empty', 60]]);
    const { estimate, stages } = classifyPillowNight(epochs, '2026-09-10', 'cis_ip');
    assert.equal(estimate.sleepEnd, iso(300));
    assert.notEqual(stages[200]!.stage, 'off');
  });

  test('午睡与夜间睡眠离枕 >1h 分为两段，取更长的夜间段', () => {
    const epochs = night([['empty', 20], ['sleep', 80], ['empty', 300], ['sleep', 400], ['empty', 60]]);
    const { estimate } = classifyPillowNight(epochs, '2026-09-10', 'cis_ip');
    assert.equal(estimate.sleepStart, iso(400));
    assert.equal(estimate.durationMinutes, 200);
  });

  test('前半夜规律呼吸 → 深睡；入睡 1h 后不规律但信号在 → REM；不输出固件心率', () => {
    const epochs = night([
      ['empty', 20],
      ['sleep', 40],
      ['sleepRegular', 40],
      ['sleep', 100],
      ['restless', 2],
      ['sleep', 20],
      ['empty', 0],
    ]);
    const remStart = epochs.length;
    for (let k = 0; k < 30; k += 1) epochs.push({ ...epochOf(remStart + k, 'sleep'), respProm: 5, respAmp: 6 });
    const tail = epochs.length;
    for (let k = 0; k < 60; k += 1) epochs.push(epochOf(tail + k, 'sleep'));
    const end = epochs.length;
    for (let k = 0; k < 60; k += 1) epochs.push(epochOf(end + k, 'empty'));

    const { estimate, stages } = classifyPillowNight(epochs, '2026-09-10', 'cis_ip');
    assert.equal(stages[80]!.stage, 'deep');
    assert.equal(stages[remStart + 15]!.stage, 'rem');
    assert.ok(estimate.deepMinutes >= 15, `deep=${estimate.deepMinutes}`);
    assert.ok(estimate.remMinutes >= 10, `rem=${estimate.remMinutes}`);
    assert.equal(estimate.avgHeartRate, null);
    assert.equal(estimate.avgBreathRate, 15);
  });

  test('无呼吸特征的旧 epoch 仍走体动算法', () => {
    const epochs = night([['empty', 10], ['sleep', 60], ['empty', 30]]).map((e) => ({
      ...e,
      respProm: null,
      respRate: null,
      respAmp: null,
    }));
    const { method, estimate } = classifyPillowNight(epochs, '2026-09-10', 'cis_ip');
    assert.equal(method, 'motion');
    assert.equal(estimate.durationMinutes, 30);
  });
});
