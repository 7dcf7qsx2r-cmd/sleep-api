import type { Context, Next } from 'hono';
import { verifyToken, type AuthPayload } from '../lib/jwt.js';

export type AuthVariables = {
  auth: AuthPayload;
};

export async function requireAuth(c: Context<{ Variables: AuthVariables }>, next: Next) {
  const header = c.req.header('Authorization');
  const token = header?.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) {
    return c.json({ error: 'unauthorized', message: 'Missing Bearer token' }, 401);
  }
  const payload = await verifyToken(token);
  if (!payload) {
    return c.json({ error: 'unauthorized', message: 'Invalid or expired token' }, 401);
  }
  c.set('auth', payload);
  await next();
}
