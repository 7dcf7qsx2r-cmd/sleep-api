import assert from 'node:assert/strict';
import test from 'node:test';
import {
  forwardRadarUploads,
  radarDeviceSn,
  radarMqttTopic,
  setRadarMqttPublisher,
} from '../src/services/radarMqtt.js';

const vendor = {
  mac: '9C139EF1AE90',
  sn: 'OMTY26011605',
  isbed: 1,
  heartRate: 76,
  signal: 1,
};

test('mattress uses the vendor serial, otherwise the wifi mac', () => {
  assert.equal(radarDeviceSn(vendor, '9C139EF1AE90'), 'OMTY26011605');
  assert.equal(radarDeviceSn({ sn: '' }, '9c:13:9e:f1:ae:90'), '9C139EF1AE90');
  assert.equal(radarDeviceSn({}, 'abc'), null);
});

test('realtime and sleep report use different topics', () => {
  assert.equal(
    radarMqttTopic('realtime', 'omty26011605'),
    '/sys/br_mattress/OMTY26011605/thing/property/post',
  );
  assert.equal(
    radarMqttTopic('sleep_report', 'OMTY26011605'),
    '/sys/br_mattress/OMTY26011605/thing/event/sleep_report/post',
  );
});

test('forward sends the vendor object and keeps going after one failure', async () => {
  const sent: unknown[] = [];
  setRadarMqttPublisher(async (input) => {
    if (input.sn === 'BADSN00001') throw new Error('down');
    sent.push(input);
  });
  try {
    const n = await forwardRadarUploads('realtime', [
      { mac: '9C139EF1AE90', raw: vendor },
      { mac: '001122334455', raw: { mac: '001122334455', sn: 'BADSN00001', isbed: 0 } },
    ]);
    assert.equal(n, 1);
    assert.deepEqual(sent, [{
      sn: 'OMTY26011605',
      topic: '/sys/br_mattress/OMTY26011605/thing/property/post',
      payload: vendor,
    }]);
  } finally {
    setRadarMqttPublisher(null);
  }
});
