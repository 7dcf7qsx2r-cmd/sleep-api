import { config } from '../config.js';
import { query } from '../db/client.js';
import type { SubjectType } from '../lib/jwt.js';

export type QuotaKind = 'chat' | 'interpret' | 'stt' | 'tts';

type UsageRow = {
  chat_count: number;
  interpret_count: number;
  stt_count: number;
  stt_seconds: number;
  tts_count: number;
  tts_chars: number;
};

type QuotaLimits = {
  chat: number;
  interpret: number;
  stt: number;
  sttSeconds: number;
  tts: number;
  ttsChars: number;
};

function limits(type: SubjectType): QuotaLimits {
  if (type === 'guest') {
    return {
      chat: config.quota.guestChat,
      interpret: config.quota.guestInterpret,
      stt: config.quota.guestStt,
      sttSeconds: config.quota.guestSttSeconds,
      tts: config.quota.guestTts,
      ttsChars: config.quota.guestTtsChars,
    };
  }
  return {
    chat: config.quota.userChat,
    interpret: config.quota.userInterpret,
    stt: config.quota.userStt,
    sttSeconds: config.quota.userSttSeconds,
    tts: config.quota.userTts,
    ttsChars: config.quota.userTtsChars,
  };
}

async function getUsage(subjectType: SubjectType, subjectId: string) {
  const row = await query<UsageRow>(
    `SELECT chat_count, interpret_count, stt_count, stt_seconds, tts_count, tts_chars
     FROM ai_usage_daily
     WHERE subject_type = $1 AND subject_id = $2 AND usage_date = CURRENT_DATE`,
    [subjectType, subjectId],
  );
  return row.rows[0] ?? {
    chat_count: 0,
    interpret_count: 0,
    stt_count: 0,
    stt_seconds: 0,
    tts_count: 0,
    tts_chars: 0,
  };
}

export async function getQuotaSnapshot(subjectType: SubjectType, subjectId: string) {
  const lim = limits(subjectType);
  const usage = await getUsage(subjectType, subjectId);
  const unlimited = (n: number) => (n <= 0 ? null : n);
  return {
    subjectType,
    subjectId,
    chat: { used: usage.chat_count, limit: unlimited(lim.chat) },
    interpret: { used: usage.interpret_count, limit: unlimited(lim.interpret) },
    stt: {
      used: usage.stt_count,
      limit: unlimited(lim.stt),
      secondsUsed: usage.stt_seconds,
      secondsLimit: unlimited(lim.sttSeconds),
    },
    tts: {
      used: usage.tts_count,
      limit: unlimited(lim.tts),
      charsUsed: usage.tts_chars,
      charsLimit: unlimited(lim.ttsChars),
    },
  };
}

function isOver(limit: number, amount: number): boolean {
  return limit > 0 && amount > limit;
}

async function consume(
  subjectType: SubjectType,
  subjectId: string,
  kind: QuotaKind,
  units: number,
): Promise<boolean> {
  const lim = limits(subjectType);
  let sql: string;
  let params: unknown[];

  if (kind === 'chat' || kind === 'interpret') {
    const column = kind === 'chat' ? 'chat_count' : 'interpret_count';
    const max = kind === 'chat' ? lim.chat : lim.interpret;
    if (isOver(max, 1)) return false;
    sql = `INSERT INTO ai_usage_daily
      (subject_type, subject_id, usage_date, chat_count, interpret_count)
      VALUES ($1, $2, CURRENT_DATE, ${kind === 'chat' ? 1 : 0}, ${kind === 'interpret' ? 1 : 0})
      ON CONFLICT (subject_type, subject_id, usage_date) DO UPDATE
      SET ${column} = ai_usage_daily.${column} + 1
      WHERE $3::int <= 0 OR ai_usage_daily.${column} + 1 <= $3
      RETURNING ${column}`;
    params = [subjectType, subjectId, max];
  } else if (kind === 'stt') {
    const seconds = Math.max(1, Math.ceil(units));
    if (isOver(lim.stt, 1) || isOver(lim.sttSeconds, seconds)) return false;
    sql = `INSERT INTO ai_usage_daily
      (subject_type, subject_id, usage_date, stt_count, stt_seconds)
      VALUES ($1, $2, CURRENT_DATE, 1, $3)
      ON CONFLICT (subject_type, subject_id, usage_date) DO UPDATE
      SET stt_count = ai_usage_daily.stt_count + 1,
          stt_seconds = ai_usage_daily.stt_seconds + EXCLUDED.stt_seconds
      WHERE ($4::int <= 0 OR ai_usage_daily.stt_count + 1 <= $4)
        AND ($5::int <= 0 OR ai_usage_daily.stt_seconds + EXCLUDED.stt_seconds <= $5)
      RETURNING stt_count`;
    params = [subjectType, subjectId, seconds, lim.stt, lim.sttSeconds];
  } else {
    const chars = Math.max(1, Math.ceil(units));
    if (isOver(lim.tts, 1) || isOver(lim.ttsChars, chars)) return false;
    sql = `INSERT INTO ai_usage_daily
      (subject_type, subject_id, usage_date, tts_count, tts_chars)
      VALUES ($1, $2, CURRENT_DATE, 1, $3)
      ON CONFLICT (subject_type, subject_id, usage_date) DO UPDATE
      SET tts_count = ai_usage_daily.tts_count + 1,
          tts_chars = ai_usage_daily.tts_chars + EXCLUDED.tts_chars
      WHERE ($4::int <= 0 OR ai_usage_daily.tts_count + 1 <= $4)
        AND ($5::int <= 0 OR ai_usage_daily.tts_chars + EXCLUDED.tts_chars <= $5)
      RETURNING tts_count`;
    params = [subjectType, subjectId, chars, lim.tts, lim.ttsChars];
  }

  const result = await query(sql, params);
  return result.rows.length === 1;
}

export async function checkAndConsume(
  subjectType: SubjectType,
  subjectId: string,
  kind: QuotaKind,
  units = 1,
): Promise<{ allowed: boolean; snapshot: Awaited<ReturnType<typeof getQuotaSnapshot>> }> {
  const allowed = await consume(subjectType, subjectId, kind, units);
  return { allowed, snapshot: await getQuotaSnapshot(subjectType, subjectId) };
}

export async function checkAndIncrement(
  subjectType: SubjectType,
  subjectId: string,
  kind: QuotaKind,
): Promise<{ allowed: boolean; snapshot: Awaited<ReturnType<typeof getQuotaSnapshot>> }> {
  return checkAndConsume(subjectType, subjectId, kind, 1);
}
