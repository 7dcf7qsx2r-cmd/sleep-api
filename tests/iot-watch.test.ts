import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  compactIotParams,
  highlightIotParams,
  normalizeWatchSearchQuery,
  shortTopic,
} from '../src/services/iotWatch.js';

describe('iot watch compact', () => {
  test('CIS-IB person and HR', () => {
    const summary = compactIotParams({
      airbagsPerson: [1, 2],
      HR: [81, 18, 0, 0, 0, 0],
      airbagsPressure: [5876, 5782, 5659, 4902, 5851, 7606, 5546, 4741],
    });
    assert.match(summary, /person=\[1,2\]/);
    assert.match(summary, /HR=\[81,18,0,0,0,0\]/);
    assert.equal(
      highlightIotParams('/sys/cis_ib/68EE8F4740BC/thing/property/post', {
        airbagsPerson: [1, 2],
        HR: [81, 18, 0, 0, 0, 0],
      }),
      'occupied',
    );
  });

  test('empty IB bed is idle', () => {
    assert.equal(
      highlightIotParams('/sys/cis_ib/68EE8F4740BC/thing/property/post', {
        airbagsPerson: [2, 2],
        HR: [0, 0, 0, 0, 0, 0],
      }),
      'idle',
    );
  });

  test('CIS-ISWB heartData and sleep report', () => {
    const live = compactIotParams({
      heartData: [79, 17, 0, 76, 16, 0],
      heatData: [0, 30, 0, 0, 29, 0],
      airbagsMode: [0, 0, 2, 30],
      pressureLeft: 3411,
      pressureRight: 2424,
      sleepMaxPressure: 6600,
    });
    assert.match(live, /heartData=\[79,17,0,76,16,0\]/);
    assert.match(live, /P=\[3411,2424\]/);
    const sleep = compactIotParams({
      SleepReportNew: { ISWBSleepReport: [1, 0, 16, 79, 1, 1, 0, 16, 77, 0] },
    });
    assert.match(sleep, /sleep=\[1,0,16,79,1,1,0,16,77,0\]/);
    assert.equal(
      highlightIotParams('/sys/cis_iswb/94A990CC0058/thing/service/invoke', {
        setPressure: { num: 1, pressure: 3400 },
      }),
      'command',
    );
  });

  test('CIS-IP deviceStatus compact', () => {
    const summary = compactIotParams({
      deviceName: '14639369CCDC',
      deviceStatus: {
        heart: 0,
        person: 0,
        breathing: 0,
        workMode: 0,
        pressureLeft: 7438,
        pressureRight: 7937,
        heatingStatus: 0,
        heatingTemp: 27,
        snoreStatus: 1,
      },
    });
    assert.match(summary, /person=0/);
    assert.match(summary, /heart=0/);
    assert.match(summary, /P=\[7438,7937\]/);
    assert.match(summary, /heat=0\/27/);
    assert.equal(
      highlightIotParams('/sys/cis_ip/14639369CCDC/thing/property/post', {
        deviceStatus: { heart: 0, person: 0, breathing: 0 },
      }),
      'idle',
    );
    assert.equal(
      highlightIotParams('/sys/cis_ip/14639369CCDC/thing/property/post', {
        deviceStatus: { heart: 62, person: 1, breathing: 14 },
      }),
      'occupied',
    );
  });

  test('short topic strips product prefix', () => {
    assert.equal(
      shortTopic('/sys/cis_ib/68EE8F4740BC/thing/property/post', '68EE8F4740BC', 'cis_ib'),
      'thing/property/post',
    );
  });
});

describe('iot watch search query', () => {
  test('keeps text and extracts phone digits', () => {
    const { like, digits } = normalizeWatchSearchQuery('  +86 138-0013-8000  ');
    assert.equal(like, '+86 138-0013-8000');
    assert.equal(digits, '8613800138000');
  });
});
