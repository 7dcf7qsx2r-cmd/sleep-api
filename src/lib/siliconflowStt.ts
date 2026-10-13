import { config } from '../config.js';

const STT_URL = 'https://api.siliconflow.cn/v1/audio/transcriptions';
const STT_MODEL = 'FunAudioLLM/SenseVoiceSmall';
/** 补发走另一套后端：SenseVoice 整体排队时（实测 15～36s）它仍在 0.3s 左右返回。 */
const STT_FALLBACK_MODEL = 'TeleAI/TeleSpeechASR';

export type SttUpstreamResult = {
  text: string | null;
  code?:
    | 'not_configured'
    | 'cancelled'
    | 'timeout'
    | 'no_speech'
    | 'provider_auth'
    | 'provider_quota'
    | 'provider_unavailable';
  providerStatus?: number;
  providerTraceId?: string;
};

/** 须短于客户端 45s 上传超时，否则客户端放弃后服务端仍在计费。 */
const STT_PROVIDER_TIMEOUT_MS = 40_000;

/** SenseVoice 会在文本里附带语种/情绪/事件标签（`<|zh|>`）和情绪 emoji。 */
export function cleanSttTranscript(raw: string): string {
  return raw
    .replace(/<\|[^|>]*\|>/g, '')
    .replace(/[\p{Extended_Pictographic}\u{1F3FB}-\u{1F3FF}\u200D\uFE0E\uFE0F]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 供应商偶发排队（实测同一段 37s 音频 0.4s～13s），超过该时长仍未返回就用备用模型并发补发一次，
 * 先成功者胜出、另一个立即取消。
 */
export const STT_HEDGE_DELAY_MS = 2_500;
const STT_MAX_ATTEMPTS = 2;

/** 备用模型的鉴权/额度错误不代表主模型不可用，不能据此提前结束。 */
function isFinalResult(result: SttUpstreamResult, model: string): boolean {
  if (result.text || result.code === 'no_speech') return true;
  return model === STT_MODEL
    && (result.code === 'provider_auth' || result.code === 'provider_quota');
}

export async function transcribeSiliconFlowAudio(
  audio: ArrayBuffer,
  filename: string,
  mimeType: string,
  signal?: AbortSignal,
  options?: { hedgeDelayMs?: number },
): Promise<SttUpstreamResult> {
  if (!config.siliconflowApiKey) {
    return { text: null, code: 'not_configured' };
  }

  const controller = new AbortController();
  let timedOut = false;
  const onExternalAbort = () => controller.abort(signal?.reason);
  signal?.addEventListener('abort', onExternalAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error('stt_timeout'));
  }, STT_PROVIDER_TIMEOUT_MS);
  const attempts: AbortController[] = [];
  let hedgeTimer: ReturnType<typeof setTimeout> | undefined;

  try {
    const result = await new Promise<SttUpstreamResult>((resolve) => {
      let settled = false;
      let pending = 0;
      let lastFailure: SttUpstreamResult = { text: null, code: 'provider_unavailable' };
      const finish = (value: SttUpstreamResult) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      const launch = () => {
        if (settled || attempts.length >= STT_MAX_ATTEMPTS) return;
        const model = attempts.length === 0 ? STT_MODEL : STT_FALLBACK_MODEL;
        const attempt = new AbortController();
        attempts.push(attempt);
        const onAbort = () => attempt.abort(controller.signal.reason);
        controller.signal.addEventListener('abort', onAbort, { once: true });
        pending += 1;
        void requestOnce(audio, filename, mimeType, model, attempt.signal).then((value) => {
          controller.signal.removeEventListener('abort', onAbort);
          pending -= 1;
          if (isFinalResult(value, model)) {
            finish(value);
            return;
          }
          if (model === STT_MODEL || lastFailure.code === 'provider_unavailable') lastFailure = value;
          if (controller.signal.aborted) {
            if (pending === 0) finish(lastFailure);
            return;
          }
          if (attempts.length < STT_MAX_ATTEMPTS) {
            clearTimeout(hedgeTimer);
            launch();
          } else if (pending === 0) {
            finish(lastFailure);
          }
        });
      };
      launch();
      hedgeTimer = setTimeout(launch, options?.hedgeDelayMs ?? STT_HEDGE_DELAY_MS);
    });
    if (!result.text && signal?.aborted) return { text: null, code: 'cancelled' };
    if (!result.text && timedOut) return { text: null, code: 'timeout' };
    return result;
  } finally {
    clearTimeout(hedgeTimer);
    clearTimeout(timer);
    for (const attempt of attempts) attempt.abort();
    signal?.removeEventListener('abort', onExternalAbort);
  }
}

async function requestOnce(
  audio: ArrayBuffer,
  filename: string,
  mimeType: string,
  model: string,
  signal: AbortSignal,
): Promise<SttUpstreamResult> {
  try {
    const form = new FormData();
    form.append('model', model);
    form.append('file', new Blob([audio], { type: mimeType || 'audio/mp4' }), filename);

    const res = await fetch(STT_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.siliconflowApiKey}`,
      },
      body: form,
      signal,
    });

    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      const providerTraceId = res.headers.get('x-request-id') ?? undefined;
      const code = res.status === 401 || res.status === 403
        ? 'provider_auth'
        : res.status === 402 || res.status === 429
          ? 'provider_quota'
          : 'provider_unavailable';
      console.warn('[sleep-api] STT provider rejected request', {
        model,
        status: res.status,
        traceId: providerTraceId,
      });
      return {
        text: null,
        code,
        providerStatus: res.status,
        providerTraceId,
      };
    }

    const data = (await res.json()) as { text?: string };
    const text = cleanSttTranscript(data.text ?? '');
    if (!/[\p{L}\p{N}]/u.test(text)) {
      return {
        text: null,
        code: 'no_speech',
        providerStatus: res.status,
        providerTraceId: res.headers.get('x-request-id') ?? undefined,
      };
    }
    return {
      text,
      providerStatus: res.status,
      providerTraceId: res.headers.get('x-request-id') ?? undefined,
    };
  } catch {
    return { text: null, code: 'provider_unavailable' };
  }
}
