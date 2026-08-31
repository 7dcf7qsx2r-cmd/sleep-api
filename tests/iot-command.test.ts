import assert from 'node:assert/strict';
import test from 'node:test';
import { validateCisServiceCommand } from '../src/services/iotCommands.js';

test('command catalog matches vendor per-model services', () => {
  const ib = validateCisServiceCommand('cis_ib', 'setMotor', { num: 1, height: 3150 });
  assert.equal(ib.ok, true);
  if (ib.ok) {
    assert.deepEqual(ib.payload, {
      method: 'thing.service.invoke',
      params: { setMotor: { num: 1, height: 3150 } },
    });
  }

  const ip = validateCisServiceCommand('cis_ip', 'setPressure', { num: 0, pressure: 1200 });
  assert.equal(ip.ok, true);

  const iswb = validateCisServiceCommand('cis_iswb', 'setHeat', { bedSide: 0, enable: 1, level: 2 });
  assert.equal(iswb.ok, true);

  assert.equal(validateCisServiceCommand('cis_ib', 'setHeat', { bedSide: 0, enable: 1, level: 1 }).ok, false);
  assert.equal(validateCisServiceCommand('cis_ip', 'setAppInit', {}).ok, false);
  assert.equal(validateCisServiceCommand('cis_iswb', 'setPressure', { num: 0, pressure: 1000 }).ok, false);
  assert.equal(validateCisServiceCommand('cis_ib', 'setMotor', { num: 2, height: 3000 }).ok, false);
});

test('vendor field names are preserved on downlink', () => {
  const maxP = validateCisServiceCommand('cis_iswb', 'setSleepMaxPressure', { sleepMaxPressure: 6000 });
  assert.equal(maxP.ok, true);
  if (maxP.ok) {
    assert.deepEqual(maxP.payload, {
      method: 'thing.service.invoke',
      params: { setSleepMaxPressure: { sleepMaxPressure: 6000 } },
    });
  }
  const alias = validateCisServiceCommand('cis_iswb', 'setSleepMaxPressure', { pressure: 8000 });
  assert.equal(alias.ok, true);
  if (alias.ok) {
    assert.deepEqual(alias.payload.params.setSleepMaxPressure, { sleepMaxPressure: 8000 });
  }

  const stop = validateCisServiceCommand('cis_ip', 'stopMorning', { enable: 1 });
  assert.equal(stop.ok, true);
  if (stop.ok) {
    assert.deepEqual(stop.payload.params.stopMorning, { enable: 1 });
  }
  assert.equal(validateCisServiceCommand('cis_ip', 'stopMorning', {}).ok, false);

  const haltAid = validateCisServiceCommand('cis_iswb', 'setAirbagsMode', { bedSide: 0, mode: 2, duration: 0 });
  assert.equal(haltAid.ok, true);

  const range = validateCisServiceCommand('cis_ip', 'setTimeRange', {
    status: 1,
    starthour: 22,
    startminute: 0,
    endhour: 7,
    endminute: 0,
  });
  assert.equal(range.ok, true);
  if (range.ok) {
    assert.deepEqual(range.payload.params.setTimeRange, {
      status: 1,
      starthour: 22,
      startminute: 0,
      endhour: 7,
      endminute: 0,
    });
  }

  const ipPressure = validateCisServiceCommand('cis_ip', 'setPressure', { num: 0, pressure: 8000 });
  assert.equal(ipPressure.ok, true);
  assert.equal(validateCisServiceCommand('cis_ip', 'setPressure', { num: 0, pressure: 8001 }).ok, false);
});
