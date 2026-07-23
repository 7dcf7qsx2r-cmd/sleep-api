import { Hono } from 'hono';
import { query } from '../db/client.js';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { requireAuth, type AuthVariables } from '../middleware/auth.js';
import {
  requestFriend,
  acceptFriend,
  removeFriend,
  listFriends,
  listPendingRequests,
  createBottle,
  pickRandomBottle,
  replyToBottle,
  listBottleReplies,
  listSentBottles,
  listReceivedBottles,
  getBottleById,
  getPostById,
  createPost,
  listFeed,
  encodeFeedCursor,
  toggleLike,
  listFeedComments,
  createFeedComment,
  toggleFollow,
  tipPost,
  reportPost,
  getNightSchoolCohort,
  commitNightLabExperiment,
  getNightLabGroup,
  getNightLabGroupResult,
  listNightSchoolWallNotes,
  revealNightLabExperiment,
  upsertNightSchoolCheckIn,
  claimSleepSquadReward,
  getCurrentSleepSquad,
  joinSleepSquad,
  leaveCurrentSleepSquad,
  recordSleepSquadCheckIn,
} from '../services/social.js';
import { completeTask, FeedTipError } from '../services/energyLedger.js';
import { enqueueJob } from '../services/jobQueue.js';
import { saveUploadedImage } from '../lib/saveUploadedImage.js';

export const socialRoutes = new Hono<{ Variables: AuthVariables }>();

/* ================================================================
   Friendships
   ================================================================ */

socialRoutes.use('/friends/*', requireAuth);

socialRoutes.post(
  '/friends/request',
  zValidator('json', z.object({ friendId: z.string().uuid() })),
  async (c) => {
    const auth = c.get('auth');
    if (auth.type !== 'user') return c.json({ error: 'guest_not_allowed' }, 403);
    const { friendId } = c.req.valid('json');
    const row = await requestFriend(auth.sub, friendId);
    if (!row) return c.json({ error: 'already_requested_or_exists' }, 409);
    return c.json({ ok: true, friendship: row });
  },
);

socialRoutes.post(
  '/friends/accept',
  zValidator('json', z.object({ friendId: z.string().uuid() })),
  async (c) => {
    const auth = c.get('auth');
    if (auth.type !== 'user') return c.json({ error: 'guest_not_allowed' }, 403);
    const { friendId } = c.req.valid('json');
    const row = await acceptFriend(auth.sub, friendId);
    if (!row) return c.json({ error: 'no_pending_request' }, 404);
    return c.json({ ok: true, friendship: row });
  },
);

socialRoutes.post(
  '/friends/remove',
  zValidator('json', z.object({ friendId: z.string().uuid() })),
  async (c) => {
    const auth = c.get('auth');
    if (auth.type !== 'user') return c.json({ error: 'guest_not_allowed' }, 403);
    const { friendId } = c.req.valid('json');
    await removeFriend(auth.sub, friendId);
    return c.json({ ok: true });
  },
);

socialRoutes.get('/friends', async (c) => {
  const auth = c.get('auth');
  if (auth.type !== 'user') return c.json({ error: 'guest_not_allowed' }, 403);
  const rows = await listFriends(auth.sub);
  return c.json({ friends: rows });
});

socialRoutes.get('/friends/pending', async (c) => {
  const auth = c.get('auth');
  if (auth.type !== 'user') return c.json({ error: 'guest_not_allowed' }, 403);
  const rows = await listPendingRequests(auth.sub);
  return c.json({ requests: rows });
});

/* ================================================================
   Night School
   ================================================================ */

socialRoutes.use('/night-school/*', requireAuth);

socialRoutes.get('/night-school/cohort', async (c) => {
  const auth = c.get('auth');
  if (auth.type !== 'user') return c.json({ error: 'guest_not_allowed' }, 403);
  const concern = c.req.query('concern')?.trim();
  if (!concern) return c.json({ error: 'concern_required' }, 400);
  const cohort = await getNightSchoolCohort(auth.sub, concern);
  return c.json({ cohort });
});

socialRoutes.post(
  '/night-school/check-in',
  zValidator(
    'json',
    z.object({
      mainConcern: z.string().min(1).max(64),
      episodeIndex: z.number().int().min(0).max(99),
      nightDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      wallNote: z.string().max(60).optional(),
    }),
  ),
  async (c) => {
    const auth = c.get('auth');
    if (auth.type !== 'user') return c.json({ error: 'guest_not_allowed' }, 403);
    const body = c.req.valid('json');
    await upsertNightSchoolCheckIn({
      userId: auth.sub,
      mainConcern: body.mainConcern,
      episodeIndex: body.episodeIndex,
      nightDate: body.nightDate,
      wallNote: body.wallNote,
    });
    return c.json({ ok: true });
  },
);

socialRoutes.get('/night-school/wall', async (c) => {
  const auth = c.get('auth');
  if (auth.type !== 'user') return c.json({ error: 'guest_not_allowed' }, 403);
  const concern = c.req.query('concern')?.trim();
  if (!concern) return c.json({ error: 'concern_required' }, 400);
  const limit = Math.min(parseInt(c.req.query('limit') ?? '30', 10), 50);
  const notes = await listNightSchoolWallNotes(concern, limit);
  return c.json({ notes });
});

/* ================================================================
   Night Lab
   ================================================================ */

socialRoutes.use('/night-lab/*', requireAuth);

const nightLabBaseSchema = z.object({
  experimentId: z.string().min(1).max(80),
  nightDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  mainConcern: z.string().min(1).max(64),
  experimentKind: z.string().min(1).max(64),
  hypothesisId: z.string().min(1).max(64),
});

socialRoutes.post(
  '/night-lab/commit',
  zValidator(
    'json',
    nightLabBaseSchema.extend({
      dataSource: z.enum(['device', 'diary', 'seed']),
      confidence: z.enum(['high', 'medium', 'low']),
      verificationMetric: z.string().max(64).optional(),
      noteText: z.string().max(60).optional(),
    }),
  ),
  async (c) => {
    const auth = c.get('auth');
    if (auth.type !== 'user') return c.json({ error: 'guest_not_allowed' }, 403);
    const body = c.req.valid('json');
    await commitNightLabExperiment({
      id: body.experimentId,
      userId: auth.sub,
      nightDate: body.nightDate,
      mainConcern: body.mainConcern,
      experimentKind: body.experimentKind,
      hypothesisId: body.hypothesisId,
      dataSource: body.dataSource,
      confidence: body.confidence,
      verificationMetric: body.verificationMetric,
      noteText: body.noteText,
    });
    return c.json({ ok: true });
  },
);

socialRoutes.post(
  '/night-lab/reveal',
  zValidator(
    'json',
    z.object({
      experimentId: z.string().min(1).max(80),
      resultBucket: z.enum(['hit', 'partial', 'miss', 'insufficient_data']),
    }),
  ),
  async (c) => {
    const auth = c.get('auth');
    if (auth.type !== 'user') return c.json({ error: 'guest_not_allowed' }, 403);
    const body = c.req.valid('json');
    const experiment = await revealNightLabExperiment({
      userId: auth.sub,
      experimentId: body.experimentId,
      resultBucket: body.resultBucket,
    });
    if (!experiment) return c.json({ error: 'not_found' }, 404);
    return c.json({ ok: true, experiment });
  },
);

socialRoutes.get(
  '/night-lab/group',
  zValidator(
    'query',
    z.object({
      mainConcern: z.string().min(1).max(64),
      experimentKind: z.string().min(1).max(64),
      hypothesisId: z.string().min(1).max(64),
      nightDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      limit: z.coerce.number().int().min(1).max(50).optional(),
    }),
  ),
  async (c) => {
    const auth = c.get('auth');
    if (auth.type !== 'user') return c.json({ error: 'guest_not_allowed' }, 403);
    const q = c.req.valid('query');
    const group = await getNightLabGroup(q);
    return c.json({ group });
  },
);

socialRoutes.get(
  '/night-lab/group-result',
  zValidator(
    'query',
    z.object({
      experimentKind: z.string().min(1).max(64),
      hypothesisId: z.string().min(1).max(64),
      nightDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    }),
  ),
  async (c) => {
    const auth = c.get('auth');
    if (auth.type !== 'user') return c.json({ error: 'guest_not_allowed' }, 403);
    const q = c.req.valid('query');
    const result = await getNightLabGroupResult(q);
    return c.json({ result });
  },
);

/* ================================================================
   Sleep Squads
   ================================================================ */

socialRoutes.use('/squad/*', requireAuth);

socialRoutes.get('/squad/current', async (c) => {
  const auth = c.get('auth');
  if (auth.type !== 'user') return c.json({ error: 'guest_not_allowed' }, 403);
  const squad = await getCurrentSleepSquad(auth.sub);
  return c.json({ squad });
});

socialRoutes.post(
  '/squad/join',
  zValidator(
    'json',
    z.object({
      sleepType: z.string().min(1).max(64),
      mainConcern: z.string().min(1).max(64).optional(),
    }),
  ),
  async (c) => {
    const auth = c.get('auth');
    if (auth.type !== 'user') return c.json({ error: 'guest_not_allowed' }, 403);
    const body = c.req.valid('json');
    const squad = await joinSleepSquad({
      userId: auth.sub,
      sleepType: body.sleepType,
      mainConcern: body.mainConcern,
    });
    return c.json({ squad });
  },
);

socialRoutes.post('/squad/leave', async (c) => {
  const auth = c.get('auth');
  if (auth.type !== 'user') return c.json({ error: 'guest_not_allowed' }, 403);
  await leaveCurrentSleepSquad(auth.sub);
  return c.json({ ok: true });
});

socialRoutes.post(
  '/squad/check-in',
  zValidator('json', z.object({ nightDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) })),
  async (c) => {
    const auth = c.get('auth');
    if (auth.type !== 'user') return c.json({ error: 'guest_not_allowed' }, 403);
    const { nightDate } = c.req.valid('json');
    const squad = await recordSleepSquadCheckIn(auth.sub, nightDate);
    return c.json({ ok: Boolean(squad), squad });
  },
);

socialRoutes.post('/squad/claim', async (c) => {
  const auth = c.get('auth');
  if (auth.type !== 'user') return c.json({ error: 'guest_not_allowed' }, 403);
  const result = await claimSleepSquadReward(auth.sub);
  return c.json(result, result.ok ? 200 : 400);
});

/* ================================================================
   Dream Bottles
   ================================================================ */

socialRoutes.use('/bottles/*', requireAuth);

socialRoutes.post(
  '/bottles',
  zValidator(
    'json',
    z.object({
      content: z.string().min(1).max(2000),
      moodTags: z.array(z.string().max(20)).optional(),
      bottleType: z.enum(['random', 'directed']),
      recipientId: z.string().uuid().optional(),
    }),
  ),
  async (c) => {
    const auth = c.get('auth');
    if (auth.type !== 'user') return c.json({ error: 'guest_not_allowed' }, 403);
    const body = c.req.valid('json');

    if (body.bottleType === 'directed' && !body.recipientId) {
      return c.json({ error: 'recipient_required_for_directed' }, 400);
    }

    const bottle = await createBottle({
      senderId: auth.sub,
      content: body.content,
      moodTags: body.moodTags,
      bottleType: body.bottleType,
      recipientId: body.recipientId,
    });

    // Energy reward
    try {
      await completeTask(auth.sub, 'send_bottle');
    } catch {
      // ignore energy errors
    }

    return c.json({ ok: true, bottle }, 201);
  },
);

socialRoutes.get('/bottles/random', async (c) => {
  const auth = c.get('auth');
  if (auth.type !== 'user') return c.json({ error: 'guest_not_allowed' }, 403);
  const bottle = await pickRandomBottle(auth.sub);
  if (!bottle) return c.json({ ok: false, message: 'no_bottles_available' }, 404);

  // Energy reward
  try {
    await completeTask(auth.sub, 'pick_bottle');
  } catch {
    // ignore
  }

  return c.json({ ok: true, bottle });
});

socialRoutes.post(
  '/bottles/:id/reply',
  zValidator('json', z.object({ content: z.string().min(1).max(2000) })),
  async (c) => {
    const auth = c.get('auth');
    if (auth.type !== 'user') return c.json({ error: 'guest_not_allowed' }, 403);
    const bottleId = c.req.param('id');
    const { content } = c.req.valid('json');

    const bottle = await getBottleById(bottleId);
    if (!bottle) return c.json({ error: 'bottle_not_found' }, 404);

    const reply = await replyToBottle(bottleId, auth.sub, content);

    // Notify sender via push queue
    await enqueueJob('push_notify', {
      userId: bottle.sender_id,
      title: '有人回信了',
      body: '你投递的梦境瓶收到了回信，去看看吧',
      data: { type: 'bottle_reply', bottleId },
    });

    // Energy reward
    try {
      await completeTask(auth.sub, 'reply_bottle');
    } catch {
      // ignore
    }

    return c.json({ ok: true, reply });
  },
);

socialRoutes.get('/bottles/:id/replies', async (c) => {
  const auth = c.get('auth');
  if (auth.type !== 'user') return c.json({ error: 'guest_not_allowed' }, 403);
  const bottleId = c.req.param('id');
  const replies = await listBottleReplies(bottleId);
  return c.json({ replies });
});

socialRoutes.get('/bottles/sent', async (c) => {
  const auth = c.get('auth');
  if (auth.type !== 'user') return c.json({ error: 'guest_not_allowed' }, 403);
  const bottles = await listSentBottles(auth.sub);
  return c.json({ bottles });
});

socialRoutes.get('/bottles/received', async (c) => {
  const auth = c.get('auth');
  if (auth.type !== 'user') return c.json({ error: 'guest_not_allowed' }, 403);
  const bottles = await listReceivedBottles(auth.sub);
  return c.json({ bottles });
});

socialRoutes.get('/bottles/:id', async (c) => {
  const auth = c.get('auth');
  if (auth.type !== 'user') return c.json({ error: 'guest_not_allowed' }, 403);
  const bottleId = c.req.param('id');
  const bottle = await getBottleById(bottleId);
  if (!bottle) return c.json({ error: 'bottle_not_found' }, 404);
  // Only sender or picker can view
  if (bottle.sender_id !== auth.sub && bottle.picked_by !== auth.sub) {
    return c.json({ error: 'forbidden' }, 403);
  }
  return c.json({ bottle });
});

socialRoutes.post('/bottles/:id/read', async (c) => {
  const auth = c.get('auth');
  if (auth.type !== 'user') return c.json({ error: 'guest_not_allowed' }, 403);
  const bottleId = c.req.param('id');
  const bottle = await getBottleById(bottleId);
  if (!bottle) return c.json({ error: 'bottle_not_found' }, 404);
  // Mark as read
  await query(
    `INSERT INTO bottle_reads (user_id, bottle_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [auth.sub, bottleId],
  );
  return c.json({ ok: true });
});

/* ================================================================
   Feed
   ================================================================ */

socialRoutes.use('/uploads/*', requireAuth);

socialRoutes.post('/uploads/images', async (c) => {
  const auth = c.get('auth');
  if (auth.type !== 'user') return c.json({ error: 'guest_not_allowed' }, 403);

  let form: FormData;
  try {
    form = await c.req.formData();
  } catch {
    return c.json({ error: 'bad_form', message: '请上传图片文件' }, 400);
  }

  const file = form.get('file');
  if (!file || typeof file === 'string') {
    return c.json({ error: 'no_file', message: '请上传图片文件' }, 400);
  }

  const saved = await saveUploadedImage(file, 'social');
  if ('error' in saved) {
    return c.json({ error: saved.error, message: saved.message }, saved.status as 400);
  }

  return c.json(saved);
});

socialRoutes.use('/feed/*', requireAuth);

socialRoutes.post(
  '/feed',
  zValidator(
    'json',
    z.object({
      type: z.enum(['milestone', 'dream_share', 'check_in', 'achievement']),
      content: z.record(z.unknown()).refine(
        (value) => JSON.stringify(value).length <= 20_000,
        'content_too_large',
      ),
    }),
  ),
  async (c) => {
    const auth = c.get('auth');
    if (auth.type !== 'user') return c.json({ error: 'guest_not_allowed' }, 403);
    const body = c.req.valid('json');
    const post = await createPost({
      userId: auth.sub,
      type: body.type,
      contentJson: body.content,
    });
    try {
      await completeTask(auth.sub, 'post_feed');
    } catch {
      // ignore energy errors
    }
    return c.json({ ok: true, post }, 201);
  },
);

socialRoutes.get(
  '/feed',
  zValidator(
    'query',
    z.object({
      cursor: z.string().max(512).optional(),
      limit: z.coerce.number().int().min(1).max(50).default(20),
    }),
  ),
  async (c) => {
    const auth = c.get('auth');
    if (auth.type !== 'user') return c.json({ error: 'guest_not_allowed' }, 403);
    const { cursor, limit } = c.req.valid('query');
    const posts = await listFeed(cursor, limit, auth.sub);
    const nextCursor = posts.length === limit && posts[posts.length - 1]
      ? encodeFeedCursor(posts[posts.length - 1] as { created_at: Date | string; id: string })
      : null;
    // Keep nextCursor for the current RN adapter while exposing snake_case.
    return c.json({ posts, next_cursor: nextCursor, nextCursor });
  },
);

socialRoutes.post('/feed/:id/like', async (c) => {
  const auth = c.get('auth');
  if (auth.type !== 'user') return c.json({ error: 'guest_not_allowed' }, 403);
  const postId = c.req.param('id');
  const result = await toggleLike(auth.sub, postId);

  if (result.liked) {
    // Notify post author (optimized: direct lookup instead of full table scan)
    const post = await getPostById(postId);
    if (post && post.user_id !== auth.sub) {
      await enqueueJob('push_notify', {
        userId: post.user_id,
        title: '有人点赞了你的动态',
        body: '你的睡眠动态收获了一个赞',
        data: { type: 'feed_like', postId },
      });
      // Also enqueue feed_notify for followers (placeholder)
      await enqueueJob('feed_notify', { postId, authorId: post.user_id, likerId: auth.sub });
    }
    try {
      await completeTask(auth.sub, 'like_feed');
    } catch {
      // ignore energy errors
    }
  }

  return c.json({ ok: true, liked: result.liked });
});

socialRoutes.get(
  '/feed/:id/comments',
  zValidator('param', z.object({ id: z.string().uuid() })),
  zValidator(
    'query',
    z.object({ limit: z.coerce.number().int().min(1).max(100).default(50) }),
  ),
  async (c) => {
    const auth = c.get('auth');
    if (auth.type !== 'user') return c.json({ error: 'guest_not_allowed' }, 403);
    const { id } = c.req.valid('param');
    if (!(await getPostById(id))) return c.json({ error: 'post_not_found' }, 404);
    const { limit } = c.req.valid('query');
    return c.json({ comments: await listFeedComments(id, limit) });
  },
);

socialRoutes.post(
  '/feed/:id/comments',
  zValidator('param', z.object({ id: z.string().uuid() })),
  zValidator('json', z.object({ content: z.string().trim().min(1).max(500) })),
  async (c) => {
    const auth = c.get('auth');
    if (auth.type !== 'user') return c.json({ error: 'guest_not_allowed' }, 403);
    const comment = await createFeedComment(
      auth.sub,
      c.req.valid('param').id,
      c.req.valid('json').content,
    );
    if (!comment) return c.json({ error: 'post_not_found' }, 404);
    return c.json({ ok: true, comment }, 201);
  },
);

socialRoutes.post(
  '/feed/users/:id/follow',
  zValidator('param', z.object({ id: z.string().uuid() })),
  async (c) => {
    const auth = c.get('auth');
    if (auth.type !== 'user') return c.json({ error: 'guest_not_allowed' }, 403);
    try {
      const result = await toggleFollow(auth.sub, c.req.valid('param').id);
      if (!result) return c.json({ error: 'user_not_found' }, 404);
      return c.json({ ok: true, followed: result.followed });
    } catch (error) {
      if (error instanceof Error && error.message === 'cannot_follow_self') {
        return c.json({ error: 'cannot_follow_self' }, 400);
      }
      throw error;
    }
  },
);

socialRoutes.post(
  '/feed/:id/tips',
  zValidator('param', z.object({ id: z.string().uuid() })),
  zValidator(
    'json',
    z.object({
      amount: z.number().int().positive().max(1_000_000),
      idempotency_key: z.string().trim().min(1).max(128),
    }),
  ),
  async (c) => {
    const auth = c.get('auth');
    if (auth.type !== 'user') return c.json({ error: 'guest_not_allowed' }, 403);
    const body = c.req.valid('json');
    try {
      const result = await tipPost({
        senderId: auth.sub,
        postId: c.req.valid('param').id,
        amount: body.amount,
        idempotencyKey: body.idempotency_key,
      });
      return c.json({
        ok: true,
        tip: result.tip,
        balance: result.balance,
        duplicate: result.duplicate,
      }, result.duplicate ? 200 : 201);
    } catch (error) {
      if (!(error instanceof FeedTipError)) throw error;
      if (error.code === 'post_not_found') return c.json({ error: error.code }, 404);
      if (error.code === 'insufficient_energy') return c.json({ error: error.code }, 409);
      if (error.code === 'idempotency_conflict') return c.json({ error: error.code }, 409);
      return c.json({ error: error.code }, 400);
    }
  },
);

socialRoutes.post(
  '/feed/:id/reports',
  zValidator('param', z.object({ id: z.string().uuid() })),
  zValidator(
    'json',
    z.object({
      reason: z.string().trim().min(1).max(64),
      details: z.string().trim().max(1000).optional(),
    }),
  ),
  async (c) => {
    const auth = c.get('auth');
    if (auth.type !== 'user') return c.json({ error: 'guest_not_allowed' }, 403);
    const body = c.req.valid('json');
    const result = await reportPost({
      reporterId: auth.sub,
      postId: c.req.valid('param').id,
      reason: body.reason,
      details: body.details || undefined,
    });
    if (!result) return c.json({ error: 'post_not_found' }, 404);
    return c.json({
      ok: true,
      report: result.report,
      duplicate: result.duplicate,
    }, result.duplicate ? 200 : 201);
  },
);
