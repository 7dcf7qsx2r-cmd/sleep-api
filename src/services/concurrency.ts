export type VoiceFeature = 'stt' | 'tts';

interface GateLimits {
  global: number;
  perSubject: number;
}

const activeGlobal: Record<VoiceFeature, number> = { stt: 0, tts: 0 };
const activeSubjects = new Map<string, number>();

export interface ConcurrencyLease {
  release: () => void;
}

export function acquireConcurrency(
  feature: VoiceFeature,
  subjectKey: string,
  limits: GateLimits,
): ConcurrencyLease | null {
  const mapKey = `${feature}:${subjectKey}`;
  const subjectCount = activeSubjects.get(mapKey) ?? 0;
  if (
    (limits.global > 0 && activeGlobal[feature] >= limits.global)
    || (limits.perSubject > 0 && subjectCount >= limits.perSubject)
  ) {
    return null;
  }

  activeGlobal[feature] += 1;
  activeSubjects.set(mapKey, subjectCount + 1);
  let released = false;

  return {
    release: () => {
      if (released) return;
      released = true;
      activeGlobal[feature] = Math.max(0, activeGlobal[feature] - 1);
      const next = (activeSubjects.get(mapKey) ?? 1) - 1;
      if (next <= 0) activeSubjects.delete(mapKey);
      else activeSubjects.set(mapKey, next);
    },
  };
}

export function getConcurrencySnapshot(): Record<VoiceFeature, number> {
  return { ...activeGlobal };
}
