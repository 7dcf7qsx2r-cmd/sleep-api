import type { SubjectType } from '../lib/jwt.js';
import { query } from '../db/client.js';
import { privacyHash } from './rateLimit.js';

export type VoiceMetricFeature = 'stt' | 'tts' | 'guest_mint' | 'client_playback';
const RETENTION_DAYS = 90;
let lastPrunedAt = 0;

export async function recordVoiceEvent(event: {
  feature: VoiceMetricFeature;
  outcome: string;
  subjectType?: SubjectType;
  subjectId?: string;
  units?: number;
  latencyMs?: number;
  scene?: 'chat' | 'bedtime' | 'classroom';
  engine?: 'neural' | 'native' | 'web_speech';
  reasonCode?: string;
  requestId?: string;
  providerStatus?: number;
  providerTraceId?: string;
}): Promise<void> {
  try {
    await query(
      `INSERT INTO voice_usage_events
        (feature, outcome, subject_type, subject_hash, units, latency_ms,
         scene, engine, reason_code, request_id, provider_status, provider_trace_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        event.feature,
        event.outcome.slice(0, 64),
        event.subjectType ?? null,
        event.subjectId ? privacyHash(event.subjectId) : null,
        Math.max(0, Math.round(event.units ?? 0)),
        Math.max(0, Math.round(event.latencyMs ?? 0)),
        event.scene ?? null,
        event.engine ?? null,
        event.reasonCode?.slice(0, 64) ?? null,
        event.requestId?.slice(0, 128) ?? null,
        event.providerStatus ?? null,
        event.providerTraceId?.slice(0, 128) ?? null,
      ],
    );
    if (Date.now() - lastPrunedAt > 24 * 60 * 60 * 1_000) {
      lastPrunedAt = Date.now();
      void query(
        `DELETE FROM voice_usage_events
         WHERE created_at < NOW() - ($1::int * INTERVAL '1 day')`,
        [RETENTION_DAYS],
      ).catch(() => undefined);
    }
  } catch (error) {
    console.warn('[sleep-api] Failed to write voice metric', {
      feature: event.feature,
      outcome: event.outcome,
      error: error instanceof Error ? error.name : 'unknown',
    });
  }
}

export async function getVoiceMetricsSummary(hours: number): Promise<{
  windowHours: number;
  generatedAt: string;
  features: unknown[];
  outcomes: unknown[];
}> {
  const safeHours = Math.max(1, Math.min(24 * 90, Math.round(hours)));
  const [features, outcomes] = await Promise.all([
    query(
      `SELECT
         feature,
         COUNT(*)::int AS requests,
         COUNT(*) FILTER (WHERE outcome = 'success')::int AS successes,
         COUNT(*) FILTER (WHERE outcome IN ('cancelled', 'request_cancelled'))::int AS cancellations,
         COUNT(*) FILTER (WHERE outcome IN ('quota_exceeded', 'rate_limited'))::int AS rate_limited,
         COUNT(*) FILTER (WHERE outcome = 'concurrency_rejected')::int AS concurrency_rejected,
         COALESCE(SUM(units), 0)::bigint AS units,
         COALESCE(ROUND(AVG(latency_ms)), 0)::int AS avg_latency_ms,
         COALESCE(
           ROUND(PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY latency_ms)),
           0
         )::int AS p95_latency_ms
       FROM voice_usage_events
       WHERE created_at >= NOW() - ($1::int * INTERVAL '1 hour')
       GROUP BY feature
       ORDER BY feature`,
      [safeHours],
    ),
    query(
      `SELECT
         feature,
         outcome,
         scene,
         engine,
         reason_code,
         COUNT(*)::int AS count
       FROM voice_usage_events
       WHERE created_at >= NOW() - ($1::int * INTERVAL '1 hour')
       GROUP BY feature, outcome, scene, engine, reason_code
       ORDER BY count DESC, feature, outcome`,
      [safeHours],
    ),
  ]);
  return {
    windowHours: safeHours,
    generatedAt: new Date().toISOString(),
    features: features.rows,
    outcomes: outcomes.rows,
  };
}
