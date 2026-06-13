import { query } from '../db/client.js';

export type JobType = 'bottle_deliver' | 'push_notify' | 'feed_notify';

export interface JobPayload {
  bottleId?: string;
  userId?: string;
  title?: string;
  body?: string;
  data?: Record<string, unknown>;
  postId?: string;
  authorId?: string;
  likerId?: string;
  [key: string]: unknown;
}

export async function enqueueJob(type: JobType, payload: JobPayload, scheduledAt?: Date) {
  const result = await query(
    `INSERT INTO job_queue (type, payload_json, scheduled_at)
     VALUES ($1, $2, $3)
     RETURNING *`,
    [type, JSON.stringify(payload), scheduledAt ?? new Date()],
  );
  return result.rows[0];
}

export async function claimPendingJobs(batchSize = 10) {
  // Atomically claim pending jobs
  const result = await query(
    `UPDATE job_queue
     SET status = 'processing', attempts = attempts + 1
     WHERE id IN (
       SELECT id FROM job_queue
       WHERE status = 'pending' AND scheduled_at <= NOW()
       ORDER BY scheduled_at ASC
       LIMIT $1
       FOR UPDATE SKIP LOCKED
     )
     RETURNING *`,
    [batchSize],
  );
  return result.rows;
}

export async function markJobDone(jobId: string) {
  await query(
    `UPDATE job_queue SET status = 'done', processed_at = NOW() WHERE id = $1`,
    [jobId],
  );
}

export async function markJobFailed(jobId: string, error: string) {
  await query(
    `UPDATE job_queue SET status = 'failed', processed_at = NOW(), error = $2 WHERE id = $1`,
    [jobId, error],
  );
}

export async function retryFailedJobs(maxAttempts = 3) {
  const result = await query(
    `UPDATE job_queue
     SET status = 'pending', scheduled_at = NOW() + INTERVAL '5 minutes'
     WHERE status = 'failed' AND attempts < $1
     RETURNING *`,
    [maxAttempts],
  );
  return result.rows;
}
