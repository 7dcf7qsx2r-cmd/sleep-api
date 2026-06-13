import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { requireAuth, type AuthVariables } from '../middleware/auth.js';
import { ownerFromAuth } from '../lib/owner.js';
import {
  listBlobs,
  listBlobsSince,
  upsertBlob,
  SYNC_DOMAINS,
  type SyncDomain,
} from '../services/dataBlob.js';
import { ensureEnergyAccount } from '../services/energy.js';

export const syncRoutes = new Hono<{ Variables: AuthVariables }>();

syncRoutes.use('*', requireAuth);

syncRoutes.get('/bootstrap', async (c) => {
  const auth = c.get('auth');
  const owner = ownerFromAuth(auth);
  const blobs = await listBlobs(owner);

  let energy = null;
  if (auth.type === 'user') {
    energy = await ensureEnergyAccount(auth.sub);
  }

  const serverTime = new Date().toISOString();
  return c.json({
    serverTime,
    ownerType: owner.ownerType,
    ownerId: owner.ownerId,
    domains: blobs,
    energy,
    supportedDomains: SYNC_DOMAINS,
  });
});

syncRoutes.get('/delta', async (c) => {
  const auth = c.get('auth');
  const owner = ownerFromAuth(auth);
  const sinceRaw = c.req.query('since');
  if (!sinceRaw) {
    return c.json({ error: 'missing_since', message: 'since query param required' }, 400);
  }
  const since = new Date(sinceRaw);
  if (Number.isNaN(since.getTime())) {
    return c.json({ error: 'invalid_since' }, 400);
  }

  const blobs = await listBlobsSince(owner, since);
  let energy = null;
  if (auth.type === 'user') {
    energy = await ensureEnergyAccount(auth.sub);
  }

  return c.json({
    serverTime: new Date().toISOString(),
    domains: blobs,
    energy,
  });
});

syncRoutes.put(
  '/:domain',
  zValidator(
    'json',
    z.object({
      version: z.number().int().min(0),
      data: z.unknown(),
    }),
  ),
  async (c) => {
    const auth = c.get('auth');
    const owner = ownerFromAuth(auth);
    const domain = c.req.param('domain');

    if (!SYNC_DOMAINS.includes(domain as SyncDomain)) {
      return c.json({ error: 'invalid_domain', message: `Unknown domain: ${domain}` }, 400);
    }

    const body = c.req.valid('json');
    const result = await upsertBlob(owner, domain, body.version, body.data);

    if (!result.ok) {
      return c.json({
        error: 'version_conflict',
        message: 'Server has newer data',
        server: result.conflict,
      }, 409);
    }

    return c.json({
      domain: result.row.domain,
      version: result.row.version,
      updatedAt: result.row.updatedAt,
    });
  },
);
