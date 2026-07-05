import { randomBytes } from 'node:crypto';

export interface TtsStreamPayload {
  input: string;
  speed?: number;
  voice?: string;
  gain?: number;
}

interface SessionEntry {
  payload: TtsStreamPayload;
  token: string;
  createdAt: number;
}

const TTL_MS = 5 * 60 * 1000;
const sessions = new Map<string, SessionEntry>();

function pruneExpired(): void {
  const now = Date.now();
  for (const [id, entry] of sessions) {
    if (now - entry.createdAt > TTL_MS) sessions.delete(id);
  }
}

export function createTtsStreamSession(payload: TtsStreamPayload): {
  sessionId: string;
  token: string;
} {
  pruneExpired();
  const sessionId = randomBytes(16).toString('hex');
  const token = randomBytes(24).toString('hex');
  sessions.set(sessionId, {
    payload,
    token,
    createdAt: Date.now(),
  });
  return { sessionId, token };
}

export function consumeTtsStreamSession(
  sessionId: string,
  token: string,
): TtsStreamPayload | null {
  pruneExpired();
  const entry = sessions.get(sessionId);
  if (!entry || entry.token !== token) return null;
  if (Date.now() - entry.createdAt > TTL_MS) {
    sessions.delete(sessionId);
    return null;
  }
  sessions.delete(sessionId);
  return entry.payload;
}
