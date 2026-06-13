import dotenv from 'dotenv';
dotenv.config();

import { claimPendingJobs, markJobDone, markJobFailed } from '../src/services/jobQueue.js';
import { sendPushToUser } from '../src/services/push.js';
import { getBottleById } from '../src/services/social.js';

const FCM_SERVER_KEY = process.env.FCM_SERVER_KEY ?? '';
const FCM_PROJECT_ID = process.env.FCM_PROJECT_ID ?? '';
const POLL_INTERVAL_MS = parseInt(process.env.WORKER_POLL_INTERVAL_MS ?? '5000', 10);

async function processJob(job: any) {
  console.log(`[worker] processing job ${job.id} type=${job.type}`);
  const payload = typeof job.payload_json === 'string' ? JSON.parse(job.payload_json) : job.payload_json;

  switch (job.type) {
    case 'push_notify': {
      if (!payload.userId || !payload.title || !payload.body) {
        throw new Error('invalid_push_payload');
      }
      const result = await sendPushToUser(
        FCM_SERVER_KEY,
        FCM_PROJECT_ID,
        payload.userId,
        payload.title,
        payload.body,
        payload.data,
      );
      console.log(`[worker] push result:`, result);
      break;
    }

    case 'bottle_deliver': {
      // Content moderation + smart matching
      if (payload.bottleId) {
        const bottle = await getBottleById(payload.bottleId);
        if (bottle) {
          // Simple content filter: flag overly long or repetitive content
          const content = bottle.content || '';
          const isSuspicious = content.length > 1500 || /^(.{1,5})\1{10,}$/.test(content);
          if (isSuspicious) {
            console.warn(`[worker] bottle ${payload.bottleId} flagged as suspicious`);
            // Could update status to 'flagged' here if needed
          }
          console.log(`[worker] bottle ${payload.bottleId} deliver processed, status=${bottle.status}, flagged=${isSuspicious}`);
        }
      }
      break;
    }

    case 'feed_notify': {
      // Notify followers when someone likes their post
      if (payload.postId && payload.authorId && payload.likerId) {
        // In a full implementation, this would:
        // 1. Query followers of the author
        // 2. Send push to each follower about the new activity
        // For now, just log — followers table doesn't exist yet
        const devices = await getUserDevices(payload.authorId);
        if (devices.length > 0) {
          console.log(`[worker] feed notify: ${devices.length} devices for author ${payload.authorId}`);
        } else {
          console.log(`[worker] feed notify: no devices for author ${payload.authorId}`);
        }
      } else if (payload.postId) {
        console.log(`[worker] feed notify for post ${payload.postId}`);
      }
      break;
    }

    default:
      throw new Error(`unknown_job_type: ${job.type}`);
  }
}

async function tick() {
  const jobs = await claimPendingJobs(10);
  if (jobs.length === 0) return;

  for (const job of jobs) {
    try {
      await processJob(job);
      await markJobDone(job.id);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[worker] job ${job.id} failed:`, message);
      await markJobFailed(job.id, message);
    }
  }
}

async function main() {
  console.log('[worker] started');
  console.log('[worker] FCM_PROJECT_ID:', FCM_PROJECT_ID || '(not configured)');

  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      await tick();
    } catch (err) {
      console.error('[worker] tick error:', err);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

main().catch((err) => {
  console.error('[worker] fatal:', err);
  process.exit(1);
});
