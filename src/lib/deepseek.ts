import { config } from '../config.js';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface DeepSeekCallOptions {
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  fallback: string;
}

export interface DeepSeekCallResult {
  text: string;
  isFallback: boolean;
  latencyMs: number;
}

export async function callDeepSeek(options: DeepSeekCallOptions): Promise<DeepSeekCallResult> {
  const start = Date.now();
  const {
    messages,
    temperature = 0.8,
    maxTokens = 600,
    timeoutMs = 20_000,
    fallback,
  } = options;

  if (!config.deepseekApiKey) {
    return { text: fallback, isFallback: true, latencyMs: Date.now() - start };
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(config.deepseekApiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.deepseekApiKey}`,
      },
      body: JSON.stringify({
        model: config.deepseekModel,
        messages,
        temperature,
        max_tokens: maxTokens,
        stream: false,
      }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      console.warn(`[DeepSeek] HTTP ${response.status}`);
      return { text: fallback, isFallback: true, latencyMs: Date.now() - start };
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const text = data?.choices?.[0]?.message?.content?.trim() || fallback;

    return {
      text,
      isFallback: !text || text === fallback,
      latencyMs: Date.now() - start,
    };
  } catch (err) {
    clearTimeout(timeoutId);
    const message = err instanceof Error ? err.message : String(err);
    console.warn('[DeepSeek] error:', message);
    return { text: fallback, isFallback: true, latencyMs: Date.now() - start };
  }
}
