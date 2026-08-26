import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';
import { parseChatToolCalls } from '../src/lib/chatToolCalls.js';
import { persistRemoteImage } from '../src/lib/saveUploadedImage.js';

const allowed = ['search_sleep', 'open_garden'];

test('parseChatToolCalls reads JSON object toolCalls', () => {
  const calls = parseChatToolCalls(
    '{"toolCalls":[{"name":"open_garden","arguments":{"plot":"1"}}]}',
    allowed,
  );
  assert.deepEqual(calls, [{ name: 'open_garden', arguments: { plot: '1' } }]);
});

test('parseChatToolCalls accepts fenced JSON and drops unknown tools', () => {
  const calls = parseChatToolCalls(
    '```json\n{"toolCalls":[{"name":"open_garden","arguments":{}},{"name":"hack","arguments":{}}]}\n```',
    allowed,
  );
  assert.deepEqual(calls, [{ name: 'open_garden', arguments: {} }]);
});

test('parseChatToolCalls returns empty when no tools or invalid text', () => {
  assert.deepEqual(parseChatToolCalls('plain text', allowed), []);
  assert.deepEqual(parseChatToolCalls('{"toolCalls":[]}', allowed), []);
  assert.deepEqual(parseChatToolCalls('{"toolCalls":[{"name":"hack"}]}', allowed), []);
});

test('chat-with-tools parameters schema accepts string records', () => {
  const schema = z.record(z.string(), z.string());
  assert.deepEqual(schema.parse({ plot: 'number' }), { plot: 'number' });
});

test('persistRemoteImage ignores non-http urls', async () => {
  assert.equal(await persistRemoteImage('/uploads/ai/x.png'), null);
  assert.equal(await persistRemoteImage('not-a-url'), null);
});
