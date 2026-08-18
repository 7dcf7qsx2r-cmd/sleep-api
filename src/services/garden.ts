/**
 * 深睡花园 · 多人访园（服务端权威）
 */
import { query, pool } from '../db/client.js';
import { claimReward } from './energyLedger.js';
import { weekKey } from './sleepSquad.js';

export const GARDEN_DEW_PER_HARVEST_DAY = 3;
export const GARDEN_DEW_VISIT_SE = 2;
export const GARDEN_DEW_VISIT_DAILY_MAX = 5;
export const GARDEN_PLOT_MAX = 7;

function todayStr(): string {
  return new Date().toISOString().split('T')[0]!;
}

export type GardenPlantJson = Record<string, unknown>;

export interface GardenSnapshotDto {
  userId: string;
  plants: GardenPlantJson[];
  overflowDew: number;
  overflowDewDay: string | null;
  plotCount: number;
  updatedAt: string;
}

export interface GardenPeerListItem {
  id: string;
  username: string | null;
  nickname: string | null;
  avatarUrl: string | null;
  overflowLeft: number;
  plantCount: number;
  updatedAt: string | null;
}

function mapGardenRow(row: {
  user_id: string;
  plants_json: unknown;
  overflow_dew: number;
  overflow_dew_day: string | Date | null;
  plot_count: number;
  updated_at: Date | string;
}): GardenSnapshotDto {
  const plants = Array.isArray(row.plants_json) ? row.plants_json as GardenPlantJson[] : [];
  const day = row.overflow_dew_day == null
    ? null
    : typeof row.overflow_dew_day === 'string'
      ? row.overflow_dew_day.slice(0, 10)
      : row.overflow_dew_day.toISOString().slice(0, 10);
  const updatedAt = typeof row.updated_at === 'string'
    ? row.updated_at
    : row.updated_at.toISOString();
  return {
    userId: row.user_id,
    plants,
    overflowDew: Number(row.overflow_dew) || 0,
    overflowDewDay: day,
    plotCount: Number(row.plot_count) || plants.length,
    updatedAt,
  };
}

function normalizeOverflowForToday(
  overflowDew: number,
  overflowDewDay: string | null,
  day = todayStr(),
): number {
  if (overflowDewDay !== day) return 0;
  return Math.max(0, overflowDew);
}

export async function upsertUserGarden(
  userId: string,
  input: {
    plants: GardenPlantJson[];
    overflowDew: number;
    overflowDewDay?: string | null;
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

  const result = await query<{
    user_id: string;
    plants_json: unknown;
    overflow_dew: number;
    overflow_dew_day: string | Date | null;
    plot_count: number;
    updated_at: Date | string;
  }>(
    `INSERT INTO user_gardens (user_id, plants_json, overflow_dew, overflow_dew_day, plot_count, updated_at)
     VALUES ($1, $2::jsonb, $3, $4::date, $5, NOW())
     ON CONFLICT (user_id) DO UPDATE SET
       plants_json = EXCLUDED.plants_json,
       overflow_dew = EXCLUDED.overflow_dew,
       overflow_dew_day = EXCLUDED.overflow_dew_day,
       plot_count = EXCLUDED.plot_count,
       updated_at = NOW()
     RETURNING user_id, plants_json, overflow_dew, overflow_dew_day, plot_count, updated_at`,
    [userId, JSON.stringify(plants), overflow, overflowDay, plants.length],
  );
  return mapGardenRow(result.rows[0]!);
}

export async function getUserGarden(userId: string): Promise<GardenSnapshotDto | null> {
  const result = await query<{
    user_id: string;
    plants_json: unknown;
    overflow_dew: number;
    overflow_dew_day: string | Date | null;
    plot_count: number;
    updated_at: Date | string;
  }>(
    `SELECT user_id, plants_json, overflow_dew, overflow_dew_day, plot_count, updated_at
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
    updated_at: Date | string | null;
  }>(
    `SELECT u.id, u.username, up.nickname, up.avatar_url,
            g.overflow_dew, g.overflow_dew_day, g.plot_count, g.updated_at
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
    const overflowDay = row.overflow_dew_day == null
      ? null
      : typeof row.overflow_dew_day === 'string'
        ? row.overflow_dew_day.slice(0, 10)
        : row.overflow_dew_day.toISOString().slice(0, 10);
    const overflowLeft = normalizeOverflowForToday(
      Number(row.overflow_dew) || 0,
      overflowDay,
      day,
    );
    return {
      id: row.id,
      username: row.username,
      nickname: row.nickname,
      avatarUrl: row.avatar_url,
      overflowLeft,
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

    const overflowDay = garden.rows[0].overflow_dew_day == null
      ? null
      : typeof garden.rows[0].overflow_dew_day === 'string'
        ? garden.rows[0].overflow_dew_day.slice(0, 10)
        : garden.rows[0].overflow_dew_day.toISOString().slice(0, 10);
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
