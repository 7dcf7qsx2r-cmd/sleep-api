import { query, type SqlQuery } from '../db/client.js';
import type { OwnerRef } from '../lib/owner.js';

export const SYNC_DOMAINS = [
  'profile',
  'persona',
  'dream_diary',
  'dream_bottles',
  'interpret',
  'standin',
  'bedtime_story',
  'chat_messages',
  'voice_prefs',
  'user_memory',
  'user_facts',
  'sleep_nights',
  'attributions',
  'device_registry',
  'sleep_audio_clips',
  'privacy_consent',
  'health_measure_summaries',
  'ecg_summaries',
  'garden_seeds',
  'sleep_atlas',
  'consult_summaries',
] as const;

export type SyncDomain = typeof SYNC_DOMAINS[number];

export interface DataBlobRow {
  domain: string;
  data: unknown;
  version: number;
  updatedAt: string;
}

export async function getBlob(owner: OwnerRef, domain: string): Promise<DataBlobRow | null> {
  const row = await query<{
    domain: string;
    data: unknown;
    version: number;
    updated_at: Date;
  }>(
    `SELECT domain, data, version, updated_at
     FROM data_blobs
     WHERE owner_type = $1 AND owner_id = $2 AND domain = $3`,
    [owner.ownerType, owner.ownerId, domain],
  );
  const r = row.rows[0];
  if (!r) return null;
  return {
    domain: r.domain,
    data: r.data,
    version: r.version,
    updatedAt: r.updated_at.toISOString(),
  };
}

export async function listBlobs(owner: OwnerRef): Promise<DataBlobRow[]> {
  const row = await query<{
    domain: string;
    data: unknown;
    version: number;
    updated_at: Date;
  }>(
    `SELECT domain, data, version, updated_at
     FROM data_blobs
     WHERE owner_type = $1 AND owner_id = $2`,
    [owner.ownerType, owner.ownerId],
  );
  return row.rows.map((r) => ({
    domain: r.domain,
    data: r.data,
    version: r.version,
    updatedAt: r.updated_at.toISOString(),
  }));
}

export async function listBlobsSince(owner: OwnerRef, since: Date): Promise<DataBlobRow[]> {
  const row = await query<{
    domain: string;
    data: unknown;
    version: number;
    updated_at: Date;
  }>(
    `SELECT domain, data, version, updated_at
     FROM data_blobs
     WHERE owner_type = $1 AND owner_id = $2 AND updated_at > $3`,
    [owner.ownerType, owner.ownerId, since],
  );
  return row.rows.map((r) => ({
    domain: r.domain,
    data: r.data,
    version: r.version,
    updatedAt: r.updated_at.toISOString(),
  }));
}

export async function upsertBlob(
  owner: OwnerRef,
  domain: string,
  expectedVersion: number,
  data: unknown,
): Promise<{ ok: true; row: DataBlobRow } | { ok: false; conflict: DataBlobRow }> {
  const existing = await getBlob(owner, domain);

  if (!existing) {
    const inserted = await query<{
      domain: string;
      data: unknown;
      version: number;
      updated_at: Date;
    }>(
      `INSERT INTO data_blobs (owner_type, owner_id, domain, data, version)
       VALUES ($1, $2, $3, $4::jsonb, 1)
       RETURNING domain, data, version, updated_at`,
      [owner.ownerType, owner.ownerId, domain, JSON.stringify(data)],
    );
    const r = inserted.rows[0]!;
    await logChange(owner, domain, 1);
    return {
      ok: true,
      row: {
        domain: r.domain,
        data: r.data,
        version: r.version,
        updatedAt: r.updated_at.toISOString(),
      },
    };
  }

  if (existing.version !== expectedVersion) {
    return { ok: false, conflict: existing };
  }

  const updated = await query<{
    domain: string;
    data: unknown;
    version: number;
    updated_at: Date;
  }>(
    `UPDATE data_blobs
     SET data = $5::jsonb, version = version + 1, updated_at = NOW()
     WHERE owner_type = $1 AND owner_id = $2 AND domain = $3 AND version = $4
     RETURNING domain, data, version, updated_at`,
    [owner.ownerType, owner.ownerId, domain, expectedVersion, JSON.stringify(data)],
  );

  if (!updated.rows[0]) {
    const current = await getBlob(owner, domain);
    if (!current) throw new Error('blob disappeared during update');
    return { ok: false, conflict: current };
  }

  const r = updated.rows[0];
  await logChange(owner, domain, r.version);
  return {
    ok: true,
    row: {
      domain: r.domain,
      data: r.data,
      version: r.version,
      updatedAt: r.updated_at.toISOString(),
    },
  };
}

async function logChange(owner: OwnerRef, domain: string, version: number) {
  await query(
    `INSERT INTO sync_changelog (owner_type, owner_id, domain, version)
     VALUES ($1, $2, $3, $4)`,
    [owner.ownerType, owner.ownerId, domain, version],
  );
}

/** 仅填补目标账号空缺的同步域，不覆盖已有内容 */
export async function fillEmptyBlobsFromUserToUser(
  fromUserId: string,
  toUserId: string,
  q: SqlQuery = query,
): Promise<string[]> {
  const source = await q<{
    domain: string;
    data: unknown;
    version: number;
    updated_at: Date;
  }>(
    `SELECT domain, data, version, updated_at
     FROM data_blobs
     WHERE owner_type = 'user' AND owner_id = $1`,
    [fromUserId],
  );
  const filled: string[] = [];
  for (const blob of source.rows) {
    const inserted = await q<{ domain: string }>(
      `INSERT INTO data_blobs (owner_type, owner_id, domain, data, version, updated_at)
       VALUES ('user', $1, $2, $3::jsonb, $4, $5::timestamptz)
       ON CONFLICT (owner_type, owner_id, domain) DO NOTHING
       RETURNING domain`,
      [
        toUserId,
        blob.domain,
        JSON.stringify(blob.data),
        blob.version,
        blob.updated_at.toISOString(),
      ],
    );
    if (inserted.rows[0]) filled.push(inserted.rows[0].domain);
  }
  return filled;
}

export async function copyBlobsFromGuestToUser(guestId: string, userId: string) {
  const guestBlobs = await listBlobs({ ownerType: 'guest', ownerId: guestId });
  for (const blob of guestBlobs) {
    const userBlob = await getBlob({ ownerType: 'user', ownerId: userId }, blob.domain);
    if (!userBlob || userBlob.version < blob.version) {
      await query(
        `INSERT INTO data_blobs (owner_type, owner_id, domain, data, version, updated_at)
         VALUES ('user', $1, $2, $3::jsonb, $4, $5::timestamptz)
         ON CONFLICT (owner_type, owner_id, domain)
         DO UPDATE SET
           data = EXCLUDED.data,
           version = EXCLUDED.version,
           updated_at = EXCLUDED.updated_at
         WHERE data_blobs.version < EXCLUDED.version`,
        [userId, blob.domain, JSON.stringify(blob.data), blob.version, blob.updatedAt],
      );
    }
  }
  await query(
    `UPDATE guest_sessions SET merged_to_user_id = $2 WHERE id = $1`,
    [guestId, userId],
  );
}
