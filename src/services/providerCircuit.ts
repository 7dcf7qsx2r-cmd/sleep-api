import { config } from '../config.js';

type VoiceProviderFeature = 'stt' | 'tts';

interface CircuitState {
  consecutiveFailures: number;
  openedAt: number | null;
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
}

const FAILURE_THRESHOLD = 5;
const OPEN_MS = 60_000;
const circuits: Record<VoiceProviderFeature, CircuitState> = {
  stt: { consecutiveFailures: 0, openedAt: null, lastSuccessAt: null, lastFailureAt: null },
  tts: { consecutiveFailures: 0, openedAt: null, lastSuccessAt: null, lastFailureAt: null },
};

export function canCallVoiceProvider(feature: VoiceProviderFeature): boolean {
  if (!config.siliconflowApiKey) return false;
  const state = circuits[feature];
  if (state.openedAt === null) return true;
  if (Date.now() - state.openedAt >= OPEN_MS) {
    state.openedAt = null;
    return true;
  }
  return false;
}

export function recordVoiceProviderResult(feature: VoiceProviderFeature, success: boolean): void {
  const state = circuits[feature];
  if (success) {
    state.consecutiveFailures = 0;
    state.openedAt = null;
    state.lastSuccessAt = Date.now();
    return;
  }

  state.consecutiveFailures += 1;
  state.lastFailureAt = Date.now();
  if (state.consecutiveFailures >= FAILURE_THRESHOLD) {
    state.openedAt = Date.now();
  }
}

export function getVoiceProviderStatus(): Record<VoiceProviderFeature, {
  status: 'available' | 'not_configured' | 'circuit_open';
  retryAfterSec?: number;
  consecutiveFailures: number;
  lastSuccessAt?: string;
  lastFailureAt?: string;
}> {
  const statusFor = (feature: VoiceProviderFeature) => {
    const state = circuits[feature];
    const diagnostics = {
      consecutiveFailures: state.consecutiveFailures,
      ...(state.lastSuccessAt ? { lastSuccessAt: new Date(state.lastSuccessAt).toISOString() } : {}),
      ...(state.lastFailureAt ? { lastFailureAt: new Date(state.lastFailureAt).toISOString() } : {}),
    };
    if (!config.siliconflowApiKey) {
      return { status: 'not_configured' as const, ...diagnostics };
    }
    if (state.openedAt !== null && Date.now() - state.openedAt < OPEN_MS) {
      return {
        status: 'circuit_open' as const,
        retryAfterSec: Math.max(1, Math.ceil((OPEN_MS - (Date.now() - state.openedAt)) / 1_000)),
        ...diagnostics,
      };
    }
    return { status: 'available' as const, ...diagnostics };
  };

  return { stt: statusFor('stt'), tts: statusFor('tts') };
}
