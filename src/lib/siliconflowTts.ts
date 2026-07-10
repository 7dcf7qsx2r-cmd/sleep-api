import { config } from '../config.js';

const SILICONFLOW_SPEECH_URL = 'https://api.siliconflow.cn/v1/audio/speech';
const TTS_MODEL = 'FunAudioLLM/CosyVoice2-0.5B';
const DEFAULT_VOICE = `${TTS_MODEL}:anna`;

export interface SiliconFlowTtsOptions {
  speed?: number;
  voice?: string;
  gain?: number;
  stream?: boolean;
}

export interface SiliconFlowTtsResult {
  bytes: ArrayBuffer | null;
  /** upstream 失败原因（便于区分「未配置 key」与「key 无效/欠费」） */
  reason?: string;
}

export async function synthesizeSiliconFlowSpeech(
  input: string,
  options?: SiliconFlowTtsOptions,
): Promise<SiliconFlowTtsResult> {
  if (!config.siliconflowApiKey) {
    return { bytes: null, reason: 'SILICONFLOW_API_KEY 未配置' };
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 90_000);
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
        stream: options?.stream ?? false,
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      const reason = `SiliconFlow HTTP ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`;
      console.warn('[sleep-api] TTS failed:', reason);
      return { bytes: null, reason };
    }

    return { bytes: await res.arrayBuffer() };
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    console.warn('[sleep-api] TTS error:', reason);
    return { bytes: null, reason };
  }
}

/** 流式合成 — 将 SiliconFlow 分块 MP3 直接 pipe 给客户端 progressive 播放 */
export async function fetchSiliconFlowSpeechStream(
  input: string,
  options?: Omit<SiliconFlowTtsOptions, 'stream'>,
): Promise<Response | null> {
  if (!config.siliconflowApiKey) return null;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 90_000);
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
        stream: true,
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!res.ok || !res.body) {
      console.warn('[sleep-api] TTS stream failed:', res.status);
      return null;
    }

    return res;
  } catch (e) {
    console.warn('[sleep-api] TTS stream error:', e);
    return null;
  }
}
