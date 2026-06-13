import { config } from '../config.js';
import { query } from '../db/client.js';
import type { SubjectType } from '../lib/jwt.js';

export type QuotaKind = 'chat' | 'interpret';

function limits(type: SubjectType): { chat: number; interpret: number } {
  if (type === 'guest') {
    return { chat: config.quota.guestChat, interpret: config.quota.guestInterpret };
  }
  return { chat: config.quota.userChat, interpret: config.quota.userInterpret };
}

async function getUsage(subjectType: SubjectType, subjectId: string) {
  const row = await query<{ chat_count: number; interpret_count: number }>(
    `SELECT chat_count, interpret_count
     FROM ai_usage_daily
     WHERE subject_type = $1 AND subject_id = $2 AND usage_date = CURRENT_DATE`,
    [subjectType, subjectId],
  );
  return row.rows[0] ?? { chat_count: 0, interpret_count: 0 };
}

export async function getQuotaSnapshot(subjectType: SubjectType, subjectId: string) {
  const lim = limits(subjectType);
  const usage = await getUsage(subjectType, subjectId);
  return {
    subjectType,
    subjectId,
    chat: { used: usage.chat_count, limit: lim.chat },
    interpret: { used: usage.interpret_count, limit: lim.interpret },
  };
}

export async function checkAndIncrement(
  subjectType: SubjectType,
  subjectId: string,
  kind: QuotaKind,
): Promise<{ allowed: boolean; snapshot: Awaited<ReturnType<typeof getQuotaSnapshot>> }> {
  const lim = limits(subjectType);
  const column = kind === 'chat' ? 'chat_count' : 'interpret_count';
  const max = kind === 'chat' ? lim.chat : lim.interpret;

  const upsert = await query<{ chat_count: number; interpret_count: number }>(
    `INSERT INTO ai_usage_daily (subject_type, subject_id, usage_date, chat_count, interpret_count)
     VALUES ($1, $2, CURRENT_DATE, 0, 0)
     ON CONFLICT (subject_type, subject_id, usage_date) DO NOTHING
     RETURNING chat_count, interpret_count`,
    [subjectType, subjectId],
  );

  let usage = upsert.rows[0];
  if (!usage) {
    usage = (await getUsage(subjectType, subjectId)) as { chat_count: number; interpret_count: number };
  }

  const current = kind === 'chat' ? usage.chat_count : usage.interpret_count;
  if (current >= max) {
    return { allowed: false, snapshot: await getQuotaSnapshot(subjectType, subjectId) };
  }

  await query(
    `UPDATE ai_usage_daily
     SET ${column} = ${column} + 1
     WHERE subject_type = $1 AND subject_id = $2 AND usage_date = CURRENT_DATE`,
    [subjectType, subjectId],
  );

  return { allowed: true, snapshot: await getQuotaSnapshot(subjectType, subjectId) };
}
