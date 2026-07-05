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

export async function synthesizeSiliconFlowSpeech(
  input: string,
  options?: SiliconFlowTtsOptions,
): Promise<ArrayBuffer | null> {
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
        stream: options?.stream ?? false,
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!res.ok) {
      console.warn('[sleep-api] TTS failed:', res.status, await res.text().catch(() => ''));
      return null;
    }

    return await res.arrayBuffer();
  } catch (e) {
    console.warn('[sleep-api] TTS error:', e);
    return null;
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
