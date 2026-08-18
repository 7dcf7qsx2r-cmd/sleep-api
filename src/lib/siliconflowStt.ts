import { config } from '../config.js';

const STT_URL = 'https://api.siliconflow.cn/v1/audio/transcriptions';
const STT_MODEL = 'FunAudioLLM/SenseVoiceSmall';

export type SttUpstreamResult = {
  text: string | null;
  code?: 'not_configured' | 'cancelled' | 'timeout' | 'provider_auth' | 'provider_quota' | 'provider_unavailable';
  providerStatus?: number;
  providerTraceId?: string;
};

export async function transcribeSiliconFlowAudio(
  audio: ArrayBuffer,
  filename: string,
  mimeType: string,
  signal?: AbortSignal,
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
  }, 60_000);

  try {
    const form = new FormData();
    form.append('model', STT_MODEL);
    form.append('file', new Blob([audio], { type: mimeType || 'audio/mp4' }), filename);

    const res = await fetch(STT_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.siliconflowApiKey}`,
      },
      body: form,
      signal: controller.signal,
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
    const text = data.text?.trim() ?? '';
    if (!text) {
      return {
        text: null,
        code: 'provider_unavailable',
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
    if (signal?.aborted) return { text: null, code: 'cancelled' };
    if (timedOut) return { text: null, code: 'timeout' };
    return { text: null, code: 'provider_unavailable' };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onExternalAbort);
  }
}
