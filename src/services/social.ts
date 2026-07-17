import { query } from '../db/client.js';
import { claimReward } from './energyLedger.js';

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
  return result.rows[0];
}

export async function listFeed(cursor?: string, limit = 20, viewerId?: string) {
  const params: (string | number)[] = [limit];
  let whereClause = '';

  if (cursor) {
    whereClause = `WHERE f.created_at < $2`;
    params.push(cursor);
  }

  const likedClause = viewerId
    ? `EXISTS (SELECT 1 FROM feed_likes l WHERE l.post_id = f.id AND l.user_id = $${params.length + 1}) as liked_by_me`
    : `FALSE as liked_by_me`;

  const allParams = viewerId ? [...params, viewerId] : params;

  const result = await query(
    `SELECT f.*,
       u.username as author_name,
       up.nickname as author_nickname,
       ${likedClause}
     FROM feed_posts f
     JOIN users u ON u.id = f.user_id
     LEFT JOIN user_profiles up ON up.user_id = f.user_id
     ${whereClause}
     ORDER BY f.created_at DESC
     LIMIT $1`,
    allParams,
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

/* ================================================================
   Night School
   ================================================================ */

function todayDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function weekKey(d = new Date()): string {
  const day = new Date(d);
  day.setHours(0, 0, 0, 0);
  const dow = day.getDay() || 7;
  day.setDate(day.getDate() - dow + 1);
  return day.toISOString().slice(0, 10);
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


/* ================================================================
   Sleep Squads
   ================================================================ */

const SQUAD_TARGET_NIGHTS = 10;
const SQUAD_REWARD_SE = 80;

export async function joinSleepSquad(input: {
  userId: string;
  sleepType: string;
  mainConcern?: string;
}) {
  const wk = weekKey();
  const squad = await query<{ id: string }>(
    `INSERT INTO sleep_squads (sleep_type, main_concern, week_key, target_nights, pool_reward_se)
     VALUES ($1, $2, $3::date, $4, $5)
     ON CONFLICT (sleep_type, main_concern, week_key)
     DO UPDATE SET sleep_type = EXCLUDED.sleep_type
     RETURNING id`,
    [input.sleepType, input.mainConcern ?? null, wk, SQUAD_TARGET_NIGHTS, SQUAD_REWARD_SE],
  );
  const squadId = squad.rows[0]!.id;

  await query(
    `INSERT INTO sleep_squad_members (squad_id, user_id)
     VALUES ($1, $2)
     ON CONFLICT (squad_id, user_id)
     DO UPDATE SET left_at = NULL`,
    [squadId, input.userId],
  );

  return getCurrentSleepSquad(input.userId);
}

export async function leaveCurrentSleepSquad(userId: string) {
  await query(
    `UPDATE sleep_squad_members
     SET left_at = NOW()
     WHERE user_id = $1 AND left_at IS NULL`,
    [userId],
  );
}

export async function recordSleepSquadCheckIn(userId: string, nightDate = todayDate()) {
  const squad = await getCurrentSleepSquadRow(userId);
  if (!squad) return null;
  await query(
    `INSERT INTO sleep_squad_checkins (squad_id, user_id, night_date)
     VALUES ($1, $2, $3::date)
     ON CONFLICT DO NOTHING`,
    [squad.id, userId, nightDate],
  );
  return getCurrentSleepSquad(userId);
}

export async function claimSleepSquadReward(userId: string) {
  const squad = await getCurrentSleepSquadRow(userId);
  if (!squad) return { ok: false, message: '尚未加入睡眠小队' };
  const dto = await buildSleepSquadDto(userId, squad);
  if (dto.rewardClaimedWeek === dto.weekKey) {
    return { ok: false, message: '本周奖励已领取', squad: dto };
  }
  if (dto.poolProgress < 100) {
    return { ok: false, message: `小队进度 ${dto.poolProgress}% ，满 100% 可领取能量池`, squad: dto };
  }

  await query(
    `INSERT INTO sleep_squad_rewards (squad_id, user_id, week_key)
     VALUES ($1, $2, $3::date)
     ON CONFLICT DO NOTHING`,
    [squad.id, userId, squad.week_key],
  );
  const reward = await claimReward(
    userId,
    'squad_weekly',
    `${squad.id}:${squad.week_key}`,
    squad.pool_reward_se,
    '睡眠小队周奖励',
  );
  return {
    ok: reward.earned > 0,
    message: reward.earned > 0 ? `小队能量池已开启，获得 ${reward.earned} SE` : '本周奖励已领取',
    rewardSe: reward.earned,
    squad: await getCurrentSleepSquad(userId),
  };
}

export async function getCurrentSleepSquad(userId: string) {
  const squad = await getCurrentSleepSquadRow(userId);
  if (!squad) return null;
  return buildSleepSquadDto(userId, squad);
}

async function getCurrentSleepSquadRow(userId: string) {
  const wk = weekKey();
  const row = await query<{
    id: string;
    sleep_type: string;
    main_concern: string | null;
    week_key: string;
    target_nights: number;
    pool_reward_se: number;
    joined_at: Date;
  }>(
    `SELECT s.id, s.sleep_type, s.main_concern, s.week_key::text,
            s.target_nights, s.pool_reward_se, m.joined_at
     FROM sleep_squad_members m
     JOIN sleep_squads s ON s.id = m.squad_id
     WHERE m.user_id = $1
       AND m.left_at IS NULL
       AND s.week_key = $2::date
     ORDER BY m.joined_at DESC
     LIMIT 1`,
    [userId, wk],
  );
  return row.rows[0] ?? null;
}

async function buildSleepSquadDto(
  userId: string,
  squad: {
    id: string;
    sleep_type: string;
    main_concern: string | null;
    week_key: string;
    target_nights: number;
    pool_reward_se: number;
    joined_at: Date;
  },
) {
  const members = await query<{
    id: string;
    username: string | null;
    nickname: string | null;
    avatar_url: string | null;
  }>(
    `SELECT u.id, u.username, up.nickname, up.avatar_url
     FROM sleep_squad_members m
     JOIN users u ON u.id = m.user_id
     LEFT JOIN user_profiles up ON up.user_id = u.id
     WHERE m.squad_id = $1 AND m.left_at IS NULL
     ORDER BY m.joined_at ASC`,
    [squad.id],
  );
  const checkins = await query<{ user_id: string; night_date: string }>(
    `SELECT user_id, night_date::text
     FROM sleep_squad_checkins
     WHERE squad_id = $1`,
    [squad.id],
  );
  const reward = await query<{ claimed_at: Date }>(
    `SELECT claimed_at
     FROM sleep_squad_rewards
     WHERE squad_id = $1 AND user_id = $2 AND week_key = $3::date`,
    [squad.id, userId, squad.week_key],
  );
  const userCheckInDates = checkins.rows
    .filter((row) => row.user_id === userId)
    .map((row) => row.night_date);
  const squadNights = checkins.rows.length;
  const otherNights = Math.max(0, squadNights - userCheckInDates.length);

  return {
    id: squad.id,
    label: squad.main_concern ? `${squad.sleep_type} · ${squad.main_concern}` : `${squad.sleep_type}同行小队`,
    sleepType: squad.sleep_type,
    mainConcern: squad.main_concern,
    weekKey: squad.week_key,
    poolProgress: Math.min(100, Math.round((squadNights / squad.target_nights) * 100)),
    poolRewardSe: squad.pool_reward_se,
    targetNights: squad.target_nights,
    userCheckInDates,
    squadNights,
    otherMemberCheckIns: otherNights,
    anonCheckIns: otherNights,
    rewardClaimedWeek: reward.rows[0] ? squad.week_key : undefined,
    joinedAt: squad.joined_at.toISOString(),
    members: members.rows
      .filter((member) => member.id !== userId)
      .map((member) => ({
        id: member.id,
        alias: displayName(member),
        avatar: member.avatar_url ?? '',
      })),
  };
}
