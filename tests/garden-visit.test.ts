/**
 * 双账号访园联调（PGlite）：好友可见 → 上传溢出 → 采露入账 → 日上限
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { shanghaiToday } from '../src/utils/civilDate.js';

const dataDir = mkdtempSync(join(tmpdir(), 'sleep-api-garden-'));
process.env.USE_PGLITE = '1';
process.env.PGLITE_DATA_DIR = dataDir;

let closeDb: typeof import('../src/db/client.js').closeDb;
let query: typeof import('../src/db/client.js').query;
let garden: typeof import('../src/services/garden.js');
let ensureEnergyAccount: typeof import('../src/services/energy.js').ensureEnergyAccount;

const USER_A = '00000000-0000-4000-8000-0000000000a1';
const USER_B = '00000000-0000-4000-8000-0000000000b2';
const STRANGER = '00000000-0000-4000-8000-0000000000c3';

before(async () => {
  ({ closeDb, query } = await import('../src/db/client.js'));
  garden = await import('../src/services/garden.js');
  ({ ensureEnergyAccount } = await import('../src/services/energy.js'));

  const statements = [
    `CREATE TABLE users (
      id UUID PRIMARY KEY, username TEXT NOT NULL, password_hash TEXT NOT NULL DEFAULT 'x',
      deleted_at TIMESTAMPTZ
    )`,
    `CREATE TABLE user_profiles (
      user_id UUID PRIMARY KEY REFERENCES users(id), nickname TEXT, avatar_url TEXT
    )`,
    `CREATE TABLE friendships (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id),
      friend_id UUID NOT NULL REFERENCES users(id),
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (user_id, friend_id)
    )`,
    `CREATE TABLE sleep_squads (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      week_key DATE NOT NULL,
      invite_code TEXT
    )`,
    `CREATE TABLE sleep_squad_members (
      squad_id UUID NOT NULL REFERENCES sleep_squads(id),
      user_id UUID NOT NULL REFERENCES users(id),
      left_at TIMESTAMPTZ,
      PRIMARY KEY (squad_id, user_id)
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
    `CREATE TABLE user_gardens (
      user_id UUID PRIMARY KEY REFERENCES users(id),
      plants_json JSONB NOT NULL DEFAULT '[]',
      overflow_dew INT NOT NULL DEFAULT 0,
      overflow_dew_day DATE,
      plot_count INT NOT NULL DEFAULT 0,
      pests_json JSONB NOT NULL DEFAULT '[]',
      pest_spawn_day DATE,
      nourish_kind TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE TABLE garden_help_daily (
      owner_id UUID NOT NULL REFERENCES users(id),
      visitor_id UUID NOT NULL REFERENCES users(id),
      day DATE NOT NULL,
      smash_count INT NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (owner_id, visitor_id, day)
    )`,
    `CREATE TABLE garden_visit_daily (
      visitor_id UUID NOT NULL REFERENCES users(id),
      day DATE NOT NULL,
      visit_count INT NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (visitor_id, day)
    )`,
    `CREATE TABLE garden_dew_claims (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      visitor_id UUID NOT NULL REFERENCES users(id),
      owner_id UUID NOT NULL REFERENCES users(id),
      day DATE NOT NULL,
      claim_seq INT NOT NULL,
      earned_se INT NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (visitor_id, owner_id, day, claim_seq)
    )`,
  ];
  for (const statement of statements) await query(statement);

  await query(
    `INSERT INTO users (id, username) VALUES ($1, 'alice'), ($2, 'bob'), ($3, 'carol')`,
    [USER_A, USER_B, STRANGER],
  );
  await query(
    `INSERT INTO user_profiles (user_id, nickname)
     VALUES ($1, '园主A'), ($2, '访客B'), ($3, '路人C')`,
    [USER_A, USER_B, STRANGER],
  );
  // 双向 accepted 好友
  await query(
    `INSERT INTO friendships (user_id, friend_id, status)
     VALUES ($1, $2, 'accepted'), ($2, $1, 'accepted')`,
    [USER_A, USER_B],
  );

  await ensureEnergyAccount(USER_A);
  await ensureEnergyAccount(USER_B);
});

after(async () => {
  await closeDb();
  rmSync(dataDir, { recursive: true, force: true });
});

test('A uploads overflow; B sees peer and claims SE+2; overflow decrements', async () => {
  const today = shanghaiToday();
  const snap = await garden.upsertUserGarden(USER_A, {
    plants: [{ plotIndex: 0, seedId: 'moon_lily' }],
    overflowDew: 3,
    overflowDewDay: today,
  });
  assert.equal(snap.overflowDew, 3);

  const peers = await garden.listGardenPeers(USER_B);
  assert.equal(peers.length, 1);
  assert.equal(peers[0]?.id, USER_A);
  assert.equal(peers[0]?.overflowLeft, 3);

  const before = await ensureEnergyAccount(USER_B);
  const claim = await garden.claimGardenOverflowDew(USER_B, USER_A);
  assert.equal(claim.earned, garden.GARDEN_DEW_VISIT_SE);
  assert.equal(claim.overflowLeft, 2);
  assert.equal(claim.visits, 1);

  const after = await ensureEnergyAccount(USER_B);
  assert.equal(after.balance, before.balance + garden.GARDEN_DEW_VISIT_SE);

  const owner = await garden.getUserGarden(USER_A);
  assert.equal(owner?.overflowDew, 2);
});

test('stranger cannot visit; self-claim rejected', async () => {
  await assert.rejects(
    () => garden.claimGardenOverflowDew(STRANGER, USER_A),
    (err: unknown) => err instanceof garden.GardenClaimError && err.code === 'not_visitable',
  );
  await assert.rejects(
    () => garden.claimGardenOverflowDew(USER_A, USER_A),
    (err: unknown) => err instanceof garden.GardenClaimError && err.code === 'cannot_visit_self',
  );
});

test('daily visit cap locks after 5 claims', async () => {
  const today = shanghaiToday();
  // 重置 A 溢出，保证够采
  await garden.upsertUserGarden(USER_A, {
    plants: [{ plotIndex: 0, seedId: 'moon_lily' }],
    overflowDew: 3,
    overflowDewDay: today,
  });
  // B 已有 1 次访采；再采 4 次到上限（溢出不够时刷新）
  for (let i = 0; i < 4; i++) {
    const g = await garden.getUserGarden(USER_A);
    if (!g || g.overflowDew <= 0) {
      await garden.upsertUserGarden(USER_A, {
        plants: [{ plotIndex: 0, seedId: 'moon_lily' }],
        overflowDew: 3,
        overflowDewDay: today,
      });
    }
    const r = await garden.claimGardenOverflowDew(USER_B, USER_A);
    assert.equal(r.earned, garden.GARDEN_DEW_VISIT_SE);
    assert.equal(r.visits, i + 2);
  }

  const progress = await garden.getVisitProgress(USER_B);
  assert.equal(progress.visits, garden.GARDEN_DEW_VISIT_DAILY_MAX);
  assert.equal(progress.remaining, 0);

  await garden.upsertUserGarden(USER_A, {
    plants: [{ plotIndex: 0, seedId: 'moon_lily' }],
    overflowDew: 3,
    overflowDewDay: today,
  });
  await assert.rejects(
    () => garden.claimGardenOverflowDew(USER_B, USER_A),
    (err: unknown) => err instanceof garden.GardenClaimError && err.code === 'daily_capped',
  );
});

function samplePest(id: string, slot: number) {
  return {
    id,
    plotIndex: 0,
    slot,
    monsterId: 'ddl',
    spawnedDay: shanghaiToday(),
  };
}

test('A uploads pests; B sees pestLeft and smashes SE+3; help recorded', async () => {
  const today = shanghaiToday();
  await query('DELETE FROM garden_visit_daily WHERE visitor_id = $1', [USER_B]);
  await query('DELETE FROM garden_dew_claims WHERE visitor_id = $1', [USER_B]);
  await query('DELETE FROM garden_help_daily');

  const snap = await garden.upsertUserGarden(USER_A, {
    plants: [{ plotIndex: 0, seedId: 'moon_lily' }],
    overflowDew: 0,
    overflowDewDay: today,
    pests: [samplePest('pest_a', 0), samplePest('pest_b', 1), samplePest('pest_c', 2)],
    pestSpawnDay: today,
    nourishKind: 'hurt',
    pestsReplace: true,
  });
  assert.equal(snap.pestLeft, 3);
  assert.equal(snap.pests[0]?.id, 'pest_a');

  const peers = await garden.listGardenPeers(USER_B);
  assert.equal(peers[0]?.pestLeft, 3);

  const before = await ensureEnergyAccount(USER_B);
  const smash = await garden.smashGardenPest(USER_B, USER_A, 'pest_a');
  assert.equal(smash.earned, garden.GARDEN_PEST_SMASH_SE);
  assert.equal(smash.pestLeft, 2);
  assert.equal(smash.ownSmash, false);
  assert.equal(smash.visits, 1);

  const after = await ensureEnergyAccount(USER_B);
  assert.equal(after.balance, before.balance + garden.GARDEN_PEST_SMASH_SE);

  const owner = await garden.getUserGarden(USER_A);
  assert.equal(owner?.pestLeft, 2);
  assert.equal(owner?.pests.some((p) => p.id === 'pest_a'), false);

  const helpers = await garden.listGardenHelpToday(USER_A);
  assert.equal(helpers.length, 1);
  assert.equal(helpers[0]?.peerId, USER_B);
  assert.equal(helpers[0]?.count, 1);
  assert.equal(helpers[0]?.alias, '访客B');
});

test('same-day upsert does not restore smashed pests', async () => {
  const today = shanghaiToday();
  const restored = await garden.upsertUserGarden(USER_A, {
    plants: [{ plotIndex: 0, seedId: 'moon_lily' }],
    overflowDew: 0,
    overflowDewDay: today,
    pests: [samplePest('pest_a', 0), samplePest('pest_b', 1), samplePest('pest_c', 2)],
    pestSpawnDay: today,
  });
  assert.equal(restored.pestLeft, 2);
  assert.equal(restored.pests.some((p) => p.id === 'pest_a'), false);
});

test('owner smash removes pest without SE or visit count', async () => {
  const beforeVisits = await garden.getVisitProgress(USER_A);
  const beforeEnergy = await ensureEnergyAccount(USER_A);
  const smash = await garden.smashGardenPest(USER_A, USER_A, 'pest_b');
  assert.equal(smash.earned, 0);
  assert.equal(smash.ownSmash, true);
  assert.equal(smash.pestLeft, 1);
  const afterVisits = await garden.getVisitProgress(USER_A);
  assert.equal(afterVisits.visits, beforeVisits.visits);
  const afterEnergy = await ensureEnergyAccount(USER_A);
  assert.equal(afterEnergy.balance, beforeEnergy.balance);
});

test('stranger cannot smash; missing pest rejected', async () => {
  await assert.rejects(
    () => garden.smashGardenPest(STRANGER, USER_A, 'pest_c'),
    (err: unknown) => err instanceof garden.GardenClaimError && err.code === 'not_visitable',
  );
  await assert.rejects(
    () => garden.smashGardenPest(USER_B, USER_A, 'no_such_pest'),
    (err: unknown) => err instanceof garden.GardenClaimError && err.code === 'no_pest',
  );
});

test('smash hits the same daily visit cap of 5', async () => {
  const today = shanghaiToday();
  await query('DELETE FROM garden_visit_daily WHERE visitor_id = $1', [USER_B]);
  await query('DELETE FROM garden_dew_claims WHERE visitor_id = $1', [USER_B]);
  const pests = [0, 1, 2, 3, 4, 5].map((slot) => samplePest(`cap_${slot}`, slot));
  await garden.upsertUserGarden(USER_A, {
    plants: [{ plotIndex: 0, seedId: 'moon_lily' }, { plotIndex: 1, seedId: 'moon_lily' }],
    overflowDew: 0,
    overflowDewDay: today,
    pests,
    pestSpawnDay: today,
    pestsReplace: true,
  });
  for (let i = 0; i < garden.GARDEN_DEW_VISIT_DAILY_MAX; i++) {
    const r = await garden.smashGardenPest(USER_B, USER_A, `cap_${i}`);
    assert.equal(r.earned, garden.GARDEN_PEST_SMASH_SE);
    assert.equal(r.visits, i + 1);
  }
  await assert.rejects(
    () => garden.smashGardenPest(USER_B, USER_A, 'cap_5'),
    (err: unknown) => err instanceof garden.GardenClaimError && err.code === 'daily_capped',
  );
  const left = await garden.getUserGarden(USER_A);
  assert.equal(left?.pests.some((p) => p.id === 'cap_5'), true);
});
