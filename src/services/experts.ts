import { query } from '../db/client.js';

export type ExpertStatus = 'pending_review' | 'published' | 'archived';
export type CredentialStatus = 'pending' | 'approved' | 'rejected';

export interface ExpertInput {
  name: string;
  title: string;
  avatarUrl?: string | null;
  bio: string;
  tags: string[];
  serviceMethods: string[];
  priceRmb: number;
  sortOrder: number;
  status: ExpertStatus;
  reviewNote?: string | null;
}

interface ExpertRow {
  id: string;
  name: string;
  title: string;
  avatar_url: string | null;
  bio: string;
  tags: unknown;
  service_methods: unknown;
  price_rmb: string;
  sort_order: number;
  status: ExpertStatus;
  review_note: string | null;
  published_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

interface CredentialRow {
  id: string;
  expert_id: string;
  name: string;
  image_url: string | null;
  status: CredentialStatus;
  review_note: string | null;
  created_at: Date;
  updated_at: Date;
}

function stringArray(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((item): item is string => typeof item === 'string');
}

function mapExpert(row: ExpertRow) {
  return {
    id: row.id,
    name: row.name,
    title: row.title,
    avatarUrl: row.avatar_url,
    bio: row.bio,
    tags: stringArray(row.tags),
    serviceMethods: stringArray(row.service_methods),
    priceRmb: Number(row.price_rmb),
    sortOrder: row.sort_order,
    status: row.status,
    reviewNote: row.review_note,
    publishedAt: row.published_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function mapCredential(row: CredentialRow) {
  return {
    id: row.id,
    expertId: row.expert_id,
    name: row.name,
    imageUrl: row.image_url,
    status: row.status,
    reviewNote: row.review_note,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

const expertSelect = `SELECT id, name, title, avatar_url, bio, tags, service_methods,
  price_rmb, sort_order, status, review_note, published_at, created_at, updated_at
  FROM experts`;

export async function listExperts(options: { includeArchived?: boolean } = {}) {
  const where = options.includeArchived ? '' : `WHERE status = 'published'`;
  const result = await query<ExpertRow>(
    `${expertSelect} ${where} ORDER BY sort_order ASC, created_at DESC`,
  );
  return result.rows.map(mapExpert);
}

export async function getExpert(expertId: string, options: { includeUnpublished?: boolean } = {}) {
  const whereStatus = options.includeUnpublished ? '' : `AND status = 'published'`;
  const result = await query<ExpertRow>(
    `${expertSelect} WHERE id = $1 ${whereStatus}`,
    [expertId],
  );
  const row = result.rows[0];
  if (!row) return null;
  const credentials = await listExpertCredentials(expertId);
  return { ...mapExpert(row), credentials };
}

export async function createExpert(input: ExpertInput) {
  const result = await query<ExpertRow>(
    `INSERT INTO experts (
      name, title, avatar_url, bio, tags, service_methods, price_rmb,
      sort_order, status, review_note, published_at
    )
    VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8, $9, $10,
            CASE WHEN $9 = 'published' THEN NOW() ELSE NULL END)
    RETURNING id, name, title, avatar_url, bio, tags, service_methods,
              price_rmb, sort_order, status, review_note, published_at, created_at, updated_at`,
    [
      input.name,
      input.title,
      input.avatarUrl ?? null,
      input.bio,
      JSON.stringify(input.tags),
      JSON.stringify(input.serviceMethods),
      input.priceRmb,
      input.sortOrder,
      input.status,
      input.reviewNote ?? null,
    ],
  );
  return mapExpert(result.rows[0]!);
}

export async function updateExpert(expertId: string, input: ExpertInput) {
  const before = await getExpert(expertId, { includeUnpublished: true });
  if (!before) return null;
  const result = await query<ExpertRow>(
    `UPDATE experts SET
      name = $2,
      title = $3,
      avatar_url = $4,
      bio = $5,
      tags = $6::jsonb,
      service_methods = $7::jsonb,
      price_rmb = $8,
      sort_order = $9,
      status = $10,
      review_note = $11,
      published_at = CASE WHEN $10 = 'published' AND published_at IS NULL THEN NOW() ELSE published_at END,
      updated_at = NOW()
     WHERE id = $1
     RETURNING id, name, title, avatar_url, bio, tags, service_methods,
               price_rmb, sort_order, status, review_note, published_at, created_at, updated_at`,
    [
      expertId,
      input.name,
      input.title,
      input.avatarUrl ?? null,
      input.bio,
      JSON.stringify(input.tags),
      JSON.stringify(input.serviceMethods),
      input.priceRmb,
      input.sortOrder,
      input.status,
      input.reviewNote ?? null,
    ],
  );
  return { before, after: mapExpert(result.rows[0]!) };
}

export async function setExpertStatus(expertId: string, status: ExpertStatus, reviewNote?: string) {
  const before = await getExpert(expertId, { includeUnpublished: true });
  if (!before) return null;
  const result = await query<ExpertRow>(
    `UPDATE experts
     SET status = $2,
         review_note = $3,
         published_at = CASE WHEN $2 = 'published' AND published_at IS NULL THEN NOW() ELSE published_at END,
         updated_at = NOW()
     WHERE id = $1
     RETURNING id, name, title, avatar_url, bio, tags, service_methods,
               price_rmb, sort_order, status, review_note, published_at, created_at, updated_at`,
    [expertId, status, reviewNote ?? null],
  );
  return { before, after: mapExpert(result.rows[0]!) };
}

export async function listExpertCredentials(expertId: string) {
  const result = await query<CredentialRow>(
    `SELECT id, expert_id, name, image_url, status, review_note, created_at, updated_at
     FROM expert_credentials
     WHERE expert_id = $1
     ORDER BY created_at DESC`,
    [expertId],
  );
  return result.rows.map(mapCredential);
}

export async function createExpertCredential(params: {
  expertId: string;
  name: string;
  imageUrl?: string | null;
}) {
  const result = await query<CredentialRow>(
    `INSERT INTO expert_credentials (expert_id, name, image_url)
     VALUES ($1, $2, $3)
     RETURNING id, expert_id, name, image_url, status, review_note, created_at, updated_at`,
    [params.expertId, params.name, params.imageUrl ?? null],
  );
  return mapCredential(result.rows[0]!);
}

export async function reviewExpertCredential(params: {
  credentialId: string;
  status: CredentialStatus;
  reviewNote?: string;
}) {
  const before = await query<CredentialRow>(
    `SELECT id, expert_id, name, image_url, status, review_note, created_at, updated_at
     FROM expert_credentials WHERE id = $1`,
    [params.credentialId],
  );
  const beforeRow = before.rows[0];
  if (!beforeRow) return null;
  const result = await query<CredentialRow>(
    `UPDATE expert_credentials
     SET status = $2, review_note = $3, updated_at = NOW()
     WHERE id = $1
     RETURNING id, expert_id, name, image_url, status, review_note, created_at, updated_at`,
    [params.credentialId, params.status, params.reviewNote ?? null],
  );
  return { before: mapCredential(beforeRow), after: mapCredential(result.rows[0]!) };
}
