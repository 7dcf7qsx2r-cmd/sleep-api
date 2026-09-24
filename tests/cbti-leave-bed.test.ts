import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  EPOCH_MS,
  awakeLowerBound,
  detectTransitions,
  estimateNight,
  evaluateQualification,
  promptsAutoDisabled,
  soundThresholdFromFeedback,
  summarizeNight,
  type EstimatorContext,
  type EstimatorEpoch,
} from '../src/services/cbti/leaveBedEstimator.js';

const T0 = Date.UTC(2026, 9, 13, 15, 0);

type Kind = 'asleep' | 'restless' | 'out' | 'gap' | 'quiet_awake';

function build(plan: Array<[Kind, number]>): EstimatorEpoch[] {
  const epochs: EstimatorEpoch[] = [];
  let t = T0;
  for (const [kind, count] of plan) {
    for (let i = 0; i < count; i += 1) {
      if (kind !== 'gap') {
        epochs.push({
          startMs: t,
          inBed: kind === 'out' ? false : true,
          motion: kind === 'restless' ? 0.5 : kind === 'out' ? null : 0.05,
          hrMean: kind === 'restless' ? 70 : 55,
          hrStd: kind === 'restless' ? 6 : 1,
          brStd: kind === 'restless' ? 3 : 0.8,
        });
      }
      t += EPOCH_MS;
    }
  }
  return epochs;
}

function ctx(epochs: EstimatorEpoch[], patch: Partial<EstimatorContext> = {}): EstimatorContext {
  const nowMs = epochs[epochs.length - 1]!.startMs + EPOCH_MS;
  return {
    tier: 'bed',
    nowMs,
    wakeAnchorMs: nowMs + 4 * 3600_000,
    sleepHrBaseline: 55,
    preLightsMin: 0,
    flipLatencyMs: 0,
    qualified: true,
    shadow: false,
    soundAllowed: true,
    soundThresholdMin: 20,
    singleZoneSharedBed: false,
    promptsOff: false,
    appForegroundAtMs: [],
    priorPrompts: [],
    userOutByButton: false,
    ...patch,
  };
}

describe('离床、回床（连续 4 个 epoch）', () => {
  test('离床 2 分钟以上记一次离床和回床', () => {
    const epochs = build([['asleep', 20], ['out', 10], ['asleep', 10]]);
    const r = detectTransitions(epochs);
    assert.deepEqual(r.transitions.map((t) => t.kind), ['leave_bed', 'return_bed']);
    assert.equal(r.transitions[0]!.atMs, T0 + 20 * EPOCH_MS);
    assert.equal(r.state, 'in_bed');
  });

  test('不足 2 分钟的离床忽略', () => {
    const r = detectTransitions(build([['asleep', 20], ['out', 3], ['asleep', 10]]));
    assert.equal(r.transitions.length, 0);
  });

  test('连续 3 个缺包记为未知，不记离床', () => {
    const r = detectTransitions(build([['asleep', 20], ['gap', 5]]));
    assert.equal(r.transitions.length, 0);
  });
});

describe('躺着醒着多久', () => {
  test('保守下限低于预计值', () => {
    const { expected, lower } = awakeLowerBound(Array(50).fill(0.8));
    assert.ok(Math.abs(expected - 20) < 1e-9);
    assert.ok(lower < expected && lower > 17);
  });

  test('一直睡着不提示', () => {
    const epochs = build([['asleep', 120]]);
    const r = estimateNight(epochs, ctx(epochs));
    assert.equal(r.prompt, null);
    assert.ok(r.lowerBoundAwakeMin < 5);
  });

  test('辗转 25 分钟、多类线索一致：有声提醒', () => {
    const epochs = build([['asleep', 40], ['restless', 50]]);
    const r = estimateNight(epochs, ctx(epochs));
    assert.equal(r.prompt, 'sound');
    assert.ok(r.cues.includes('motion') && r.cues.includes('heart'));
  });

  test('用户选只要静默提醒', () => {
    const epochs = build([['asleep', 40], ['restless', 50]]);
    assert.equal(estimateNight(epochs, ctx(epochs, { soundAllowed: false })).prompt, 'silent');
  });

  test('未通过资格校验：只有在床打开小眠能触发静默提醒', () => {
    const epochs = build([['asleep', 40], ['restless', 50]]);
    const c = ctx(epochs, { qualified: false });
    assert.equal(estimateNight(epochs, c).prompt, null);
    assert.equal(estimateNight(epochs, { ...c, appForegroundAtMs: [c.nowMs - 60_000] }).prompt, 'silent');
  });

  test('影子期只记录不提示', () => {
    const epochs = build([['asleep', 40], ['restless', 50]]);
    const r = estimateNight(epochs, ctx(epochs, { shadow: true }));
    assert.equal(r.prompt, null);
    assert.equal(r.shadowPrompt, 'sound');
  });

  test('起床锚前 60 分钟内、只有智能枕、单区双人床都不提示', () => {
    const epochs = build([['asleep', 40], ['restless', 50]]);
    const base = ctx(epochs);
    assert.equal(estimateNight(epochs, { ...base, wakeAnchorMs: base.nowMs + 30 * 60_000 }).blockedBy, 'near_wake');
    assert.equal(estimateNight(epochs, { ...base, tier: 'pillow' }).blockedBy, 'pillow_tier');
    assert.equal(estimateNight(epochs, { ...base, singleZoneSharedBed: true }).blockedBy, 'shared_bed');
  });

  test('本段清醒已提示过不再提示；有声用满后降为静默', () => {
    const epochs = build([['asleep', 40], ['restless', 50]]);
    const base = ctx(epochs);
    assert.equal(
      estimateNight(epochs, { ...base, priorPrompts: [{ level: 'silent', atMs: base.nowMs - 60_000 }] }).blockedBy,
      'already_prompted_this_stretch',
    );
    const earlier = T0 - 3 * 3600_000;
    const r = estimateNight(epochs, { ...base, priorPrompts: [{ level: 'sound', atMs: earlier }, { level: 'sound', atMs: earlier - 3600_000 }] });
    assert.equal(r.prompt, 'silent');
  });

  test('最近 5 分钟有缺包不提示', () => {
    const epochs = build([['asleep', 40], ['restless', 48], ['gap', 2]]);
    const r = estimateNight(epochs, ctx(epochs, { nowMs: T0 + 90 * EPOCH_MS }));
    assert.equal(r.prompt, null);
  });
});

describe('资格与阈值', () => {
  const good = { coverage: 0.95, deviceLeaveCount: 1, diaryLeaveCount: 1, deviceSolMin: 20, diarySolMin: 20, deviceWasoMin: 30, diaryWasoMin: 45 };
  test('基线 5 晚一致才开放提示', () => {
    assert.equal(evaluateQualification(Array(5).fill(good)).qualified, true);
    assert.equal(evaluateQualification(Array(4).fill(good)).reason, 'coverage');
    assert.equal(
      evaluateQualification([...Array(3).fill(good), { ...good, diaryLeaveCount: 0 }, { ...good, diaryLeaveCount: 0 }]).reason,
      'leave_count',
    );
  });

  test('被吵醒 +5，最多 40；连续 7 次准 −5，最低 20', () => {
    assert.equal(soundThresholdFromFeedback(['was_asleep']), 25);
    assert.equal(soundThresholdFromFeedback(Array(9).fill('was_asleep')), 40);
    assert.equal(soundThresholdFromFeedback(['was_asleep', ...Array(7).fill('accurate')]), 20);
    assert.equal(soundThresholdFromFeedback(Array(7).fill('accurate')), 20);
  });

  test('连续两周准确率低于 60% 自动关闭', () => {
    assert.equal(promptsAutoDisabled([{ accurate: 1, total: 3 }, { accurate: 1, total: 2 }]), true);
    assert.equal(promptsAutoDisabled([{ accurate: 1, total: 3 }, { accurate: 2, total: 3 }]), false);
  });
});

describe('早晨夜摘要', () => {
  test('离床次数、时长、覆盖率与入睡估计', () => {
    const epochs = build([['restless', 30], ['asleep', 300], ['out', 20], ['asleep', 200]]);
    const s = summarizeNight(epochs, 55);
    assert.equal(s.leaveCount, 1);
    assert.equal(s.leaveMinutes, 10);
    assert.equal(s.coverage, 1);
    assert.equal(s.estSolMin, 15);
    assert.equal(s.sleepHrMedian, 55);
  });
});
