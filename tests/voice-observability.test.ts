import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const read = (path: string) => readFileSync(join(root, path), 'utf8');

test('provider health is explicitly non-billable local state', () => {
  const health = read('src/routes/health.ts');
  assert.match(health, /billingRequests:\s*0/);
  assert.match(health, /local_config_and_circuit_state/);
  assert.doesNotMatch(health, /synthesizeSiliconFlowSpeech|transcribeSiliconFlowAudio/);
});

test('voice metrics store no text or audio and expose protected aggregation', () => {
  const metrics = read('src/services/voiceMetrics.ts');
  const route = read('src/routes/admin/voiceMetrics.ts');
  assert.match(metrics, /PERCENTILE_CONT\(0\.95\)/);
  assert.doesNotMatch(metrics, /\btext\b|\baudio\b/);
  assert.match(route, /requireAdminAuth/);
  assert.match(route, /requireAdminPermission\('dashboard:read'\)/);
  assert.match(route, /storesText:\s*false/);
  assert.match(route, /storesAudio:\s*false/);
});

test('client playback events are bounded and contain stable outcomes', () => {
  const routes = read('src/routes/ai.ts');
  assert.match(routes, /'\/voice\/events'/);
  assert.match(routes, /voice_client_event/);
  assert.match(routes, /'native_fallback'/);
  assert.match(routes, /'playback_failed'/);
  assert.match(routes, /reasonCode/);
});
