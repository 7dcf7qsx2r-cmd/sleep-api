import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseConsultTurnPayload,
  validateConsultTurnPayload,
} from '../src/lib/consultTurnCodec.js';

test('parseConsultTurnPayload extracts triage JSON', () => {
  const raw = '{"phase":"triage","progressStep":1,"heard":"入睡困难","question":{"id":"q1","prompt":"多久了？","type":"single"},"showDisclaimer":false}';
  const payload = parseConsultTurnPayload(raw);
  assert.ok(payload);
  assert.equal(payload?.phase, 'triage');
  assert.equal(validateConsultTurnPayload(payload!, 'triage'), true);
});

test('validateConsultTurnPayload rejects triage without question', () => {
  const payload = parseConsultTurnPayload('{"phase":"triage","progressStep":1,"heard":"头痛","showDisclaimer":false}');
  assert.ok(payload);
  assert.equal(validateConsultTurnPayload(payload!, 'triage'), false);
});

test('validateConsultTurnPayload accepts formulate with analysis and plan', () => {
  const raw = JSON.stringify({
    phase: 'formulate',
    progressStep: 4,
    analysis: {
      summary: '近一周反复头痛',
      mechanisms: [{ title: '睡眠剥夺', detail: '可能相关', confidence: 'possible' }],
    },
    plan: { tonight: ['休息'], thisWeek: ['观察'] },
    showDisclaimer: true,
  });
  const payload = parseConsultTurnPayload(raw);
  assert.ok(payload);
  assert.equal(validateConsultTurnPayload(payload!, 'formulate'), true);
});

test('validateConsultTurnPayload accepts safety card', () => {
  const raw = JSON.stringify({
    phase: 'safety',
    progressStep: 4,
    safety: {
      title: '请优先确保当下安全',
      bullets: ['立即就医', '拨打 120'],
    },
    showDisclaimer: true,
  });
  const payload = parseConsultTurnPayload(raw);
  assert.ok(payload);
  assert.equal(validateConsultTurnPayload(payload!, 'safety'), true);
});

test('parseConsultTurnPayload strips markdown fences', () => {
  const wrapped = '```json\n{"phase":"plan","progressStep":4,"ack":"超出范围","plan":{"tonight":["换个话题"],"thisWeek":[]},"showDisclaimer":false}\n```';
  const payload = parseConsultTurnPayload(wrapped);
  assert.equal(payload?.phase, 'plan');
  assert.equal(validateConsultTurnPayload(payload!, 'plan'), true);
});
