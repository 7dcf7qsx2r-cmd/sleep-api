import assert from 'node:assert/strict';
import test from 'node:test';
import {
  mapSleepInterventionTrack,
  sleepInterventionContentKey,
} from '../src/services/sleepInterventionContract.ts';

const base = {
  id: '1',
  contentKey: 'sleep-intervention:001',
  placement: 'sleep_intervention',
  title: '脑波干预',
  summary: '配合小眠脑机枕',
  imageUrl: '/uploads/admin/images/cover.png',
  actionUrl: '/uploads/admin/audio/track.mp3',
  status: 'published',
  sortOrder: 1,
  metadata: { kind: 'brainwave', code: '001', enabled: true },
};

test('enabled intervention audio is playable and keeps its code', () => {
  const track = mapSleepInterventionTrack(base);
  assert.equal(track?.playable, true);
  assert.equal(track?.enabled, true);
  assert.equal(track?.code, '001');
  assert.equal(track?.audioUrl, '/uploads/admin/audio/track.mp3');
  assert.equal(sleepInterventionContentKey('001'), 'sleep-intervention:001');
});

test('disabled or empty audio stays in the catalog but is not playable', () => {
  assert.equal(mapSleepInterventionTrack({
    ...base,
    status: 'draft',
    metadata: { code: '002', enabled: false },
  })?.playable, false);
  assert.equal(mapSleepInterventionTrack({ ...base, actionUrl: '  ' })?.enabled, true);
  assert.equal(mapSleepInterventionTrack({ ...base, actionUrl: '  ' })?.playable, false);
  assert.equal(mapSleepInterventionTrack({ ...base, placement: 'home_banner' }), null);
});

test('each code maps to its own track instead of one shared slot', () => {
  const first = mapSleepInterventionTrack(base);
  const second = mapSleepInterventionTrack({
    ...base,
    id: '2',
    contentKey: 'sleep-intervention:002',
    title: '深睡节律',
    metadata: { code: '002', enabled: true },
  });
  assert.notEqual(first?.id, second?.id);
  assert.notEqual(first?.code, second?.code);
  assert.equal(second?.title, '深睡节律');
});
