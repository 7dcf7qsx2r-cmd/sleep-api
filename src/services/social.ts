import { query } from '../db/client.js';
import { tipFeedPost } from './energyLedger.js';
import { recordSleepSquadContributionFromPost, weekKey } from './sleepSquad.js';

export {
  SleepSquadError,
  allocateLargestRemainder,
  claimSleepSquadReward,
  getCurrentSleepSquad,
  getSleepSquadState,
  joinSleepSquad,
  leaveCurrentSleepSquad,
  recordSleepSquadCheckIn,
  recordSleepSquadContributionFromPost,
  weekKey,
} from './sleepSquad.js';
export type { PendingSquadClaim, SleepSquadDto, SleepSquadState, SquadLeaderEntry } from './sleepSquad.js';

/* ================================================================
   Friendships
   ================================================================ */

export async function requestFriend(userId: string, friendId: string) {
  if (userId === friendId) throw new Error('cannot_friend_self');
  const result = await query(
    `INSERT INTO friendships (user_id, friend_id, status)
     VALUES ($1, $2, 'pending')
     ON CONFLICT (user_id, friend_id) DO NOTHING
     RETURNING *`,
    [userId, friendId],
  );
  return result.rows[0] ?? null;
}

export async function acceptFriend(userId: string, friendId: string) {
  // Accept the request where user_id=friendId and friend_id=userId
  const result = await query(
    `UPDATE friendships
     SET status = 'accepted'
     WHERE user_id = $2 AND friend_id = $1 AND status = 'pending'
     RETURNING *`,
    [userId, friendId],
  );
  if (result.rows.length === 0) return null;

  // Create reciprocal record if not exists
  await query(
    `INSERT INTO friendships (user_id, friend_id, status)
     VALUES ($1, $2, 'accepted')
     ON CONFLICT (user_id, friend_id) DO NOTHING`,
    [userId, friendId],
  );
  return result.rows[0];
}

export async function removeFriend(userId: string, friendId: string) {
  await query(
    `DELETE FROM friendships WHERE (user_id = $1 AND friend_id = $2) OR (user_id = $2 AND friend_id = $1)`,
    [userId, friendId],
  );
}

export async function listFriends(userId: string) {
  const result = await query(
    `SELECT u.id, u.username, up.nickname
     FROM friendships f
     JOIN users u ON u.id = f.friend_id
     LEFT JOIN user_profiles up ON up.user_id = u.id
     WHERE f.user_id = $1 AND f.status = 'accepted'
     ORDER BY f.created_at DESC`,
    [userId],
  );
  return result.rows;
}

export async function listPendingRequests(userId: string) {
  const result = await query(
    `SELECT u.id, u.username, up.nickname, f.created_at
     FROM friendships f
     JOIN users u ON u.id = f.user_id
     LEFT JOIN user_profiles up ON up.user_id = u.id
     WHERE f.friend_id = $1 AND f.status = 'pending'
     ORDER BY f.created_at DESC`,
    [userId],
  );
  return result.rows;
}

/* ================================================================
   Dream Bottles
   ================================================================ */

export interface CreateBottleInput {
  senderId: string;
  content: string;
  moodTags?: string[];
  bottleType: 'random' | 'directed';
  recipientId?: string;
}

export async function createBottle(input: CreateBottleInput) {
  const result = await query(
    `INSERT INTO dream_bottles (sender_id, content, mood_tags, bottle_type, recipient_id)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [input.senderId, input.content, input.moodTags ?? [], input.bottleType, input.recipientId ?? null],
  );
  return result.rows[0];
}

export async function pickRandomBottle(userId: string) {
  // Pick a random floating bottle that:
  // 1. is not sent by the user
  // 2. has not been read by the user
  // 3. is either random type OR directed to this user
  const result = await query(
    `SELECT b.*
     FROM dream_bottles b
     WHERE b.status = 'floating'
       AND b.sender_id != $1
       AND b.id NOT IN (SELECT bottle_id FROM bottle_reads WHERE user_id = $1)
       AND (b.bottle_type = 'random' OR b.recipient_id = $1)
     ORDER BY RANDOM()
     LIMIT 1`,
    [userId],
  );

  if (result.rows.length === 0) return null;
  const bottle = result.rows[0];

  // Mark as picked
  await query(
    `UPDATE dream_bottles SET status = 'picked', picked_by = $1, picked_at = NOW() WHERE id = $2`,
    [userId, bottle.id],
  );

  // Record read
  await query(
    `INSERT INTO bottle_reads (user_id, bottle_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [userId, bottle.id],
  );

  return { ...bottle, status: 'picked', picked_by: userId };
}

export async function replyToBottle(bottleId: string, senderId: string, content: string) {
  const result = await query(
    `INSERT INTO bottle_replies (bottle_id, sender_id, content) VALUES ($1, $2, $3) RETURNING *`,
    [bottleId, senderId, content],
  );

  // Update bottle status
  await query(
    `UPDATE dream_bottles SET status = 'replied' WHERE id = $1`,
    [bottleId],
  );

  return result.rows[0];
}

export async function listBottleReplies(bottleId: string) {
  const result = await query(
    `SELECT r.*, u.username as sender_name
     FROM bottle_replies r
     JOIN users u ON u.id = r.sender_id
     WHERE r.bottle_id = $1
     ORDER BY r.created_at ASC`,
    [bottleId],
  );
  return result.rows;
}

export async function listSentBottles(userId: string) {
  const result = await query(
    `SELECT b.*,
       (SELECT COUNT(*) FROM bottle_replies WHERE bottle_id = b.id) as reply_count
     FROM dream_bottles b
     WHERE b.sender_id = $1
     ORDER BY b.created_at DESC`,
    [userId],
  );
  return result.rows;
}

export async function listReceivedBottles(userId: string) {
  const result = await query(
    `SELECT b.*,
       (SELECT COUNT(*) FROM bottle_replies WHERE bottle_id = b.id) as reply_count
     FROM dream_bottles b
     WHERE b.picked_by = $1
     ORDER BY b.picked_at DESC`,
    [userId],
  );
  return result.rows;
}

export async function getBottleById(bottleId: string) {
  const result = await query(`SELECT * FROM dream_bottles WHERE id = $1`, [bottleId]);
  return result.rows[0] ?? null;
}

/* ================================================================
   Feed
   ================================================================ */

export interface CreatePostInput {
  userId: string;
  type: 'milestone' | 'dream_share' | 'check_in' | 'achievement';
  contentJson: Record<string, unknown>;
}

export async function createPost(input: CreatePostInput) {
  const result = await query(
    `INSERT INTO feed_posts (user_id, type, content_json) VALUES ($1, $2, $3) RETURNING *`,
    [input.userId, input.type, JSON.stringify(input.contentJson)],
  );
  const post = result.rows[0];
  try {
    await recordSleepSquadContributionFromPost(
      input.userId,
      input.type,
      input.contentJson,
      post?.id,
    );
  } catch {
    // 小队表在部分单测环境可能尚未建表
  }
  return post;
}

export interface FeedCursor {
  created_at: string;
  id: string;
}

export function encodeFeedCursor(row: { created_at: Date | string; id: string }): string {
  const createdAt = row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at;
  return Buffer.from(JSON.stringify({ created_at: createdAt, id: row.id })).toString('base64url');
}

export function decodeFeedCursor(cursor: string): FeedCursor | { created_at: string; id?: undefined } | null {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Partial<FeedCursor>;
    if (
      typeof parsed.created_at === 'string'
      && !Number.isNaN(Date.parse(parsed.created_at))
      && typeof parsed.id === 'string'
      && /^[0-9a-f-]{36}$/i.test(parsed.id)
    ) {
      return { created_at: parsed.created_at, id: parsed.id };
    }
  } catch {
    // Fall through to the legacy timestamp cursor.
  }
  return !Number.isNaN(Date.parse(cursor)) ? { created_at: cursor } : null;
}

export async function listFeed(cursor?: string, limit = 20, viewerId?: string) {
  if (!viewerId) return [];

  const params: (string | number)[] = [limit];
  const filters: string[] = [];

  if (cursor) {
    const decoded = decodeFeedCursor(cursor);
    if (decoded?.id) {
      filters.push(`(f.created_at, f.id) < ($2::timestamptz, $3::uuid)`);
      params.push(decoded.created_at, decoded.id);
    } else if (decoded) {
      // Backward compatibility for the previous plain created_at cursor.
      filters.push(`f.created_at < $2::timestamptz`);
      params.push(decoded.created_at);
    }
  }

  const viewerIdx = params.length + 1;
  const weekIdx = params.length + 2;
  params.push(viewerId, weekKey());

  filters.push(`(
    f.user_id = $${viewerIdx}
    OR EXISTS (
      SELECT 1 FROM user_follows uf
      WHERE uf.follower_id = $${viewerIdx} AND uf.followed_id = f.user_id
    )
    OR EXISTS (
      SELECT 1
      FROM sleep_squad_members me
      JOIN sleep_squads s
        ON s.id = me.squad_id AND s.week_key = $${weekIdx}::date
      JOIN sleep_squad_members mate
        ON mate.squad_id = me.squad_id AND mate.left_at IS NULL
      WHERE me.user_id = $${viewerIdx}
        AND me.left_at IS NULL
        AND mate.user_id = f.user_id
    )
  )`);

  const likedClause =
    `EXISTS (SELECT 1 FROM feed_likes l WHERE l.post_id = f.id AND l.user_id = $${viewerIdx}) as liked_by_me`;
  const followedClause =
    `EXISTS (SELECT 1 FROM user_follows uf WHERE uf.followed_id = f.user_id AND uf.follower_id = $${viewerIdx}) as followed_by_me`;

  const result = await query(
    `SELECT f.*,
       u.username as author_name,
       up.nickname as author_nickname,
       up.avatar_url as author_avatar,
       COALESCE(profile_blob.data->>'sleepType', persona_blob.data->>'sleepType') as author_sleep_type,
       ${likedClause},
       ${followedClause},
       (SELECT COUNT(*)::int FROM feed_comments c WHERE c.post_id = f.id) as comment_count,
       (SELECT COALESCE(SUM(t.amount), 0)::int FROM feed_tips t WHERE t.post_id = f.id) as tip_amount
     FROM feed_posts f
     JOIN users u ON u.id = f.user_id
     LEFT JOIN user_profiles up ON up.user_id = f.user_id
     LEFT JOIN data_blobs profile_blob
       ON profile_blob.owner_type = 'user' AND profile_blob.owner_id = f.user_id AND profile_blob.domain = 'profile'
     LEFT JOIN data_blobs persona_blob
       ON persona_blob.owner_type = 'user' AND persona_blob.owner_id = f.user_id AND persona_blob.domain = 'persona'
     WHERE ${filters.join(' AND ')}
     ORDER BY f.created_at DESC, f.id DESC
     LIMIT $1`,
    params,
  );
  return result.rows;
}

export async function getPostById(postId: string) {
  const result = await query(
    `SELECT f.*, u.username as author_name, up.nickname as author_nickname
     FROM feed_posts f
     JOIN users u ON u.id = f.user_id
     LEFT JOIN user_profiles up ON up.user_id = f.user_id
     WHERE f.id = $1`,
    [postId],
  );
  return result.rows[0] ?? null;
}

export async function toggleLike(userId: string, postId: string) {
  const existing = await query(
    `SELECT 1 FROM feed_likes WHERE user_id = $1 AND post_id = $2`,
    [userId, postId],
  );

  if (existing.rows.length > 0) {
    // Unlike
    await query(`DELETE FROM feed_likes WHERE user_id = $1 AND post_id = $2`, [userId, postId]);
    await query(`UPDATE feed_posts SET like_count = like_count - 1 WHERE id = $1`, [postId]);
    return { liked: false };
  } else {
    // Like
    await query(`INSERT INTO feed_likes (user_id, post_id) VALUES ($1, $2)`, [userId, postId]);
    await query(`UPDATE feed_posts SET like_count = like_count + 1 WHERE id = $1`, [postId]);
    return { liked: true };
  }
}

export async function listFeedComments(postId: string, limit = 100) {
  const result = await query(
    `SELECT c.id, c.post_id, c.user_id, c.content, c.created_at,
            u.username as author_name, up.nickname as author_nickname,
            up.avatar_url as author_avatar
     FROM feed_comments c
     JOIN users u ON u.id = c.user_id
     LEFT JOIN user_profiles up ON up.user_id = c.user_id
     WHERE c.post_id = $1
     ORDER BY c.created_at ASC, c.id ASC
     LIMIT $2`,
    [postId, limit],
  );
  return result.rows;
}

export async function createFeedComment(userId: string, postId: string, content: string) {
  const result = await query(
    `INSERT INTO feed_comments (post_id, user_id, content)
     SELECT $1, $2, $3
     WHERE EXISTS (SELECT 1 FROM feed_posts WHERE id = $1)
     RETURNING *`,
    [postId, userId, content],
  );
  return result.rows[0] ?? null;
}

export async function toggleFollow(followerId: string, followedId: string) {
  if (followerId === followedId) throw new Error('cannot_follow_self');
  const removed = await query(
    `DELETE FROM user_follows
     WHERE follower_id = $1 AND followed_id = $2
     RETURNING followed_id`,
    [followerId, followedId],
  );
  if (removed.rows[0]) return { followed: false };

  const inserted = await query(
    `INSERT INTO user_follows (follower_id, followed_id)
     SELECT $1, $2
     WHERE EXISTS (SELECT 1 FROM users WHERE id = $2 AND deleted_at IS NULL)
     ON CONFLICT DO NOTHING
     RETURNING followed_id`,
    [followerId, followedId],
  );
  if (inserted.rows[0]) return { followed: true };
  const existing = await query(
    `SELECT 1 FROM user_follows WHERE follower_id = $1 AND followed_id = $2`,
    [followerId, followedId],
  );
  return existing.rows[0] ? { followed: true } : null;
}

export async function tipPost(input: {
  senderId: string;
  postId: string;
  amount: number;
  idempotencyKey: string;
}) {
  return tipFeedPost(input);
}

export async function reportPost(input: {
  reporterId: string;
  postId: string;
  reason: string;
  details?: string;
}) {
  const result = await query(
    `INSERT INTO feed_reports (post_id, reporter_id, reason, details)
     SELECT $1, $2, $3, $4
     WHERE EXISTS (SELECT 1 FROM feed_posts WHERE id = $1)
     ON CONFLICT (post_id, reporter_id) DO NOTHING
     RETURNING *`,
    [input.postId, input.reporterId, input.reason, input.details ?? null],
  );
  if (result.rows[0]) return { report: result.rows[0], duplicate: false };
  const existing = await query(
    `SELECT * FROM feed_reports WHERE post_id = $1 AND reporter_id = $2`,
    [input.postId, input.reporterId],
  );
  return existing.rows[0] ? { report: existing.rows[0], duplicate: true } : null;
}

/* ================================================================
   Night School
   ================================================================ */

function todayDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function displayName(row: { nickname?: string | null; username?: string | null; id: string }): string {
  return row.nickname?.trim() || row.username?.trim() || `用户${row.id.slice(0, 4)}`;
}

export async function upsertNightSchoolCheckIn(input: {
  userId: string;
  mainConcern: string;
  episodeIndex: number;
  nightDate?: string;
  wallNote?: string;
}) {
  const nightDate = input.nightDate ?? todayDate();
  await query(
    `INSERT INTO night_school_checkins (user_id, main_concern, episode_index, night_date, online_until)
     VALUES ($1, $2, $3, $4::date, NOW() + INTERVAL '20 minutes')
     ON CONFLICT (user_id, main_concern, night_date)
     DO UPDATE SET
       episode_index = GREATEST(night_school_checkins.episode_index, EXCLUDED.episode_index),
       online_until = EXCLUDED.online_until,
       updated_at = NOW()`,
    [input.userId, input.mainConcern, input.episodeIndex, nightDate],
  );

  const text = input.wallNote?.trim().slice(0, 60);
  if (text) {
    await query(
      `INSERT INTO night_school_wall_notes (user_id, main_concern, episode_index, night_date, text)
       VALUES ($1, $2, $3, $4::date, $5)
       ON CONFLICT (user_id, main_concern, night_date)
       DO UPDATE SET text = EXCLUDED.text, episode_index = EXCLUDED.episode_index, created_at = NOW()`,
      [input.userId, input.mainConcern, input.episodeIndex, nightDate, text],
    );
  }
}

export async function getNightSchoolCohort(userId: string, mainConcern: string, nightDate = todayDate()) {
  await query(
    `INSERT INTO night_school_checkins (user_id, main_concern, episode_index, night_date, online_until)
     VALUES ($1, $2, 0, $3::date, NOW() + INTERVAL '10 minutes')
     ON CONFLICT (user_id, main_concern, night_date)
     DO UPDATE SET online_until = EXCLUDED.online_until, updated_at = NOW()`,
    [userId, mainConcern, nightDate],
  );

  const stats = await query<{ online_tonight: string; completed_tonight: string }>(
    `SELECT
       COUNT(*) FILTER (WHERE online_until > NOW())::text AS online_tonight,
       COUNT(*) FILTER (WHERE episode_index > 0)::text AS completed_tonight
     FROM night_school_checkins
     WHERE main_concern = $1 AND night_date = $2::date`,
    [mainConcern, nightDate],
  );

  const mate = await query<{
    id: string;
    username: string | null;
    nickname: string | null;
    avatar_url: string | null;
    attended_tonight: boolean;
  }>(
    `SELECT u.id, u.username, up.nickname, up.avatar_url,
            (nsc.episode_index > 0) AS attended_tonight
     FROM night_school_checkins nsc
     JOIN users u ON u.id = nsc.user_id
     LEFT JOIN user_profiles up ON up.user_id = u.id
     WHERE nsc.main_concern = $1
       AND nsc.night_date = $2::date
       AND nsc.user_id <> $3
     ORDER BY nsc.online_until DESC, nsc.updated_at DESC
     LIMIT 1`,
    [mainConcern, nightDate, userId],
  );
  const row = mate.rows[0];

  return {
    mainConcern,
    onlineTonight: Number(stats.rows[0]?.online_tonight ?? 0),
    completedTonight: Number(stats.rows[0]?.completed_tonight ?? 0),
    classmate: row
      ? {
          userId: row.id,
          alias: displayName(row),
          avatar: row.avatar_url,
          attendedTonight: row.attended_tonight,
        }
      : null,
  };
}

export async function listNightSchoolWallNotes(mainConcern: string, limit = 30) {
  const rows = await query<{
    id: string;
    user_id: string;
    username: string | null;
    nickname: string | null;
    avatar_url: string | null;
    night_date: string;
    text: string;
    episode_index: number;
    created_at: Date;
  }>(
    `SELECT n.id, n.user_id, u.username, up.nickname, up.avatar_url,
            n.night_date::text, n.text, n.episode_index, n.created_at
     FROM night_school_wall_notes n
     JOIN users u ON u.id = n.user_id
     LEFT JOIN user_profiles up ON up.user_id = n.user_id
     WHERE n.main_concern = $1
     ORDER BY n.created_at DESC
     LIMIT $2`,
    [mainConcern, limit],
  );
  return rows.rows.map((row) => ({
    id: row.id,
    userId: row.user_id,
    alias: displayName({ id: row.user_id, username: row.username, nickname: row.nickname }),
    avatar: row.avatar_url,
    nightDate: row.night_date,
    text: row.text,
    episodeIndex: row.episode_index,
    createdAt: row.created_at.toISOString(),
  }));
}

/* ================================================================
   Night Lab
   ================================================================ */

export interface NightLabCommitInput {
  id: string;
  userId: string;
  nightDate: string;
  mainConcern: string;
  experimentKind: string;
  hypothesisId: string;
  dataSource: string;
  confidence: string;
  verificationMetric?: string;
  noteText?: string;
}

export async function commitNightLabExperiment(input: NightLabCommitInput) {
  await query(
    `INSERT INTO night_lab_experiments (
       id, user_id, night_date, main_concern, experiment_kind, hypothesis_id,
       data_source, confidence, verification_metric, committed_at
     )
     VALUES ($1, $2, $3::date, $4, $5, $6, $7, $8, $9, NOW())
     ON CONFLICT (user_id, night_date)
     DO UPDATE SET
       id = EXCLUDED.id,
       main_concern = EXCLUDED.main_concern,
       experiment_kind = EXCLUDED.experiment_kind,
       hypothesis_id = EXCLUDED.hypothesis_id,
       data_source = EXCLUDED.data_source,
       confidence = EXCLUDED.confidence,
       verification_metric = EXCLUDED.verification_metric,
       committed_at = NOW()`,
    [
      input.id,
      input.userId,
      input.nightDate,
      input.mainConcern,
      input.experimentKind,
      input.hypothesisId,
      input.dataSource,
      input.confidence,
      input.verificationMetric ?? null,
    ],
  );

  const text = input.noteText?.trim().slice(0, 60);
  if (text) {
    await query(
      `INSERT INTO night_lab_group_notes (
         experiment_id, user_id, night_date, main_concern, experiment_kind, hypothesis_id, text
       )
       VALUES ($1, $2, $3::date, $4, $5, $6, $7)
       ON CONFLICT (user_id, night_date, experiment_kind, hypothesis_id)
       DO UPDATE SET text = EXCLUDED.text, created_at = NOW()`,
      [
        input.id,
        input.userId,
        input.nightDate,
        input.mainConcern,
        input.experimentKind,
        input.hypothesisId,
        text,
      ],
    );
  }
}

export async function revealNightLabExperiment(input: {
  userId: string;
  experimentId: string;
  resultBucket: string;
}) {
  const result = await query(
    `UPDATE night_lab_experiments
     SET result_bucket = $3, revealed_at = NOW()
     WHERE id = $1 AND user_id = $2
     RETURNING id, night_date::text, main_concern, experiment_kind, hypothesis_id, result_bucket`,
    [input.experimentId, input.userId, input.resultBucket],
  );
  return result.rows[0] ?? null;
}

export async function getNightLabGroup(params: {
  mainConcern: string;
  experimentKind: string;
  hypothesisId: string;
  nightDate?: string;
  limit?: number;
}) {
  const nightDate = params.nightDate ?? todayDate();
  const count = await query<{ count: string }>(
    `SELECT COUNT(*)::text AS count
     FROM night_lab_experiments
     WHERE night_date = $1::date
       AND main_concern = $2
       AND experiment_kind = $3
       AND hypothesis_id = $4`,
    [nightDate, params.mainConcern, params.experimentKind, params.hypothesisId],
  );
  const notes = await query<{
    id: string;
    user_id: string;
    username: string | null;
    nickname: string | null;
    text: string;
    created_at: Date;
  }>(
    `SELECT n.id, n.user_id, u.username, up.nickname, n.text, n.created_at
     FROM night_lab_group_notes n
     JOIN users u ON u.id = n.user_id
     LEFT JOIN user_profiles up ON up.user_id = n.user_id
     WHERE n.night_date = $1::date
       AND n.main_concern = $2
       AND n.experiment_kind = $3
       AND n.hypothesis_id = $4
     ORDER BY n.created_at DESC
     LIMIT $5`,
    [nightDate, params.mainConcern, params.experimentKind, params.hypothesisId, params.limit ?? 20],
  );
  return {
    nightDate,
    participants: Number(count.rows[0]?.count ?? 0),
    notes: notes.rows.map((row) => ({
      id: row.id,
      userId: row.user_id,
      alias: displayName({ id: row.user_id, username: row.username, nickname: row.nickname }),
      text: row.text,
      createdAt: row.created_at.toISOString(),
    })),
  };
}

export async function getNightLabGroupResult(params: {
  experimentKind: string;
  hypothesisId: string;
  nightDate?: string;
}) {
  const nightDate = params.nightDate ?? todayDate();
  const rows = await query<{ result_bucket: string | null; count: string }>(
    `SELECT result_bucket, COUNT(*)::text AS count
     FROM night_lab_experiments
     WHERE night_date = $1::date
       AND experiment_kind = $2
       AND hypothesis_id = $3
       AND result_bucket IS NOT NULL
     GROUP BY result_bucket`,
    [nightDate, params.experimentKind, params.hypothesisId],
  );
  const buckets = Object.fromEntries(rows.rows.map((row) => [row.result_bucket ?? 'unknown', Number(row.count)]));
  const total = Object.values(buckets).reduce((sum, n) => sum + n, 0);
  const improved = (buckets.hit ?? 0) + (buckets.partial ?? 0);
  return {
    nightDate,
    total,
    improved,
    improvementRate: total > 0 ? improved / total : 0,
    buckets,
  };
}


