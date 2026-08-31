/**
 * 深睡花园 · 多人访园（服务端权威）
 */
import { query, pool, withTransaction } from '../db/client.js';
import { claimReward } from './energyLedger.js';
import { weekKey } from './sleepSquad.js';
import { shanghaiToday, toDateOnly } from '../utils/civilDate.js';

export const GARDEN_DEW_PER_HARVEST_DAY = 3;
export const GARDEN_DEW_VISIT_SE = 2;
export const GARDEN_PEST_SMASH_SE = 3;
export const GARDEN_DEW_VISIT_DAILY_MAX = 5;
export const GARDEN_PLOT_MAX = 7;
export const GARDEN_PEST_SLOT_MAX = 6;
export const GARDEN_PEST_MAX = 6;

const NOURISH_KINDS = new Set(['harvest_rich', 'harvest_care', 'holding', 'hurt']);

function todayStr(): string {
  return shanghaiToday();
}

export type GardenPlantJson = Record<string, unknown>;

export interface GardenPestDto {
  id: string;
  plotIndex: number;
  slot: number;
  monsterId: string;
  spawnedDay: string;
}

export type GardenNourishKind = 'harvest_rich' | 'harvest_care' | 'holding' | 'hurt';

export interface GardenSnapshotDto {
  userId: string;
  plants: GardenPlantJson[];
  overflowDew: number;
  overflowDewDay: string | null;
  plotCount: number;
  pests: GardenPestDto[];
  pestSpawnDay: string | null;
  nourishKind: GardenNourishKind | null;
  pestLeft: number;
  updatedAt: string;
}

export interface GardenPeerListItem {
  id: string;
  username: string | null;
  nickname: string | null;
  avatarUrl: string | null;
  overflowLeft: number;
  pestLeft: number;
  plantCount: number;
  updatedAt: string | null;
}

export interface GardenHelpItem {
  peerId: string;
  alias: string;
  count: number;
}

type GardenRow = {
  user_id: string;
  plants_json: unknown;
  overflow_dew: number;
  overflow_dew_day: string | Date | null;
  plot_count: number;
  pests_json?: unknown;
  pest_spawn_day?: string | Date | null;
  nourish_kind?: string | null;
  updated_at: Date | string;
};

export function parseGardenPests(raw: unknown): GardenPestDto[] {
  if (!Array.isArray(raw)) return [];
  const usedSlots = new Set<number>();
  const usedIds = new Set<string>();
  const out: GardenPestDto[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const rec = item as Record<string, unknown>;
    const id = typeof rec.id === 'string' ? rec.id.trim() : '';
    const monsterId = typeof rec.monsterId === 'string' ? rec.monsterId.trim() : '';
    const plotIndex = Number(rec.plotIndex);
    const slot = Number(rec.slot);
    const spawnedDay = typeof rec.spawnedDay === 'string' ? rec.spawnedDay.slice(0, 10) : '';
    if (!id || id.length > 96 || usedIds.has(id)) continue;
    if (!monsterId || monsterId.length > 64) continue;
    if (!Number.isInteger(plotIndex) || plotIndex < 0 || plotIndex >= GARDEN_PLOT_MAX) continue;
    if (!Number.isInteger(slot) || slot < 0 || slot >= GARDEN_PEST_SLOT_MAX || usedSlots.has(slot)) {
      continue;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(spawnedDay)) continue;
    usedIds.add(id);
    usedSlots.add(slot);
    out.push({ id, plotIndex, slot, monsterId, spawnedDay });
    if (out.length >= GARDEN_PEST_MAX) break;
  }
  return out;
}

function parseNourishKind(raw: unknown): GardenNourishKind | null {
  if (typeof raw !== 'string') return null;
  return NOURISH_KINDS.has(raw) ? raw as GardenNourishKind : null;
}

function mapGardenRow(row: GardenRow): GardenSnapshotDto {
  const plants = Array.isArray(row.plants_json) ? row.plants_json as GardenPlantJson[] : [];
  const day = toDateOnly(row.overflow_dew_day);
  const pests = parseGardenPests(row.pests_json);
  const updatedAt = typeof row.updated_at === 'string'
    ? row.updated_at
    : row.updated_at.toISOString();
  return {
    userId: row.user_id,
    plants,
    overflowDew: Number(row.overflow_dew) || 0,
    overflowDewDay: day,
    plotCount: Number(row.plot_count) || plants.length,
    pests,
    pestSpawnDay: toDateOnly(row.pest_spawn_day ?? null),
    nourishKind: parseNourishKind(row.nourish_kind),
    pestLeft: pests.length,
    updatedAt,
  };
}

const GARDEN_RETURNING = `user_id, plants_json, overflow_dew, overflow_dew_day, plot_count,
       pests_json, pest_spawn_day, nourish_kind, updated_at`;

function normalizeOverflowForToday(
  overflowDew: number,
  overflowDewDay: string | null,
  day = todayStr(),
): number {
  if (overflowDewDay !== day) return 0;
  return Math.max(0, overflowDew);
}

function mergePestsOnUpsert(
  existing: { pests: GardenPestDto[]; pestSpawnDay: string | null } | null,
  incoming: GardenPestDto[] | undefined,
  spawnDay: string,
  replace: boolean,
): { pests: GardenPestDto[]; pestSpawnDay: string | null } {
  if (incoming === undefined) {
    return existing ?? { pests: [], pestSpawnDay: null };
  }
  if (
    replace
    || !existing
    || !existing.pestSpawnDay
    || existing.pestSpawnDay !== spawnDay
    || existing.pests.length === 0
  ) {
    return { pests: incoming, pestSpawnDay: spawnDay };
  }
  const clientIds = new Set(incoming.map((p) => p.id));
  return {
    pests: existing.pests.filter((p) => clientIds.has(p.id)),
    pestSpawnDay: existing.pestSpawnDay,
  };
}

export async function upsertUserGarden(
  userId: string,
  input: {
    plants: GardenPlantJson[];
    overflowDew: number;
    overflowDewDay?: string | null;
    pests?: GardenPestDto[];
    pestSpawnDay?: string | null;
    nourishKind?: string | null;
    pestsReplace?: boolean;
  },
): Promise<GardenSnapshotDto> {
  const plants = Array.isArray(input.plants) ? input.plants.slice(0, GARDEN_PLOT_MAX) : [];
  const day = todayStr();
  const overflowDay = input.overflowDewDay?.slice(0, 10) || day;
  let overflow = Math.max(0, Math.floor(Number(input.overflowDew) || 0));
  if (overflowDay !== day) {
    overflow = 0;
  }
  overflow = Math.min(overflow, GARDEN_DEW_PER_HARVEST_DAY);

  const incomingPests = input.pests === undefined ? undefined : parseGardenPests(input.pests);
  const spawnDay = input.pestSpawnDay?.slice(0, 10) || day;
  const nourishKind = parseNourishKind(input.nourishKind);

  const existingResult = await query<{
    pests_json: unknown;
    pest_spawn_day: string | Date | null;
    nourish_kind: string | null;
  }>(
    `SELECT pests_json, pest_spawn_day, nourish_kind FROM user_gardens WHERE user_id = $1`,
    [userId],
  );
  const existingRow = existingResult.rows[0];
  const merged = mergePestsOnUpsert(
    existingRow
      ? {
        pests: parseGardenPests(existingRow.pests_json),
        pestSpawnDay: toDateOnly(existingRow.pest_spawn_day),
      }
      : null,
    incomingPests,
    spawnDay,
    Boolean(input.pestsReplace),
  );
  const storedKind = nourishKind ?? parseNourishKind(existingRow?.nourish_kind);

  const result = await query<GardenRow>(
    `INSERT INTO user_gardens (
       user_id, plants_json, overflow_dew, overflow_dew_day, plot_count,
       pests_json, pest_spawn_day, nourish_kind, updated_at
     )
     VALUES ($1, $2::jsonb, $3, $4::date, $5, $6::jsonb, $7::date, $8, NOW())
     ON CONFLICT (user_id) DO UPDATE SET
       plants_json = EXCLUDED.plants_json,
       overflow_dew = EXCLUDED.overflow_dew,
       overflow_dew_day = EXCLUDED.overflow_dew_day,
       plot_count = EXCLUDED.plot_count,
       pests_json = EXCLUDED.pests_json,
       pest_spawn_day = EXCLUDED.pest_spawn_day,
       nourish_kind = COALESCE(EXCLUDED.nourish_kind, user_gardens.nourish_kind),
       updated_at = NOW()
     RETURNING ${GARDEN_RETURNING}`,
    [
      userId,
      JSON.stringify(plants),
      overflow,
      overflowDay,
      plants.length,
      JSON.stringify(merged.pests),
      merged.pestSpawnDay,
      storedKind,
    ],
  );
  return mapGardenRow(result.rows[0]!);
}

export async function getUserGarden(userId: string): Promise<GardenSnapshotDto | null> {
  const result = await query<GardenRow>(
    `SELECT ${GARDEN_RETURNING}
     FROM user_gardens WHERE user_id = $1`,
    [userId],
  );
  const row = result.rows[0];
  if (!row) return null;
  const dto = mapGardenRow(row);
  return {
    ...dto,
    overflowDew: normalizeOverflowForToday(dto.overflowDew, dto.overflowDewDay),
  };
}

export async function listVisitablePeerIds(userId: string): Promise<string[]> {
  const friends = await query<{ id: string }>(
    `SELECT f.friend_id AS id
     FROM friendships f
     WHERE f.user_id = $1 AND f.status = 'accepted'
     UNION
     SELECT f.user_id AS id
     FROM friendships f
     WHERE f.friend_id = $1 AND f.status = 'accepted'`,
    [userId],
  );

  const squad = await query<{ id: string }>(
    `SELECT m2.user_id AS id
     FROM sleep_squad_members m
     JOIN sleep_squads s ON s.id = m.squad_id
     JOIN sleep_squad_members m2 ON m2.squad_id = s.id AND m2.left_at IS NULL
     WHERE m.user_id = $1
       AND m.left_at IS NULL
       AND s.week_key = $2::date
       AND m2.user_id <> $1`,
    [userId, weekKey()],
  );

  const ids = new Set<string>();
  for (const row of friends.rows) ids.add(row.id);
  for (const row of squad.rows) ids.add(row.id);
  ids.delete(userId);
  return [...ids];
}

export async function canVisitGarden(visitorId: string, ownerId: string): Promise<boolean> {
  if (visitorId === ownerId) return false;
  const peers = await listVisitablePeerIds(visitorId);
  return peers.includes(ownerId);
}

export async function listGardenPeers(visitorId: string): Promise<GardenPeerListItem[]> {
  const peerIds = await listVisitablePeerIds(visitorId);
  if (peerIds.length === 0) return [];

  const result = await query<{
    id: string;
    username: string | null;
    nickname: string | null;
    avatar_url: string | null;
    overflow_dew: number | null;
    overflow_dew_day: string | Date | null;
    plot_count: number | null;
    pests_json: unknown;
    updated_at: Date | string | null;
  }>(
    `SELECT u.id, u.username, up.nickname, up.avatar_url,
            g.overflow_dew, g.overflow_dew_day, g.plot_count, g.pests_json, g.updated_at
     FROM users u
     LEFT JOIN user_profiles up ON up.user_id = u.id
     LEFT JOIN user_gardens g ON g.user_id = u.id
     WHERE u.id = ANY($1::uuid[])
       AND u.deleted_at IS NULL
     ORDER BY COALESCE(up.nickname, u.username)`,
    [peerIds],
  );

  const day = todayStr();
  return result.rows.map((row) => {
    const overflowDay = toDateOnly(row.overflow_dew_day);
    const overflowLeft = normalizeOverflowForToday(
      Number(row.overflow_dew) || 0,
      overflowDay,
      day,
    );
    const pestLeft = parseGardenPests(row.pests_json).length;
    return {
      id: row.id,
      username: row.username,
      nickname: row.nickname,
      avatarUrl: row.avatar_url,
      overflowLeft,
      pestLeft,
      plantCount: Number(row.plot_count) || 0,
      updatedAt: row.updated_at == null
        ? null
        : typeof row.updated_at === 'string'
          ? row.updated_at
          : row.updated_at.toISOString(),
    };
  });
}

export async function getVisitProgress(visitorId: string): Promise<{
  visits: number;
  max: number;
  remaining: number;
  day: string;
}> {
  const day = todayStr();
  const result = await query<{ visit_count: number }>(
    `SELECT visit_count FROM garden_visit_daily WHERE visitor_id = $1 AND day = $2::date`,
    [visitorId, day],
  );
  const visits = Number(result.rows[0]?.visit_count) || 0;
  return {
    visits,
    max: GARDEN_DEW_VISIT_DAILY_MAX,
    remaining: Math.max(0, GARDEN_DEW_VISIT_DAILY_MAX - visits),
    day,
  };
}

export type ClaimGardenDewError =
  | 'cannot_visit_self'
  | 'not_visitable'
  | 'garden_missing'
  | 'no_overflow'
  | 'no_pest'
  | 'daily_capped';

export class GardenClaimError extends Error {
  constructor(public readonly code: ClaimGardenDewError) {
    super(code);
  }
}

export async function claimGardenOverflowDew(
  visitorId: string,
  ownerId: string,
): Promise<{
  earned: number;
  overflowLeft: number;
  visits: number;
  visitsMax: number;
  accountBalance?: number;
}> {
  if (visitorId === ownerId) throw new GardenClaimError('cannot_visit_self');
  if (!(await canVisitGarden(visitorId, ownerId))) {
    throw new GardenClaimError('not_visitable');
  }

  const day = todayStr();

  if (!pool) {
    // PGlite / 无 pool：顺序执行（开发环境）
    return claimGardenOverflowDewSequential(visitorId, ownerId, day);
  }

  const client = await pool.connect();
  let claimSeq = 0;
  let overflowLeft = 0;
  let visits = 0;
  try {
    await client.query('BEGIN');

    const visitRow = await client.query<{ visit_count: number }>(
      `INSERT INTO garden_visit_daily (visitor_id, day, visit_count, updated_at)
       VALUES ($1, $2::date, 0, NOW())
       ON CONFLICT (visitor_id, day) DO UPDATE SET updated_at = NOW()
       RETURNING visit_count`,
      [visitorId, day],
    );
    visits = Number(visitRow.rows[0]?.visit_count) || 0;
    if (visits >= GARDEN_DEW_VISIT_DAILY_MAX) {
      throw new GardenClaimError('daily_capped');
    }

    const garden = await client.query<{
      overflow_dew: number;
      overflow_dew_day: string | Date | null;
    }>(
      `SELECT overflow_dew, overflow_dew_day FROM user_gardens WHERE user_id = $1 FOR UPDATE`,
      [ownerId],
    );
    if (!garden.rows[0]) throw new GardenClaimError('garden_missing');

    const overflowDay = toDateOnly(garden.rows[0].overflow_dew_day);
    let overflow = Number(garden.rows[0].overflow_dew) || 0;
    if (overflowDay !== day) overflow = 0;
    if (overflow <= 0) throw new GardenClaimError('no_overflow');

    overflowLeft = overflow - 1;
    await client.query(
      `UPDATE user_gardens
       SET overflow_dew = $2,
           overflow_dew_day = $3::date,
           updated_at = NOW()
       WHERE user_id = $1`,
      [ownerId, overflowLeft, day],
    );

    visits += 1;
    await client.query(
      `UPDATE garden_visit_daily
       SET visit_count = $3, updated_at = NOW()
       WHERE visitor_id = $1 AND day = $2::date`,
      [visitorId, day, visits],
    );

    claimSeq = visits;
    await client.query(
      `INSERT INTO garden_dew_claims (visitor_id, owner_id, day, claim_seq, earned_se)
       VALUES ($1, $2, $3::date, $4, $5)
       ON CONFLICT (visitor_id, owner_id, day, claim_seq) DO NOTHING`,
      [visitorId, ownerId, day, claimSeq, GARDEN_DEW_VISIT_SE],
    );

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  const reward = await claimReward(
    visitorId,
    'dream_garden_visit',
    `${day}:${ownerId}:${claimSeq}`,
    GARDEN_DEW_VISIT_SE,
    '访园 · 同学溢出露珠',
  );

  return {
    earned: reward.earned > 0 ? reward.earned : GARDEN_DEW_VISIT_SE,
    overflowLeft,
    visits,
    visitsMax: GARDEN_DEW_VISIT_DAILY_MAX,
    accountBalance: reward.account.balance,
  };
}

async function claimGardenOverflowDewSequential(
  visitorId: string,
  ownerId: string,
  day: string,
) {
  const progress = await getVisitProgress(visitorId);
  if (progress.visits >= GARDEN_DEW_VISIT_DAILY_MAX) {
    throw new GardenClaimError('daily_capped');
  }

  const garden = await getUserGarden(ownerId);
  if (!garden) throw new GardenClaimError('garden_missing');
  if (garden.overflowDew <= 0) throw new GardenClaimError('no_overflow');

  const overflowLeft = garden.overflowDew - 1;
  await query(
    `UPDATE user_gardens
     SET overflow_dew = $2, overflow_dew_day = $3::date, updated_at = NOW()
     WHERE user_id = $1`,
    [ownerId, overflowLeft, day],
  );

  const visits = progress.visits + 1;
  await query(
    `INSERT INTO garden_visit_daily (visitor_id, day, visit_count, updated_at)
     VALUES ($1, $2::date, $3, NOW())
     ON CONFLICT (visitor_id, day) DO UPDATE SET
       visit_count = EXCLUDED.visit_count,
       updated_at = NOW()`,
    [visitorId, day, visits],
  );

  await query(
    `INSERT INTO garden_dew_claims (visitor_id, owner_id, day, claim_seq, earned_se)
     VALUES ($1, $2, $3::date, $4, $5)
     ON CONFLICT (visitor_id, owner_id, day, claim_seq) DO NOTHING`,
    [visitorId, ownerId, day, visits, GARDEN_DEW_VISIT_SE],
  );

  const reward = await claimReward(
    visitorId,
    'dream_garden_visit',
    `${day}:${ownerId}:${visits}`,
    GARDEN_DEW_VISIT_SE,
    '访园 · 同学溢出露珠',
  );

  return {
    earned: reward.earned > 0 ? reward.earned : GARDEN_DEW_VISIT_SE,
    overflowLeft,
    visits,
    visitsMax: GARDEN_DEW_VISIT_DAILY_MAX,
    accountBalance: reward.account.balance,
  };
}

export async function listGardenHelpToday(ownerId: string): Promise<GardenHelpItem[]> {
  const day = todayStr();
  const result = await query<{
    visitor_id: string;
    smash_count: number;
    nickname: string | null;
    username: string | null;
  }>(
    `SELECT h.visitor_id, h.smash_count, up.nickname, u.username
     FROM garden_help_daily h
     JOIN users u ON u.id = h.visitor_id
     LEFT JOIN user_profiles up ON up.user_id = u.id
     WHERE h.owner_id = $1 AND h.day = $2::date AND h.smash_count > 0
     ORDER BY h.updated_at DESC`,
    [ownerId, day],
  );
  return result.rows.map((row) => ({
    peerId: row.visitor_id,
    alias: row.nickname || row.username || '同学',
    count: Number(row.smash_count) || 0,
  }));
}

export async function smashGardenPest(
  actorId: string,
  ownerId: string,
  pestId: string,
): Promise<{
  earned: number;
  pestLeft: number;
  pests: GardenPestDto[];
  visits: number;
  visitsMax: number;
  ownSmash: boolean;
  accountBalance?: number;
}> {
  const trimmedId = pestId.trim();
  if (!trimmedId) throw new GardenClaimError('no_pest');

  const ownSmash = actorId === ownerId;
  if (!ownSmash && !(await canVisitGarden(actorId, ownerId))) {
    throw new GardenClaimError('not_visitable');
  }

  const day = todayStr();
  const smashed = await withTransaction(async (q) => {
    const garden = await q<{ pests_json: unknown }>(
      `SELECT pests_json FROM user_gardens WHERE user_id = $1 FOR UPDATE`,
      [ownerId],
    );
    if (!garden.rows[0]) throw new GardenClaimError('garden_missing');

    const pests = parseGardenPests(garden.rows[0].pests_json);
    if (!pests.some((p) => p.id === trimmedId)) {
      throw new GardenClaimError('no_pest');
    }
    const next = pests.filter((p) => p.id !== trimmedId);

    let visits = 0;
    if (!ownSmash) {
      const visitRow = await q<{ visit_count: number }>(
        `INSERT INTO garden_visit_daily (visitor_id, day, visit_count, updated_at)
         VALUES ($1, $2::date, 0, NOW())
         ON CONFLICT (visitor_id, day) DO UPDATE SET updated_at = NOW()
         RETURNING visit_count`,
        [actorId, day],
      );
      visits = Number(visitRow.rows[0]?.visit_count) || 0;
      if (visits >= GARDEN_DEW_VISIT_DAILY_MAX) {
        throw new GardenClaimError('daily_capped');
      }
      visits += 1;
      await q(
        `UPDATE garden_visit_daily
         SET visit_count = $3, updated_at = NOW()
         WHERE visitor_id = $1 AND day = $2::date`,
        [actorId, day, visits],
      );
      await q(
        `INSERT INTO garden_dew_claims (visitor_id, owner_id, day, claim_seq, earned_se)
         VALUES ($1, $2, $3::date, $4, $5)
         ON CONFLICT (visitor_id, owner_id, day, claim_seq) DO NOTHING`,
        [actorId, ownerId, day, visits, GARDEN_PEST_SMASH_SE],
      );
      await q(
        `INSERT INTO garden_help_daily (owner_id, visitor_id, day, smash_count, updated_at)
         VALUES ($1, $2, $3::date, 1, NOW())
         ON CONFLICT (owner_id, visitor_id, day) DO UPDATE SET
           smash_count = garden_help_daily.smash_count + 1,
           updated_at = NOW()`,
        [ownerId, actorId, day],
      );
    }

    await q(
      `UPDATE user_gardens
       SET pests_json = $2::jsonb, updated_at = NOW()
       WHERE user_id = $1`,
      [ownerId, JSON.stringify(next)],
    );

    return { next, visits };
  });

  let earned = 0;
  let accountBalance: number | undefined;
  let visits = smashed.visits;
  if (!ownSmash) {
    const reward = await claimReward(
      actorId,
      'dream_garden_visit',
      `${day}:${ownerId}:pest:${trimmedId}`,
      GARDEN_PEST_SMASH_SE,
      '访园 · 赶走漏进来的压力',
    );
    earned = reward.earned > 0 ? reward.earned : GARDEN_PEST_SMASH_SE;
    accountBalance = reward.account.balance;
  } else {
    const progress = await getVisitProgress(actorId);
    visits = progress.visits;
  }

  return {
    earned,
    pestLeft: smashed.next.length,
    pests: smashed.next,
    visits,
    visitsMax: GARDEN_DEW_VISIT_DAILY_MAX,
    ownSmash,
    accountBalance,
  };
}
