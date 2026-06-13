import { query } from '../db/client.js';

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
