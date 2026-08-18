import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const dbDir = mkdtempSync(join(tmpdir(), 'sleep-api-voice-test-'));
process.env.USE_PGLITE = '1';
process.env.PGLITE_DATA_DIR = dbDir;
process.env.SILICONFLOW_API_KEY = 'test-provider-key';
process.env.JWT_SECRET = 'voice-tests-only-secret-with-32-characters';
process.env.GUEST_MINT_PER_MINUTE_DEVICE = '1';
process.env.GUEST_MINT_PER_DAY_DEVICE = '20';
process.env.GUEST_MINT_PER_HOUR_IP = '30';
process.env.QUOTA_GUEST_TTS = '100';
process.env.QUOTA_GUEST_TTS_CHARS = '100000';
process.env.VOICE_TTS_CONCURRENCY_PER_SUBJECT = '1';

const [
  { aiRoutes },
  { authRoutes },
  { config },
  { closeDb, query },
  { signToken },
  { TTS_VOICE_STYLE_IDS },
] = await Promise.all([
  import('../src/routes/ai.js'),
  import('../src/routes/auth.js'),
  import('../src/config.js'),
  import('../src/db/client.js'),
  import('../src/lib/jwt.js'),
  import('../src/lib/ttsVoiceProfiles.js'),
]);

const originalFetch = globalThis.fetch;
let guestToken = '';

function authHeaders(token = guestToken): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
}

function ttsRequest(
  voiceStyleId: typeof TTS_VOICE_STYLE_IDS[number],
  token = guestToken,
  text = '同一段用于验证声线差异的晚安文案。',
): Promise<Response> {
  return aiRoutes.request('/tts/speech', {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({ text, voiceStyleId, scene: 'bedtime' }),
  });
}

test.before(async () => {
  await query(`CREATE TABLE guest_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    device_id TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    merged_to_user_id UUID
  )`);
  await query(`CREATE TABLE ai_usage_daily (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    subject_type TEXT NOT NULL,
    subject_id UUID NOT NULL,
    usage_date DATE NOT NULL DEFAULT CURRENT_DATE,
    chat_count INT NOT NULL DEFAULT 0,
    interpret_count INT NOT NULL DEFAULT 0,
    stt_count INT NOT NULL DEFAULT 0,
    stt_seconds INT NOT NULL DEFAULT 0,
    tts_count INT NOT NULL DEFAULT 0,
    tts_chars INT NOT NULL DEFAULT 0,
    UNIQUE (subject_type, subject_id, usage_date)
  )`);
  await query(`CREATE TABLE rate_limit_buckets (
    key_hash TEXT NOT NULL,
    action TEXT NOT NULL,
    window_start TIMESTAMPTZ NOT NULL,
    request_count INT NOT NULL DEFAULT 0,
    expires_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (key_hash, action, window_start)
  )`);
  await query(`CREATE TABLE voice_usage_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    feature TEXT NOT NULL,
    outcome TEXT NOT NULL,
    subject_type TEXT,
    subject_hash TEXT,
    units INT NOT NULL DEFAULT 0,
    latency_ms INT NOT NULL DEFAULT 0,
    scene TEXT,
    engine TEXT,
    reason_code TEXT,
    request_id TEXT,
    provider_status INT,
    provider_trace_id TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  guestToken = await signToken({ sub: randomUUID(), type: 'guest' });
});

test.after(async () => {
  globalThis.fetch = originalFetch;
  await query('SELECT 1');
  await closeDb();
  rmSync(dbDir, { recursive: true, force: true });
});

test('guest mint 按设备限流并返回稳定 429', async () => {
  const request = () => authRoutes.request('/guest', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Forwarded-For': '203.0.113.8',
    },
    body: JSON.stringify({ deviceId: 'voice-route-test-device' }),
  });

  const first = await request();
  assert.equal(first.status, 200);
  const payload = await first.json() as { token: string };
  assert.ok(payload.token);
  guestToken = payload.token;

  const second = await request();
  assert.equal(second.status, 429);
  assert.equal((await second.json() as { error: string }).error, 'guest_rate_limited');
  assert.ok(Number(second.headers.get('retry-after')) > 0);
});

test('语音路由拒绝未认证、超大和伪造音频', async () => {
  const unauthorized = await aiRoutes.request('/tts/speech', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text: '晚安',
      voiceStyleId: 'gentle_companion',
      scene: 'bedtime',
    }),
  });
  assert.equal(unauthorized.status, 401);

  const tooLarge = await aiRoutes.request('/stt/transcribe', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${guestToken}`,
      'Content-Type': 'multipart/form-data; boundary=x',
      'Content-Length': String(config.voice.maxSttBytes + 128 * 1024 + 1),
    },
    body: '--x--\r\n',
  });
  assert.equal(tooLarge.status, 413);
  assert.equal((await tooLarge.json() as { error: string }).error, 'audio_too_large');

  const form = new FormData();
  form.append('file', new File(['not an audio stream'], 'fake.wav', { type: 'audio/wav' }));
  const unsupported = await aiRoutes.request('/stt/transcribe', {
    method: 'POST',
    headers: { Authorization: `Bearer ${guestToken}` },
    body: form,
  });
  assert.equal(unsupported.status, 415);
  assert.equal((await unsupported.json() as { error: string }).error, 'audio_type_unsupported');
});

test('四声线只映射服务端白名单且模拟音频哈希互异', async () => {
  const providerBodies: Array<{ input: string; voice: string; speed: number }> = [];
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as { input: string; voice: string; speed: number };
    providerBodies.push(body);
    const marker = new TextEncoder().encode(`ID3:${body.voice}:${body.speed}`);
    return new Response(marker, {
      status: 200,
      headers: { 'X-Request-Id': `provider-${providerBodies.length}` },
    });
  };

  const hashes: string[] = [];
  for (const style of TTS_VOICE_STYLE_IDS) {
    const response = await ttsRequest(style);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-voice-style'), style);
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.ok(bytes.byteLength > 0);
    hashes.push(createHash('sha256').update(bytes).digest('hex'));
  }

  assert.equal(new Set(providerBodies.map((body) => body.voice)).size, 4);
  assert.equal(new Set(hashes).size, 4);
  assert.ok(providerBodies.every((body) => !/benjamin/i.test(body.voice)));
  assert.ok(providerBodies.every((body) => !body.input.includes('<|endofprompt|>')));
  assert.ok(providerBodies.every((body) => body.input === '同一段用于验证声线差异的晚安文案。'));
});

test('并发租约拒绝同主体第二个 TTS 且释放后恢复', async () => {
  let releaseProvider!: () => void;
  let markEntered!: () => void;
  const entered = new Promise<void>((resolve) => {
    markEntered = resolve;
  });
  globalThis.fetch = async () => {
    markEntered();
    await new Promise<void>((resolve) => {
      releaseProvider = resolve;
    });
    return new Response(new Uint8Array([73, 68, 51, 1]), { status: 200 });
  };

  const firstPromise = ttsRequest('gentle_companion');
  await entered;
  const second = await ttsRequest('moon_rational');
  assert.equal(second.status, 429);
  assert.equal((await second.json() as { error: string }).error, 'voice_busy');

  releaseProvider();
  assert.equal((await firstPromise).status, 200);

  globalThis.fetch = async () => new Response(new Uint8Array([73, 68, 51, 2]), { status: 200 });
  assert.equal((await ttsRequest('moon_rational')).status, 200);
});

test('原子配额超限不继续调用供应商', async () => {
  const token = await signToken({ sub: randomUUID(), type: 'guest' });
  const previousCountLimit = config.quota.guestTts;
  config.quota.guestTts = 1;
  let providerCalls = 0;
  globalThis.fetch = async () => {
    providerCalls += 1;
    return new Response(new Uint8Array([73, 68, 51]), { status: 200 });
  };

  try {
    assert.equal((await ttsRequest('gentle_companion', token)).status, 200);
    const denied = await ttsRequest('gentle_companion', token);
    assert.equal(denied.status, 429);
    assert.equal((await denied.json() as { error: string }).error, 'voice_quota_exceeded');
    assert.equal(providerCalls, 1);
  } finally {
    config.quota.guestTts = previousCountLimit;
  }
});

test('供应商错误正文不透传，断连会中止上游请求', async () => {
  const errorToken = await signToken({ sub: randomUUID(), type: 'guest' });
  globalThis.fetch = async () => new Response('SECRET provider internal detail', {
    status: 500,
    headers: { 'X-Request-Id': 'safe-trace-id' },
  });
  const failed = await ttsRequest('gentle_companion', errorToken);
  assert.equal(failed.status, 503);
  const failedText = await failed.text();
  assert.match(failedText, /voice_provider_unavailable/);
  assert.doesNotMatch(failedText, /SECRET|internal detail/);

  const abortToken = await signToken({ sub: randomUUID(), type: 'guest' });
  let upstreamSignal: AbortSignal | undefined;
  let markEntered!: () => void;
  const entered = new Promise<void>((resolve) => {
    markEntered = resolve;
  });
  globalThis.fetch = async (_input, init) => {
    upstreamSignal = init?.signal ?? undefined;
    markEntered();
    return new Promise<Response>((_resolve, reject) => {
      upstreamSignal?.addEventListener('abort', () => {
        reject(new DOMException('aborted', 'AbortError'));
      }, { once: true });
    });
  };

  const controller = new AbortController();
  const request = new Request('http://local/tts/speech', {
    method: 'POST',
    headers: authHeaders(abortToken),
    body: JSON.stringify({
      text: '这次请求会在断连时取消。',
      voiceStyleId: 'gentle_companion',
      scene: 'bedtime',
    }),
    signal: controller.signal,
  });
  const responsePromise = aiRoutes.fetch(request);
  await entered;
  controller.abort();
  const cancelled = await responsePromise;
  assert.equal(cancelled.status, 408);
  assert.equal((await cancelled.json() as { error: string }).error, 'request_cancelled');
  assert.equal(upstreamSignal?.aborted, true);
});
