import { query } from '../db/client.js';

export type ContentStatus = 'draft' | 'published' | 'archived';
export type CampaignStatus = 'draft' | 'active' | 'paused' | 'ended';

export interface ContentInput {
  contentKey: string;
  placement: string;
  title: string;
  summary: string;
  body: string;
  imageUrl?: string | null;
  actionUrl?: string | null;
  status: ContentStatus;
  sortOrder: number;
  metadata?: Record<string, unknown>;
}

export interface CampaignInput {
  name: string;
  channel: string;
  status: CampaignStatus;
  goal: string;
  budgetRmb: number;
  startsAt?: string | null;
  endsAt?: string | null;
  config?: Record<string, unknown>;
}

interface ContentRow {
  id: string;
  content_key: string;
  placement: string;
  title: string;
  summary: string;
  body: string;
  image_url: string | null;
  action_url: string | null;
  status: ContentStatus;
  sort_order: number;
  metadata_json: unknown;
  published_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

interface CampaignRow {
  id: string;
  name: string;
  channel: string;
  status: CampaignStatus;
  goal: string;
  budget_rmb: string;
  starts_at: Date | null;
  ends_at: Date | null;
  config_json: unknown;
  created_at: Date;
  updated_at: Date;
}

function mapContent(row: ContentRow) {
  return {
    id: row.id,
    contentKey: row.content_key,
    placement: row.placement,
    title: row.title,
    summary: row.summary,
    body: row.body,
    imageUrl: row.image_url,
    actionUrl: row.action_url,
    status: row.status,
    sortOrder: row.sort_order,
    metadata: row.metadata_json,
    publishedAt: row.published_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function mapCampaign(row: CampaignRow) {
  return {
    id: row.id,
    name: row.name,
    channel: row.channel,
    status: row.status,
    goal: row.goal,
    budgetRmb: Number(row.budget_rmb),
    startsAt: row.starts_at?.toISOString() ?? null,
    endsAt: row.ends_at?.toISOString() ?? null,
    config: row.config_json,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

const contentSelect = `SELECT id, content_key, placement, title, summary, body, image_url,
  action_url, status, sort_order, metadata_json, published_at, created_at, updated_at
  FROM content_items`;

export async function listContentItems(params: {
  placement?: string;
  includeArchived?: boolean;
  publishedOnly?: boolean;
} = {}) {
  const where: string[] = [];
  const values: unknown[] = [];
  let idx = 1;
  if (params.placement) {
    where.push(`placement = $${idx++}`);
    values.push(params.placement);
  }
  if (params.publishedOnly) where.push(`status = 'published'`);
  else if (!params.includeArchived) where.push(`status <> 'archived'`);
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const result = await query<ContentRow>(
    `${contentSelect} ${whereSql} ORDER BY sort_order ASC, created_at DESC`,
    values,
  );
  return result.rows.map(mapContent);
}

export async function createContentItem(input: ContentInput) {
  const result = await query<ContentRow>(
    `INSERT INTO content_items (
      content_key, placement, title, summary, body, image_url, action_url,
      status, sort_order, metadata_json, published_at
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb,
            CASE WHEN $8 = 'published' THEN NOW() ELSE NULL END)
    RETURNING id, content_key, placement, title, summary, body, image_url,
              action_url, status, sort_order, metadata_json, published_at, created_at, updated_at`,
    [
      input.contentKey,
      input.placement,
      input.title,
      input.summary,
      input.body,
      input.imageUrl ?? null,
      input.actionUrl ?? null,
      input.status,
      input.sortOrder,
      JSON.stringify(input.metadata ?? {}),
    ],
  );
  return mapContent(result.rows[0]!);
}

export async function updateContentItem(id: string, input: ContentInput) {
  const before = await query<ContentRow>(`${contentSelect} WHERE id = $1`, [id]);
  if (!before.rows[0]) return null;
  const result = await query<ContentRow>(
    `UPDATE content_items SET
      content_key = $2,
      placement = $3,
      title = $4,
      summary = $5,
      body = $6,
      image_url = $7,
      action_url = $8,
      status = $9,
      sort_order = $10,
      metadata_json = $11::jsonb,
      published_at = CASE WHEN $9 = 'published' AND published_at IS NULL THEN NOW() ELSE published_at END,
      updated_at = NOW()
     WHERE id = $1
     RETURNING id, content_key, placement, title, summary, body, image_url,
               action_url, status, sort_order, metadata_json, published_at, created_at, updated_at`,
    [
      id,
      input.contentKey,
      input.placement,
      input.title,
      input.summary,
      input.body,
      input.imageUrl ?? null,
      input.actionUrl ?? null,
      input.status,
      input.sortOrder,
      JSON.stringify(input.metadata ?? {}),
    ],
  );
  return { before: mapContent(before.rows[0]), after: mapContent(result.rows[0]!) };
}

const campaignSelect = `SELECT id, name, channel, status, goal, budget_rmb,
  starts_at, ends_at, config_json, created_at, updated_at FROM growth_campaigns`;

export async function listGrowthCampaigns() {
  const result = await query<CampaignRow>(
    `${campaignSelect} ORDER BY created_at DESC`,
  );
  return result.rows.map(mapCampaign);
}

export async function createGrowthCampaign(input: CampaignInput) {
  const result = await query<CampaignRow>(
    `INSERT INTO growth_campaigns (name, channel, status, goal, budget_rmb, starts_at, ends_at, config_json)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
     RETURNING id, name, channel, status, goal, budget_rmb, starts_at, ends_at, config_json, created_at, updated_at`,
    [
      input.name,
      input.channel,
      input.status,
      input.goal,
      input.budgetRmb,
      input.startsAt ?? null,
      input.endsAt ?? null,
      JSON.stringify(input.config ?? {}),
    ],
  );
  return mapCampaign(result.rows[0]!);
}

export async function updateGrowthCampaign(id: string, input: CampaignInput) {
  const before = await query<CampaignRow>(`${campaignSelect} WHERE id = $1`, [id]);
  if (!before.rows[0]) return null;
  const result = await query<CampaignRow>(
    `UPDATE growth_campaigns SET
      name = $2,
      channel = $3,
      status = $4,
      goal = $5,
      budget_rmb = $6,
      starts_at = $7,
      ends_at = $8,
      config_json = $9::jsonb,
      updated_at = NOW()
     WHERE id = $1
     RETURNING id, name, channel, status, goal, budget_rmb, starts_at, ends_at, config_json, created_at, updated_at`,
    [
      id,
      input.name,
      input.channel,
      input.status,
      input.goal,
      input.budgetRmb,
      input.startsAt ?? null,
      input.endsAt ?? null,
      JSON.stringify(input.config ?? {}),
    ],
  );
  return { before: mapCampaign(before.rows[0]), after: mapCampaign(result.rows[0]!) };
}
