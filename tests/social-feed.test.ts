import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = mkdtempSync(join(tmpdir(), 'sleep-api-social-'));
process.env.USE_PGLITE = '1';
process.env.PGLITE_DATA_DIR = dataDir;

let closeDb: typeof import('../src/db/client.js').closeDb;
let query: typeof import('../src/db/client.js').query;
let social: typeof import('../src/services/social.js');

const VIEWER = '00000000-0000-4000-8000-000000000001';
const AUTHOR = '00000000-0000-4000-8000-000000000002';
const POST_A = '10000000-0000-4000-8000-000000000001';
const POST_B = '10000000-0000-4000-8000-000000000002';

before(async () => {
  ({ closeDb, query } = await import('../src/db/client.js'));
  social = await import('../src/services/social.js');

  const statements = [
    `CREATE TABLE users (
      id UUID PRIMARY KEY, username TEXT NOT NULL, deleted_at TIMESTAMPTZ
    )`,
    `CREATE TABLE user_profiles (
      user_id UUID PRIMARY KEY REFERENCES users(id), nickname TEXT, avatar_url TEXT
    )`,
    `CREATE TABLE data_blobs (
      owner_type TEXT NOT NULL, owner_id UUID NOT NULL, domain TEXT NOT NULL,
      data JSONB NOT NULL, PRIMARY KEY (owner_type, owner_id, domain)
    )`,
    `CREATE TABLE feed_posts (
      id UUID PRIMARY KEY, user_id UUID NOT NULL REFERENCES users(id), type TEXT NOT NULL,
      content_json JSONB NOT NULL, like_count INT NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL
    )`,
    `CREATE TABLE feed_likes (
      user_id UUID NOT NULL REFERENCES users(id), post_id UUID NOT NULL REFERENCES feed_posts(id),
      PRIMARY KEY (user_id, post_id)
    )`,
    `CREATE TABLE feed_comments (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(), post_id UUID NOT NULL REFERENCES feed_posts(id),
      user_id UUID NOT NULL REFERENCES users(id), content TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE TABLE user_follows (
      follower_id UUID NOT NULL REFERENCES users(id), followed_id UUID NOT NULL REFERENCES users(id),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY (follower_id, followed_id)
    )`,
    `CREATE TABLE feed_tips (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(), post_id UUID NOT NULL REFERENCES feed_posts(id),
      sender_id UUID NOT NULL REFERENCES users(id), recipient_id UUID NOT NULL REFERENCES users(id),
      amount INT NOT NULL, idempotency_key TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (sender_id, idempotency_key)
    )`,
    `CREATE TABLE feed_reports (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(), post_id UUID NOT NULL REFERENCES feed_posts(id),
      reporter_id UUID NOT NULL REFERENCES users(id), reason TEXT NOT NULL, details TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE (post_id, reporter_id)
    )`,
  ];
  for (const statement of statements) await query(statement);

  await query(
    `INSERT INTO users (id, username) VALUES ($1, 'viewer'), ($2, 'author')`,
    [VIEWER, AUTHOR],
  );
  await query(
    `INSERT INTO user_profiles (user_id, nickname, avatar_url)
     VALUES ($1, '星河作者', 'https://example.test/avatar.png')`,
    [AUTHOR],
  );
  await query(
    `INSERT INTO data_blobs (owner_type, owner_id, domain, data)
     VALUES ('user', $1, 'persona', '{"sleepType":"浅睡易醒型"}')`,
    [AUTHOR],
  );
  await query(
    `INSERT INTO feed_posts (id, user_id, type, content_json, created_at)
     VALUES
       ($1, $3, 'milestone', '{}', '2026-07-23T01:00:00Z'),
       ($2, $3, 'milestone', '{}', '2026-07-23T01:00:00Z')`,
    [POST_A, POST_B, AUTHOR],
  );
});

after(async () => {
  await closeDb();
  rmSync(dataDir, { recursive: true, force: true });
});

test('cursor round-trips and accepts legacy timestamp', () => {
  const encoded = social.encodeFeedCursor({
    created_at: '2026-07-23T01:00:00.000Z',
    id: POST_B,
  });
  assert.deepEqual(social.decodeFeedCursor(encoded), {
    created_at: '2026-07-23T01:00:00.000Z',
    id: POST_B,
  });
  assert.deepEqual(social.decodeFeedCursor('2026-07-23T01:00:00.000Z'), {
    created_at: '2026-07-23T01:00:00.000Z',
  });
  assert.equal(social.decodeFeedCursor('not-a-cursor'), null);
});

test('feed uses id tie-break and returns social aggregates', async () => {
  await social.toggleFollow(VIEWER, AUTHOR);
  await social.createFeedComment(VIEWER, POST_B, '晚安');
  await query(
    `INSERT INTO feed_tips (post_id, sender_id, recipient_id, amount, idempotency_key)
     VALUES ($1, $2, $3, 7, 'test-tip')`,
    [POST_B, VIEWER, AUTHOR],
  );

  const first = await social.listFeed(undefined, 1, VIEWER);
  assert.equal(first[0]?.id, POST_B);
  assert.equal(first[0]?.followed_by_me, true);
  assert.equal(first[0]?.comment_count, 1);
  assert.equal(first[0]?.tip_amount, 7);
  assert.equal(first[0]?.author_avatar, 'https://example.test/avatar.png');
  assert.equal(first[0]?.author_sleep_type, '浅睡易醒型');

  const cursor = social.encodeFeedCursor(first[0] as { created_at: Date; id: string });
  const second = await social.listFeed(cursor, 1, VIEWER);
  assert.equal(second[0]?.id, POST_A);
});

test('follow toggles and reports are duplicate-safe', async () => {
  assert.deepEqual(await social.toggleFollow(VIEWER, AUTHOR), { followed: false });
  assert.deepEqual(await social.toggleFollow(VIEWER, AUTHOR), { followed: true });

  const first = await social.reportPost({
    reporterId: VIEWER,
    postId: POST_A,
    reason: 'spam',
    details: 'duplicate content',
  });
  const duplicate = await social.reportPost({
    reporterId: VIEWER,
    postId: POST_A,
    reason: 'other',
  });
  assert.equal(first?.duplicate, false);
  assert.equal(duplicate?.duplicate, true);
  assert.equal(duplicate?.report.reason, 'spam');
});

test('tip service rejects non-positive and non-integer amounts before touching the ledger', async () => {
  for (const amount of [0, -1, 1.5]) {
    await assert.rejects(
      social.tipPost({
        senderId: VIEWER,
        postId: POST_A,
        amount,
        idempotencyKey: `invalid-${amount}`,
      }),
      (error: unknown) => (
        error instanceof Error
        && 'code' in error
        && error.code === 'invalid_amount'
      ),
    );
  }
});
