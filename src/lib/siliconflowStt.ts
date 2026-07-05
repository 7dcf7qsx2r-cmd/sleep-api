import { config } from '../config.js';

const STT_URL = 'https://api.siliconflow.cn/v1/audio/transcriptions';
const STT_MODEL = 'FunAudioLLM/SenseVoiceSmall';

export async function transcribeSiliconFlowAudio(
  audio: ArrayBuffer,
  filename: string,
  mimeType: string,
): Promise<string | null> {
  if (!config.siliconflowApiKey) return null;

  try {
    const form = new FormData();
    form.append('model', STT_MODEL);
    form.append('file', new Blob([audio], { type: mimeType || 'audio/mp4' }), filename);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60_000);
    const res = await fetch(STT_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.siliconflowApiKey}`,
      },
      body: form,
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!res.ok) {
      console.warn('[sleep-api] STT failed:', res.status, await res.text().catch(() => ''));
      return null;
    }

    const data = (await res.json()) as { text?: string };
    const text = data.text?.trim() ?? '';
    return text || null;
  } catch (e) {
    console.warn('[sleep-api] STT error:', e);
    return null;
  }
}
