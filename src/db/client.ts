import { mkdirSync } from 'node:fs';
import pg from 'pg';
import type { PGlite } from '@electric-sql/pglite';
import { config } from '../config.js';

const { Pool } = pg;

let pgPool: pg.Pool | null = null;
let pgliteDb: PGlite | null = null;

if (!config.usePglite) {
  pgPool = new Pool({ connectionString: config.databaseUrl });
}

/** Postgres pool — only when not using PGlite. */
export const pool = pgPool;

async function getPglite(): Promise<PGlite> {
  if (!pgliteDb) {
    const { PGlite } = await import('@electric-sql/pglite');
    mkdirSync(config.pgliteDataDir, { recursive: true });
    pgliteDb = new PGlite(config.pgliteDataDir);
  }
  return pgliteDb;
}

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params?: unknown[],
): Promise<pg.QueryResult<T>> {
  if (config.usePglite) {
    const db = await getPglite();
    const result = await db.query<T>(text, params);
    return result as pg.QueryResult<T>;
  }
  return pgPool!.query<T>(text, params);
}

export async function closeDb(): Promise<void> {
  if (pgPool) {
    await pgPool.end();
    pgPool = null;
  }
  if (pgliteDb) {
    await pgliteDb.close();
    pgliteDb = null;
  }
}
