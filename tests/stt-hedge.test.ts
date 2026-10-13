import assert from 'node:assert/strict';
import test from 'node:test';

process.env.SILICONFLOW_API_KEY = 'test-provider-key';

const { transcribeSiliconFlowAudio, cleanSttTranscript } = await import('../src/lib/siliconflowStt.js');

const originalFetch = globalThis.fetch;
const audio = new Uint8Array([1, 2, 3]).buffer;

test.afterEach(() => {
  globalThis.fetch = originalFetch;
});

function hangUntilAborted(init?: RequestInit, onAbort?: () => void): Promise<Response> {
  return new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => {
      onAbort?.();
      reject(new DOMException('aborted', 'AbortError'));
    }, { once: true });
  });
}

test('首个请求卡住时补发一次，先返回者胜出并取消另一个', async () => {
  let calls = 0;
  let firstAborted = false;
  globalThis.fetch = async (_input, init) => {
    calls += 1;
    if (calls === 1) return hangUntilAborted(init, () => { firstAborted = true; });
    return Response.json({ text: '你好😊' });
  };

  const startedAt = Date.now();
  const result = await transcribeSiliconFlowAudio(audio, 'voice.m4a', 'audio/mp4', undefined, {
    hedgeDelayMs: 30,
  });
  assert.equal(result.text, '你好');
  assert.equal(calls, 2);
  assert.equal(firstAborted, true);
  assert.ok(Date.now() - startedAt < 1_000);
});

test('首个请求很快成功时不补发', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return Response.json({ text: '睡不着' });
  };
  const result = await transcribeSiliconFlowAudio(audio, 'voice.m4a', 'audio/mp4', undefined, {
    hedgeDelayMs: 200,
  });
  assert.equal(result.text, '睡不着');
  await new Promise((resolve) => setTimeout(resolve, 260));
  assert.equal(calls, 1);
});

test('供应商 5xx 立即重试一次，两次都失败才返回不可用', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response('busy', { status: 503 });
  };
  const failed = await transcribeSiliconFlowAudio(audio, 'voice.m4a', 'audio/mp4', undefined, {
    hedgeDelayMs: 5_000,
  });
  assert.equal(failed.code, 'provider_unavailable');
  assert.equal(calls, 2);

  calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return calls === 1 ? new Response('busy', { status: 503 }) : Response.json({ text: '好的' });
  };
  const recovered = await transcribeSiliconFlowAudio(audio, 'voice.m4a', 'audio/mp4', undefined, {
    hedgeDelayMs: 5_000,
  });
  assert.equal(recovered.text, '好的');
});

test('鉴权或额度错误不补发，空结果视为无语音', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response('no', { status: 401 });
  };
  const auth = await transcribeSiliconFlowAudio(audio, 'voice.m4a', 'audio/mp4', undefined, {
    hedgeDelayMs: 5_000,
  });
  assert.equal(auth.code, 'provider_auth');
  assert.equal(calls, 1);

  globalThis.fetch = async () => Response.json({ text: '<|zh|><|EMO_UNKNOWN|> 😊 ' });
  const empty = await transcribeSiliconFlowAudio(audio, 'voice.m4a', 'audio/mp4');
  assert.equal(empty.code, 'no_speech');
});

test('客户端断开时取消全部上游请求', async () => {
  const aborted: boolean[] = [];
  globalThis.fetch = async (_input, init) => hangUntilAborted(init, () => { aborted.push(true); });
  const controller = new AbortController();
  const pending = transcribeSiliconFlowAudio(audio, 'voice.m4a', 'audio/mp4', controller.signal, {
    hedgeDelayMs: 20,
  });
  await new Promise((resolve) => setTimeout(resolve, 60));
  controller.abort();
  const result = await pending;
  assert.equal(result.code, 'cancelled');
  assert.equal(aborted.length, 2);
});

test('清洗 SenseVoice 标签与表情', () => {
  assert.equal(cleanSttTranscript('<|zh|><|HAPPY|><|Speech|>今天睡得不错！😊👍🏻'), '今天睡得不错！');
});
