import { config } from '../config.js';

const STT_URL = 'https://api.siliconflow.cn/v1/audio/transcriptions';
const STT_MODEL = 'FunAudioLLM/SenseVoiceSmall';

export type SttUpstreamResult = {
  text: string | null;
  reason?: 'not_configured' | 'upstream_error' | 'empty_result' | 'network';
  httpStatus?: number;
};

export async function transcribeSiliconFlowAudio(
  audio: ArrayBuffer,
  filename: string,
  mimeType: string,
): Promise<SttUpstreamResult> {
  if (!config.siliconflowApiKey) {
    return { text: null, reason: 'not_configured' };
  }

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
      const detail = await res.text().catch(() => '');
      console.warn('[sleep-api] STT failed:', res.status, detail.slice(0, 200));
      return { text: null, reason: 'upstream_error', httpStatus: res.status };
    }

    const data = (await res.json()) as { text?: string };
    const text = data.text?.trim() ?? '';
    if (!text) return { text: null, reason: 'empty_result' };
    return { text };
  } catch (e) {
    console.warn('[sleep-api] STT error:', e);
    return { text: null, reason: 'network' };
  }
}

export function sttFailureMessage(result: SttUpstreamResult): string {
  if (result.reason === 'not_configured') {
    return '语音识别服务未开通';
  }
  if (result.httpStatus === 402) {
    return '语音识别服务余额不足';
  }
  if (result.reason === 'empty_result') {
    return '没听清，请按住多说一会';
  }
  return '语音识别暂不可用，请稍后重试';
}
