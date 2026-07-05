import type { Context, Next } from 'hono';
import { verifyAdminToken, hasPermission, type AdminAuthPayload } from '../lib/adminJwt.js';
import { getAdminById } from '../modules/admin/auth.service.js';

export type AdminVariables = {
  adminAuth: AdminAuthPayload;
};

export async function requireAdminAuth(c: Context<{ Variables: AdminVariables }>, next: Next) {
  const header = c.req.header('Authorization');
  const token = header?.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) {
    return c.json({ error: 'unauthorized', message: 'Missing admin token' }, 401);
  }
  const payload = await verifyAdminToken(token);
  if (!payload) {
    return c.json({ error: 'unauthorized', message: 'Invalid or expired admin token' }, 401);
  }

  const admin = await getAdminById(payload.sub);
  if (!admin) {
    return c.json({ error: 'unauthorized', message: 'Admin account disabled' }, 401);
  }

  c.set('adminAuth', { ...payload, permissions: admin.permissions });
  await next();
}

export function requireAdminPermission(permission: string) {
  return async (c: Context<{ Variables: AdminVariables }>, next: Next) => {
    const auth = c.get('adminAuth');
    if (!hasPermission(auth.permissions, permission)) {
      return c.json({ error: 'forbidden', message: `Missing permission: ${permission}` }, 403);
    }
    await next();
  };
}
