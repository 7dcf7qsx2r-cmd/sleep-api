import { config } from '../config.js';

const SILICONFLOW_SPEECH_URL = 'https://api.siliconflow.cn/v1/audio/speech';
const TTS_MODEL = 'FunAudioLLM/CosyVoice2-0.5B';
const DEFAULT_VOICE = `${TTS_MODEL}:anna`;

export interface SiliconFlowTtsOptions {
  speed?: number;
  voice?: string;
  gain?: number;
  signal?: AbortSignal;
}

export interface SiliconFlowTtsResult {
  bytes: ArrayBuffer | null;
  code?: 'not_configured' | 'cancelled' | 'timeout' | 'provider_auth' | 'provider_quota' | 'provider_unavailable';
  providerStatus?: number;
  providerTraceId?: string;
}

export async function synthesizeSiliconFlowSpeech(
  input: string,
  options?: SiliconFlowTtsOptions,
): Promise<SiliconFlowTtsResult> {
  if (!config.siliconflowApiKey) {
    return { bytes: null, code: 'not_configured' };
  }

  const controller = new AbortController();
  let timedOut = false;
  const onExternalAbort = () => controller.abort(options?.signal?.reason);
  options?.signal?.addEventListener('abort', onExternalAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error('tts_timeout'));
  }, 90_000);

  try {
    const res = await fetch(SILICONFLOW_SPEECH_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.siliconflowApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: TTS_MODEL,
        input: input.slice(0, 2000),
        voice: options?.voice ?? DEFAULT_VOICE,
        response_format: 'mp3',
        speed: options?.speed ?? 0.9,
        gain: options?.gain ?? 0,
        stream: false,
      }),
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
      console.warn('[sleep-api] TTS provider rejected request', {
        status: res.status,
        traceId: providerTraceId,
      });
      return { bytes: null, code, providerStatus: res.status, providerTraceId };
    }

    const bytes = await res.arrayBuffer();
    if (bytes.byteLength === 0) {
      return {
        bytes: null,
        code: 'provider_unavailable',
        providerStatus: res.status,
        providerTraceId: res.headers.get('x-request-id') ?? undefined,
      };
    }
    return {
      bytes,
      providerStatus: res.status,
      providerTraceId: res.headers.get('x-request-id') ?? undefined,
    };
  } catch {
    if (options?.signal?.aborted) return { bytes: null, code: 'cancelled' };
    if (timedOut) return { bytes: null, code: 'timeout' };
    return { bytes: null, code: 'provider_unavailable' };
  } finally {
    clearTimeout(timer);
    options?.signal?.removeEventListener('abort', onExternalAbort);
  }
}
