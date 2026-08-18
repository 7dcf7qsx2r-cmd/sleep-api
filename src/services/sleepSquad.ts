import { query, withTransaction, type SqlQuery } from '../db/client.js';
import { claimReward } from './energyLedger.js';

export const SQUAD_MAX_MEMBERS = 50;
export const SQUAD_TARGET_COUNT = 120;
export const SQUAD_POOL_SE = 500;
const MIN_FEED_TEXT = 4;

export class SleepSquadError extends Error {
  constructor(
    public readonly code:
      | 'already_in_other_squad'
      | 'already_played_this_week'
      | 'join_failed',
    message: string,
  ) {
    super(message);
    this.name = 'SleepSquadError';
  }
}

export interface SquadLeaderEntry {
  id: string;
  alias: string;
  avatar: string;
  avatarUrl: string | null;
  gender?: string | null;
  bio: string;
  sleepType?: string | null;
  rank: number;
  contributionCount: number;
  lastNightCount: number;
  feedCount: number;
  estimatedSe: number;
  isMe: boolean;
  followed: boolean;
  followers: number;
  following: number;
}

export interface PendingSquadClaim {
  squadId: string;
  weekKey: string;
  label: string;
  myCount: number;
  rewardSe: number;
  poolOpened: boolean;
}

export interface SleepSquadDto {
  id: string;
  label: string;
  sleepType: string;
  mainConcern: string | null;
  squadNo: number;
  weekKey: string;
  memberCount: number;
  maxMembers: number;
  targetCount: number;
  totalContributions: number;
  poolProgress: number;
  poolRewardSe: number;
  poolOpened: boolean;
  settled: boolean;
  myCount: number;
  myLastNightCount: number;
  myFeedCount: number;
  myRank: number | null;
  estimatedSe: number;
  canClaim: boolean;
  alreadyClaimed: boolean;
  rewardClaimedWeek?: string;
  joinedAt: string;
  members: { id: string; alias: string; avatar: string }[];
  leaderboard: SquadLeaderEntry[];
  /** 兼容旧客户端 */
  targetNights: number;
  userCheckInDates: string[];
  squadNights: number;
  otherMemberCheckIns: number;
  anonCheckIns: number;
}

export interface SleepSquadState {
  squad: SleepSquadDto | null;
  joinStatus: 'none' | 'joined' | 'blocked';
  joinMessage?: string;
  pendingClaim: PendingSquadClaim | null;
}

type SquadRow = {
  id: string;
  sleep_type: string;
  main_concern: string | null;
  week_key: string;
  squad_no: number;
  max_members: number;
  target_count: number;
  pool_reward_se: number;
  joined_at: Date;
};

/** 最大余数法：份额之和严格等于 pool。0 次贡献固定为 0。 */
export function allocateLargestRemainder(pool: number, counts: number[]): number[] {
  const n = counts.length;
  if (n === 0) return [];
  const total = counts.reduce((sum, count) => sum + count, 0);
  if (total <= 0 || pool <= 0) return counts.map(() => 0);
  const exact = counts.map((count) => (count / total) * pool);
  const floors = exact.map((value) => Math.floor(value));
  let remain = pool - floors.reduce((sum, value) => sum + value, 0);
  const order = exact
    .map((value, i) => ({ i, frac: value - floors[i]!, count: counts[i]! }))
    .sort((a, b) => b.frac - a.frac || b.count - a.count || a.i - b.i);
  const result = [...floors];
  for (let k = 0; k < remain; k++) {
    const slot = order[k];
    if (!slot) break;
    result[slot.i] += 1;
  }
  return result;
}

function shanghaiParts(d = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
  });
  const bag: Record<string, string> = {};
  for (const part of fmt.formatToParts(d)) {
    if (part.type !== 'literal') bag[part.type] = part.value;
  }
  const dowMap: Record<string, number> = {
    Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7,
  };
  return {
    ymd: `${bag.year}-${bag.month}-${bag.day}`,
    dow: dowMap[bag.weekday ?? 'Mon'] ?? 1,
  };
}

export function shanghaiToday(d = new Date()): string {
  return shanghaiParts(d).ymd;
}

/** 上海时区本周一日期 YYYY-MM-DD（周日 24:00 进入下一周） */
export function weekKey(d = new Date()): string {
  const { ymd, dow } = shanghaiParts(d);
  const [year, month, day] = ymd.split('-').map(Number);
  const monday = new Date(Date.UTC(year!, month! - 1, day!));
  monday.setUTCDate(monday.getUTCDate() - (dow - 1));
  return monday.toISOString().slice(0, 10);
}

function displayName(row: { nickname?: string | null; username?: string | null; id: string }): string {
  return row.nickname?.trim() || row.username?.trim() || `用户${row.id.slice(0, 4)}`;
}

function squadLabel(sleepType: string, squadNo: number): string {
  return `${sleepType} · 第 ${squadNo} 分队`;
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && (err as { code: string }).code === '23505';
}

export async function joinSleepSquad(input: {
  userId: string;
  sleepType: string;
  mainConcern?: string;
}) {
  const sleepType = input.sleepType.trim();
  if (!sleepType) throw new SleepSquadError('join_failed', '请先完成睡眠类型');

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await withTransaction((q) => joinSleepSquadTx(q, input.userId, sleepType, input.mainConcern));
    } catch (err) {
      if (err instanceof SleepSquadError) throw err;
      if (isUniqueViolation(err) && attempt < 2) continue;
      throw err;
    }
  }
  throw new SleepSquadError('join_failed', '加入小队失败，请稍后重试');
}

async function joinSleepSquadTx(
  q: SqlQuery,
  userId: string,
  sleepType: string,
  mainConcern?: string,
) {
  const wk = weekKey();
  const history = await q<{
    squad_id: string;
    sleep_type: string;
    left_at: Date | null;
  }>(
    `SELECT s.id AS squad_id, s.sleep_type, m.left_at
     FROM sleep_squad_members m
     JOIN sleep_squads s ON s.id = m.squad_id
     WHERE m.user_id = $1 AND s.week_key = $2::date
     ORDER BY m.joined_at DESC`,
    [userId, wk],
  );
  const active = history.rows.find((row) => row.left_at == null);
  if (active) {
    if (active.sleep_type !== sleepType) {
      throw new SleepSquadError('already_in_other_squad', '本周已加入一支小队，不能再加入另一队');
    }
    return getCurrentSleepSquad(userId, q);
  }
  if (history.rows.length > 0) {
    throw new SleepSquadError('already_played_this_week', '本周已退出小队，不能再加入，防止刷队');
  }

  await q(
    `SELECT id FROM sleep_squads WHERE sleep_type = $1 AND week_key = $2::date FOR UPDATE`,
    [sleepType, wk],
  );

  const open = await q<{ id: string }>(
    `SELECT s.id
     FROM sleep_squads s
     LEFT JOIN sleep_squad_members m ON m.squad_id = s.id AND m.left_at IS NULL
     WHERE s.sleep_type = $1 AND s.week_key = $2::date
     GROUP BY s.id, s.max_members
     HAVING COUNT(m.user_id) < s.max_members
     ORDER BY random()
     LIMIT 1`,
    [sleepType, wk],
  );

  let squadId = open.rows[0]?.id;
  if (!squadId) {
    const nextNo = await q<{ n: number }>(
      `SELECT COALESCE(MAX(squad_no), 0) + 1 AS n
       FROM sleep_squads WHERE sleep_type = $1 AND week_key = $2::date`,
      [sleepType, wk],
    );
    const created = await q<{ id: string }>(
      `INSERT INTO sleep_squads (
         sleep_type, main_concern, week_key, squad_no, max_members,
         target_nights, target_count, pool_reward_se
       ) VALUES ($1, $2, $3::date, $4, $5, $6, $6, $7)
       RETURNING id`,
      [
        sleepType,
        mainConcern ?? null,
        wk,
        nextNo.rows[0]?.n ?? 1,
        SQUAD_MAX_MEMBERS,
        SQUAD_TARGET_COUNT,
        SQUAD_POOL_SE,
      ],
    );
    squadId = created.rows[0]!.id;
  }

  await q(
    `INSERT INTO sleep_squad_members (squad_id, user_id)
     VALUES ($1, $2)
     ON CONFLICT (squad_id, user_id)
     DO UPDATE SET left_at = NULL`,
    [squadId, userId],
  );

  return getCurrentSleepSquad(userId, q);
}

export async function leaveCurrentSleepSquad(userId: string) {
  const wk = weekKey();
  const left = await query<{ squad_id: string }>(
    `UPDATE sleep_squad_members m
     SET left_at = NOW()
     FROM sleep_squads s
     WHERE m.squad_id = s.id
       AND m.user_id = $1
       AND m.left_at IS NULL
       AND s.week_key = $2::date
     RETURNING m.squad_id`,
    [userId, wk],
  );
  const squadId = left.rows[0]?.squad_id;
  if (squadId) {
    await query(
      `DELETE FROM sleep_squad_contributions WHERE squad_id = $1 AND user_id = $2`,
      [squadId, userId],
    );
  }
}

export async function recordSleepSquadCheckIn(userId: string, nightDate: string) {
  await recordContribution(userId, 'last_night', nightDate);
  return getCurrentSleepSquad(userId);
}

export async function recordSleepSquadContributionFromPost(
  userId: string,
  type: string,
  contentJson: Record<string, unknown>,
  sourceId?: string,
) {
  const text = String(contentJson.text ?? '').trim();
  const nightDate = typeof contentJson.nightDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(contentJson.nightDate)
    ? contentJson.nightDate
    : null;
  const hasScore = typeof contentJson.sleepScore === 'number';
  if (nightDate && (type === 'check_in' || hasScore || type === 'dream_share')) {
    if (text.length < MIN_FEED_TEXT && !hasScore) return;
    await recordContribution(userId, 'last_night', nightDate, sourceId);
    return;
  }
  if (text.length < MIN_FEED_TEXT) return;
  await recordContribution(userId, 'feed', shanghaiToday(), sourceId);
}

async function recordContribution(
  userId: string,
  kind: 'last_night' | 'feed',
  occurredOn: string,
  sourceId?: string,
) {
  const squad = await getCurrentSleepSquadRow(userId);
  if (!squad) return;
  await query(
    `INSERT INTO sleep_squad_contributions (squad_id, user_id, kind, occurred_on, source_id)
     VALUES ($1, $2, $3, $4::date, $5)
     ON CONFLICT (squad_id, user_id, kind, occurred_on) DO NOTHING`,
    [squad.id, userId, kind, occurredOn, sourceId ?? null],
  );
}

export async function claimSleepSquadReward(userId: string) {
  const pending = await findClaimableSquad(userId);
  if (!pending) {
    const current = await getSleepSquadState(userId);
    return { ok: false, message: '暂无可领取的小队分成', squad: current.squad, pendingClaim: current.pendingClaim };
  }
  if (pending.alreadyClaimed) {
    return { ok: false, message: '上周分成已入账', rewardSe: pending.myShare, squad: await getCurrentSleepSquad(userId) };
  }
  if (!pending.poolOpened) {
    return { ok: false, message: '上周小队未凑满 120 次，能量池未开启', squad: await getCurrentSleepSquad(userId) };
  }
  if (pending.myShare <= 0) {
    return { ok: false, message: '本周没有有效贡献，分成 0 SE', squad: await getCurrentSleepSquad(userId) };
  }

  await query(
    `INSERT INTO sleep_squad_rewards (squad_id, user_id, week_key, claimed_se)
     VALUES ($1, $2, $3::date, $4)
     ON CONFLICT (squad_id, user_id, week_key)
     DO UPDATE SET claimed_se = EXCLUDED.claimed_se`,
    [pending.squad.id, userId, pending.squad.week_key, pending.myShare],
  );
  const reward = await claimReward(
    userId,
    'squad_share_v2',
    `${pending.squad.id}:${pending.squad.week_key}`,
    pending.myShare,
    `睡眠小队分成 · ${squadLabel(pending.squad.sleep_type, pending.squad.squad_no)}`,
    { ignoreDailyCap: true },
  );
  const state = await getSleepSquadState(userId);
  return {
    ok: reward.earned > 0,
    message: reward.earned > 0
      ? `上周小队已结算，你获得 ${reward.earned} SE`
      : '上周分成已入账',
    rewardSe: reward.earned,
    squad: state.squad,
    pendingClaim: state.pendingClaim,
  };
}

export async function getCurrentSleepSquad(userId: string, q: SqlQuery = query) {
  const squad = await getCurrentSleepSquadRow(userId, q);
  if (!squad) return null;
  return buildSleepSquadDto(userId, squad, q);
}

export async function getSleepSquadState(userId: string): Promise<SleepSquadState> {
  const wk = weekKey();
  const squad = await getCurrentSleepSquad(userId);
  const history = await query<{ left_at: Date | null }>(
    `SELECT m.left_at
     FROM sleep_squad_members m
     JOIN sleep_squads s ON s.id = m.squad_id
     WHERE m.user_id = $1 AND s.week_key = $2::date
     LIMIT 1`,
    [userId, wk],
  );
  let joinStatus: SleepSquadState['joinStatus'] = 'none';
  let joinMessage: string | undefined;
  if (squad) joinStatus = 'joined';
  else if (history.rows[0]) {
    joinStatus = 'blocked';
    joinMessage = '本周已退出小队，不能再加入';
  }
  const pendingClaim = await getPendingClaim(userId);
  return { squad, joinStatus, joinMessage, pendingClaim };
}

async function getCurrentSleepSquadRow(userId: string, q: SqlQuery = query) {
  const wk = weekKey();
  const row = await q<SquadRow>(
    `SELECT s.id, s.sleep_type, s.main_concern, s.week_key::text,
            COALESCE(s.squad_no, 1) AS squad_no,
            COALESCE(s.max_members, 50) AS max_members,
            COALESCE(s.target_count, 120) AS target_count,
            s.pool_reward_se, m.joined_at
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

async function getPendingClaim(userId: string): Promise<PendingSquadClaim | null> {
  const found = await findClaimableSquad(userId);
  if (!found || found.alreadyClaimed || !found.poolOpened || found.myShare <= 0) return null;
  return {
    squadId: found.squad.id,
    weekKey: found.squad.week_key,
    label: squadLabel(found.squad.sleep_type, found.squad.squad_no),
    myCount: found.myCount,
    rewardSe: found.myShare,
    poolOpened: found.poolOpened,
  };
}

async function findClaimableSquad(userId: string) {
  const wk = weekKey();
  const rows = await query<SquadRow>(
    `SELECT s.id, s.sleep_type, s.main_concern, s.week_key::text,
            COALESCE(s.squad_no, 1) AS squad_no,
            COALESCE(s.max_members, 50) AS max_members,
            COALESCE(s.target_count, 120) AS target_count,
            s.pool_reward_se, m.joined_at
     FROM sleep_squad_members m
     JOIN sleep_squads s ON s.id = m.squad_id
     WHERE m.user_id = $1
       AND m.left_at IS NULL
       AND s.week_key < $2::date
     ORDER BY s.week_key DESC
     LIMIT 3`,
    [userId, wk],
  );
  for (const squad of rows.rows) {
    const snapshot = await contributionSnapshot(squad.id);
    const poolOpened = snapshot.total >= squad.target_count;
    const claimed = await query<{ claimed_se: number }>(
      `SELECT COALESCE(claimed_se, 0) AS claimed_se
       FROM sleep_squad_rewards
       WHERE squad_id = $1 AND user_id = $2 AND week_key = $3::date`,
      [squad.id, userId, squad.week_key],
    );
    const shares = allocateLargestRemainder(
      poolOpened ? squad.pool_reward_se : 0,
      snapshot.members.map((member) => member.count),
    );
    const index = snapshot.members.findIndex((member) => member.userId === userId);
    const myCount = index >= 0 ? snapshot.members[index]!.count : 0;
    const myShare = index >= 0 ? shares[index]! : 0;
    return {
      squad,
      poolOpened,
      myCount,
      myShare,
      alreadyClaimed: Boolean(claimed.rows[0]),
    };
  }
  return null;
}

async function contributionSnapshot(squadId: string, q: SqlQuery = query) {
  const rows = await q<{
    user_id: string;
    last_night_count: number;
    feed_count: number;
    count: number;
  }>(
    `SELECT m.user_id,
            COUNT(*) FILTER (WHERE c.kind = 'last_night')::int AS last_night_count,
            COUNT(*) FILTER (WHERE c.kind = 'feed')::int AS feed_count,
            COUNT(c.id)::int AS count
     FROM sleep_squad_members m
     LEFT JOIN sleep_squad_contributions c
       ON c.squad_id = m.squad_id AND c.user_id = m.user_id
     WHERE m.squad_id = $1 AND m.left_at IS NULL
     GROUP BY m.user_id`,
    [squadId],
  );
  const members = rows.rows.map((row) => ({
    userId: row.user_id,
    lastNightCount: row.last_night_count,
    feedCount: row.feed_count,
    count: row.count,
  }));
  const total = members.reduce((sum, member) => sum + member.count, 0);
  return { members, total };
}

async function buildSleepSquadDto(userId: string, squad: SquadRow, q: SqlQuery = query): Promise<SleepSquadDto> {
  const members = await q<{
    id: string;
    username: string | null;
    nickname: string | null;
    avatar_url: string | null;
    avatar_emoji: string | null;
    gender: string | null;
    bio: string | null;
    sleep_type: string | null;
    followers: number;
    following: number;
    followed: boolean;
    joined_at: Date;
  }>(
    `SELECT u.id, u.username, up.nickname, up.avatar_url,
            profile_blob.data->>'avatar' AS avatar_emoji,
            COALESCE(profile_blob.data->>'gender', persona_blob.data->>'gender') AS gender,
            COALESCE(profile_blob.data->>'bio', '') AS bio,
            COALESCE(profile_blob.data->>'sleepType', persona_blob.data->>'sleepType') AS sleep_type,
            (SELECT COUNT(*)::int FROM user_follows uf WHERE uf.followed_id = u.id) AS followers,
            (SELECT COUNT(*)::int FROM user_follows uf WHERE uf.follower_id = u.id) AS following,
            EXISTS (
              SELECT 1 FROM user_follows uf
              WHERE uf.follower_id = $2 AND uf.followed_id = u.id
            ) AS followed,
            m.joined_at
     FROM sleep_squad_members m
     JOIN users u ON u.id = m.user_id
     LEFT JOIN user_profiles up ON up.user_id = u.id
     LEFT JOIN data_blobs profile_blob
       ON profile_blob.owner_type = 'user' AND profile_blob.owner_id = u.id AND profile_blob.domain = 'profile'
     LEFT JOIN data_blobs persona_blob
       ON persona_blob.owner_type = 'user' AND persona_blob.owner_id = u.id AND persona_blob.domain = 'persona'
     WHERE m.squad_id = $1 AND m.left_at IS NULL`,
    [squad.id, userId],
  );

  const snapshot = await contributionSnapshot(squad.id, q);
  const countByUser = new Map(snapshot.members.map((member) => [member.userId, member]));
  const nightDates = await q<{ night_date: string }>(
    `SELECT occurred_on::text AS night_date
     FROM sleep_squad_contributions
     WHERE squad_id = $1 AND user_id = $2 AND kind = 'last_night'
     ORDER BY occurred_on`,
    [squad.id, userId],
  );
  const reward = await q<{ claimed_at: Date }>(
    `SELECT claimed_at
     FROM sleep_squad_rewards
     WHERE squad_id = $1 AND user_id = $2 AND week_key = $3::date`,
    [squad.id, userId, squad.week_key],
  );

  const settled = squad.week_key < weekKey();
  const poolOpened = snapshot.total >= squad.target_count;
  const ranked = [...members.rows].sort((a, b) => {
    const ca = countByUser.get(a.id)?.count ?? 0;
    const cb = countByUser.get(b.id)?.count ?? 0;
    if (cb !== ca) return cb - ca;
    return new Date(a.joined_at).getTime() - new Date(b.joined_at).getTime();
  });
  const shares = allocateLargestRemainder(
    poolOpened ? squad.pool_reward_se : 0,
    ranked.map((member) => countByUser.get(member.id)?.count ?? 0),
  );

  const leaderboard: SquadLeaderEntry[] = ranked.map((member, index) => {
    const stats = countByUser.get(member.id);
    return {
      id: member.id,
      alias: member.id === userId ? '我' : displayName(member),
      avatar: member.avatar_url || member.avatar_emoji || '',
      avatarUrl: member.avatar_url,
      gender: member.gender,
      bio: member.bio ?? '',
      sleepType: member.sleep_type,
      rank: index + 1,
      contributionCount: stats?.count ?? 0,
      lastNightCount: stats?.lastNightCount ?? 0,
      feedCount: stats?.feedCount ?? 0,
      estimatedSe: shares[index] ?? 0,
      isMe: member.id === userId,
      followed: member.followed,
      followers: member.followers,
      following: member.following,
    };
  });
  const me = leaderboard.find((entry) => entry.isMe);
  const alreadyClaimed = Boolean(reward.rows[0]);

  return {
    id: squad.id,
    label: squadLabel(squad.sleep_type, squad.squad_no),
    sleepType: squad.sleep_type,
    mainConcern: squad.main_concern,
    squadNo: squad.squad_no,
    weekKey: squad.week_key,
    memberCount: members.rows.length,
    maxMembers: squad.max_members,
    targetCount: squad.target_count,
    totalContributions: snapshot.total,
    poolProgress: Math.min(100, Math.round((snapshot.total / squad.target_count) * 100)),
    poolRewardSe: squad.pool_reward_se,
    poolOpened,
    settled,
    myCount: me?.contributionCount ?? 0,
    myLastNightCount: me?.lastNightCount ?? 0,
    myFeedCount: me?.feedCount ?? 0,
    myRank: me?.rank ?? null,
    estimatedSe: me?.estimatedSe ?? 0,
    canClaim: settled && poolOpened && !alreadyClaimed && (me?.estimatedSe ?? 0) > 0,
    alreadyClaimed,
    rewardClaimedWeek: alreadyClaimed ? squad.week_key : undefined,
    joinedAt: squad.joined_at instanceof Date ? squad.joined_at.toISOString() : String(squad.joined_at),
    members: members.rows
      .filter((member) => member.id !== userId)
      .map((member) => ({
        id: member.id,
        alias: displayName(member),
        avatar: member.avatar_url || member.avatar_emoji || '',
      })),
    leaderboard,
    targetNights: squad.target_count,
    userCheckInDates: nightDates.rows.map((row) => row.night_date),
    squadNights: snapshot.total,
    otherMemberCheckIns: Math.max(0, snapshot.total - (me?.contributionCount ?? 0)),
    anonCheckIns: Math.max(0, snapshot.total - (me?.contributionCount ?? 0)),
  };
}
