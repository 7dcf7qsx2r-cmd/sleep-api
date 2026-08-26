export interface ChatToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

function extractJsonObject(text: string): unknown {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = (fenced?.[1] ?? trimmed).trim();
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
}

export function parseChatToolCalls(
  text: string,
  allowedNames: Iterable<string>,
): ChatToolCall[] {
  const allowed = new Set(allowedNames);
  const parsed = extractJsonObject(text);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
  const calls = (parsed as { toolCalls?: unknown }).toolCalls;
  if (!Array.isArray(calls)) return [];

  const out: ChatToolCall[] = [];
  for (const item of calls) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const name = String((item as { name?: unknown }).name ?? '').trim();
    if (!allowed.has(name)) continue;
    const rawArgs = (item as { arguments?: unknown }).arguments;
    const args = rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs)
      ? rawArgs as Record<string, unknown>
      : {};
    out.push({ name, arguments: args });
  }
  return out.slice(0, 3);
}
