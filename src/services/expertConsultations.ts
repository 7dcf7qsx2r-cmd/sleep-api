import { query } from '../db/client.js';
import { getExpert } from './experts.js';
import { earliestBedFor } from './cbti/engine.js';
import { loadLivePlan, planDayOf } from './cbti/plans.js';

export interface ConsultationPlanContext {
  status: string;
  track: string;
  planDay: number;
  wakeAnchor: string;
  earliestBedTime: string | null;
}

export type ExpertConsultationStatus =
  | 'submitted'
  | 'accepted'
  | 'replied'
  | 'completed'
  | 'cancelled';

export interface ExpertConsultationRecord {
  id: string;
  expertId: string;
  expertName?: string;
  question: string;
  preferredTime: string;
  status: ExpertConsultationStatus;
  expertReply: string | null;
  planContext: ConsultationPlanContext | null;
  createdAt: string;
  updatedAt: string;
}

interface ConsultationRow {
  id: string;
  expert_id: string;
  expert_name: string | null;
  question: string;
  preferred_time: string;
  status: ExpertConsultationStatus;
  expert_reply: string | null;
  cbti_context: ConsultationPlanContext | null;
  created_at: Date;
  updated_at: Date;
}

function mapConsultation(row: ConsultationRow): ExpertConsultationRecord {
  return {
    id: row.id,
    expertId: row.expert_id,
    expertName: row.expert_name ?? undefined,
    question: row.question,
    preferredTime: row.preferred_time,
    status: row.status,
    expertReply: row.expert_reply,
    planContext: row.cbti_context ?? null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

const consultationSelect = `
  SELECT
    c.id,
    c.expert_id,
    e.name AS expert_name,
    c.question,
    c.preferred_time,
    c.status,
    c.expert_reply,
    c.cbti_context,
    c.created_at,
    c.updated_at
  FROM expert_consultations c
  JOIN experts e ON e.id = c.expert_id
`;

async function currentPlanContext(userId: string): Promise<ConsultationPlanContext | null> {
  const plan = await loadLivePlan(userId).catch(() => null);
  if (!plan) return null;
  return {
    status: plan.status,
    track: plan.track,
    planDay: planDayOf(plan),
    wakeAnchor: plan.wake_anchor,
    earliestBedTime: plan.track === 'full' && plan.prescribed_tib_min
      ? earliestBedFor(plan.wake_anchor, plan.prescribed_tib_min)
      : null,
  };
}

export async function createExpertConsultation(input: {
  userId: string;
  expertId: string;
  question: string;
  preferredTime: string;
  privacyConsent: true;
}): Promise<ExpertConsultationRecord | null> {
  const expert = await getExpert(input.expertId);
  if (!expert) return null;
  const planContext = await currentPlanContext(input.userId);

  const result = await query<ConsultationRow>(
    `INSERT INTO expert_consultations (
      expert_id, user_id, question, preferred_time, privacy_consent, cbti_context
    )
    VALUES ($1, $2, $3, $4, $5, $7::jsonb)
    RETURNING
      id,
      expert_id,
      $6::text AS expert_name,
      question,
      preferred_time,
      status,
      expert_reply,
      cbti_context,
      created_at,
      updated_at`,
    [
      input.expertId,
      input.userId,
      input.question.trim(),
      input.preferredTime.trim(),
      input.privacyConsent,
      expert.name,
      planContext ? JSON.stringify(planContext) : null,
    ],
  );
  const row = result.rows[0];
  return row ? mapConsultation(row) : null;
}

export async function listUserExpertConsultations(
  userId: string,
): Promise<ExpertConsultationRecord[]> {
  const result = await query<ConsultationRow>(
    `${consultationSelect}
     WHERE c.user_id = $1
     ORDER BY c.created_at DESC
     LIMIT 50`,
    [userId],
  );
  return result.rows.map(mapConsultation);
}

export async function getUserExpertConsultation(
  userId: string,
  consultationId: string,
): Promise<ExpertConsultationRecord | null> {
  const result = await query<ConsultationRow>(
    `${consultationSelect}
     WHERE c.user_id = $1 AND c.id = $2
     LIMIT 1`,
    [userId, consultationId],
  );
  const row = result.rows[0];
  return row ? mapConsultation(row) : null;
}
