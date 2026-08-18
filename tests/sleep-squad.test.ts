import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = mkdtempSync(join(tmpdir(), 'sleep-api-squad-'));
process.env.USE_PGLITE = '1';
process.env.PGLITE_DATA_DIR = dataDir;

let closeDb: typeof import('../src/db/client.js').closeDb;
let query: typeof import('../src/db/client.js').query;
let squad: typeof import('../src/services/sleepSquad.js');
let ensureEnergyAccount: typeof import('../src/services/energy.js').ensureEnergyAccount;

const U1 = '00000000-0000-4000-8000-000000000011';
const U2 = '00000000-0000-4000-8000-000000000012';
const U3 = '00000000-0000-4000-8000-000000000013';

before(async () => {
  ({ closeDb, query } = await import('../src/db/client.js'));
  squad = await import('../src/services/sleepSquad.js');
  ({ ensureEnergyAccount } = await import('../src/services/energy.js'));

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
    `CREATE TABLE user_follows (
      follower_id UUID NOT NULL REFERENCES users(id),
      followed_id UUID NOT NULL REFERENCES users(id),
      PRIMARY KEY (follower_id, followed_id)
    )`,
    `CREATE TABLE sleep_squads (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      sleep_type TEXT NOT NULL,
      main_concern TEXT,
      week_key DATE NOT NULL,
      squad_no INT NOT NULL DEFAULT 1,
      max_members INT NOT NULL DEFAULT 50,
      target_nights INT NOT NULL DEFAULT 10,
      target_count INT NOT NULL DEFAULT 120,
      pool_reward_se INT NOT NULL DEFAULT 500,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE UNIQUE INDEX sleep_squads_type_week_no ON sleep_squads (sleep_type, week_key, squad_no)`,
    `CREATE TABLE sleep_squad_members (
      squad_id UUID NOT NULL REFERENCES sleep_squads(id) ON DELETE CASCADE,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      left_at TIMESTAMPTZ,
      PRIMARY KEY (squad_id, user_id)
    )`,
    `CREATE TABLE sleep_squad_contributions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      squad_id UUID NOT NULL REFERENCES sleep_squads(id) ON DELETE CASCADE,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ('last_night', 'feed')),
      occurred_on DATE NOT NULL,
      source_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (squad_id, user_id, kind, occurred_on)
    )`,
    `CREATE TABLE sleep_squad_rewards (
      squad_id UUID NOT NULL REFERENCES sleep_squads(id) ON DELETE CASCADE,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      week_key DATE NOT NULL,
      claimed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      claimed_se INT NOT NULL DEFAULT 0,
      PRIMARY KEY (squad_id, user_id, week_key)
    )`,
    `CREATE TABLE energy_accounts (
      user_id UUID PRIMARY KEY REFERENCES users(id),
      balance INT NOT NULL DEFAULT 500,
      total_earned INT NOT NULL DEFAULT 500,
      total_spent INT NOT NULL DEFAULT 0,
      streak_days INT NOT NULL DEFAULT 0,
      max_streak_days INT NOT NULL DEFAULT 0,
      daily_earned INT NOT NULL DEFAULT 0,
      daily_cap INT NOT NULL DEFAULT 200,
      daily_earned_date DATE NOT NULL DEFAULT CURRENT_DATE,
      last_check_in DATE,
      version INT NOT NULL DEFAULT 1,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE TABLE energy_transactions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id),
      type TEXT NOT NULL,
      amount INT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      source_id TEXT,
      related_user_id UUID,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE UNIQUE INDEX idx_energy_transactions_user_source
     ON energy_transactions (user_id, source_id) WHERE source_id IS NOT NULL`,
  ];
  for (const statement of statements) await query(statement);

  await query(
    `INSERT INTO users (id, username) VALUES ($1, 'u1'), ($2, 'u2'), ($3, 'u3')`,
    [U1, U2, U3],
  );
  await query(
    `INSERT INTO user_profiles (user_id, nickname) VALUES ($1, '浅浅'), ($2, '稳稳'), ($3, '早早')`,
    [U1, U2, U3],
  );
  await ensureEnergyAccount(U1);
  await ensureEnergyAccount(U2);
});

after(async () => {
  await closeDb();
  rmSync(dataDir, { recursive: true, force: true });
});

test('最大余数法总和等于奖池且 0 次为 0', () => {
  const shares = squad.allocateLargestRemainder(500, [10, 5, 3, 0]);
  assert.equal(shares.reduce((a, b) => a + b, 0), 500);
  assert.equal(shares[3], 0);
  assert.deepEqual(squad.allocateLargestRemainder(500, [0, 0]), [0, 0]);
});

test('同类型随机入队；退出后本周不能再加入', async () => {
  const a = await squad.joinSleepSquad({ userId: U1, sleepType: '浅睡易醒型' });
  assert.ok(a);
  assert.equal(a!.squadNo, 1);
  assert.equal(a!.maxMembers, 50);
  assert.equal(a!.targetCount, 120);
  assert.equal(a!.poolRewardSe, 500);
  assert.match(a!.label, /第 1 分队/);

  const b = await squad.joinSleepSquad({ userId: U2, sleepType: '浅睡易醒型' });
  assert.equal(b!.id, a!.id);
  assert.equal(b!.memberCount, 2);

  await squad.leaveCurrentSleepSquad(U1);
  await assert.rejects(
    () => squad.joinSleepSquad({ userId: U1, sleepType: '浅睡易醒型' }),
    (err: unknown) => err instanceof squad.SleepSquadError && err.code === 'already_played_this_week',
  );

  const afterLeave = await squad.getCurrentSleepSquad(U2);
  assert.equal(afterLeave!.memberCount, 1);
});

test('分享昨夜与发动态分别计次，空帖不计，同日最多 2', async () => {
  const s = await squad.joinSleepSquad({ userId: U2, sleepType: '浅睡易醒型' });
  await squad.recordSleepSquadCheckIn(U2, '2026-08-17');
  await squad.recordSleepSquadCheckIn(U2, '2026-08-17');
  await squad.recordSleepSquadContributionFromPost(U2, 'milestone', { text: '好' });
  await squad.recordSleepSquadContributionFromPost(U2, 'milestone', { text: '今晚睡得还不错' });
  await squad.recordSleepSquadContributionFromPost(U2, 'milestone', { text: '再发一条也不会再计' });
  await squad.recordSleepSquadContributionFromPost(
    U2,
    'check_in',
    { text: '昨夜故事', nightDate: '2026-08-16', sleepScore: 82 },
  );

  const dto = await squad.getCurrentSleepSquad(U2);
  assert.equal(dto!.id, s!.id);
  assert.equal(dto!.myLastNightCount, 2);
  assert.equal(dto!.myFeedCount, 1);
  assert.equal(dto!.myCount, 3);
  assert.equal(dto!.settled, false);
  assert.equal(dto!.canClaim, false);
  assert.equal(dto!.estimatedSe, 0);
});

test('上周达标后按贡献分成，且不受日上限截断', async () => {
  const pastWeek = '2020-01-06';
  const created = await query<{ id: string }>(
    `INSERT INTO sleep_squads (sleep_type, week_key, squad_no, target_count, pool_reward_se)
     VALUES ('深睡稳定型', $1::date, 1, 120, 500)
     RETURNING id`,
    [pastWeek],
  );
  const squadId = created.rows[0]!.id;
  await query(
    `INSERT INTO sleep_squad_members (squad_id, user_id) VALUES ($1, $2), ($1, $3)`,
    [squadId, U1, U2],
  );
  await query(
    `INSERT INTO sleep_squad_contributions (squad_id, user_id, kind, occurred_on)
     SELECT $1, $2, 'feed', DATE '2020-01-01' + g FROM generate_series(0, 79) g`,
    [squadId, U1],
  );
  await query(
    `INSERT INTO sleep_squad_contributions (squad_id, user_id, kind, occurred_on)
     SELECT $1, $2, 'feed', DATE '2020-01-01' + g FROM generate_series(0, 39) g`,
    [squadId, U2],
  );

  const before = await ensureEnergyAccount(U1);
  const claim = await squad.claimSleepSquadReward(U1);
  assert.equal(claim.ok, true);
  assert.equal(claim.rewardSe, 333);
  const after = await ensureEnergyAccount(U1);
  assert.equal(after.balance, before.balance + 333);

  const claim2 = await squad.claimSleepSquadReward(U2);
  assert.equal(claim2.ok, true);
  assert.equal(claim2.rewardSe, 167);
});
