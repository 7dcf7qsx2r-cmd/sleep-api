import { config } from '../config.js';

const SILICONFLOW_IMAGE_URL = 'https://api.siliconflow.cn/v1/images/generations';

const IMAGE_MODELS = [
  'Kwai-Kolors/Kolors',
  'Qwen/Qwen-Image',
  'Tongyi-MAI/Z-Image-Turbo',
];

export async function generateSiliconFlowImage(
  prompt: string,
  seed: number,
  negativePrompt?: string,
): Promise<string | null> {
  if (!config.siliconflowApiKey) return null;

  for (const model of IMAGE_MODELS) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 90_000);
      const res = await fetch(SILICONFLOW_IMAGE_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.siliconflowApiKey}`,
        },
        body: JSON.stringify({
          model,
          prompt,
          negative_prompt: negativePrompt ?? '',
          image_size: '768x768',
          seed: seed % 9999999999,
          prompt_enhancement: false,
        }),
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!res.ok) {
        console.warn(`[sleep-api] dream image ${model} failed: ${res.status}`);
        continue;
      }
      const data = await res.json() as { images?: { url?: string }[]; data?: { url?: string }[] };
      const url = data.images?.[0]?.url ?? data.data?.[0]?.url ?? null;
      if (url) return url;
    } catch (e) {
      console.warn(`[sleep-api] dream image ${model} error:`, e);
    }
  }
  return null;
}
