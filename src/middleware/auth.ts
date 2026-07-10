import type { Context, Next } from 'hono';
import { verifyToken, type AuthPayload } from '../lib/jwt.js';
import { query } from '../db/client.js';

export type AuthVariables = {
  auth: AuthPayload;
};

async function getUserStatus(userId: string): Promise<string | null> {
  const result = await query<{ status: string }>(
    `SELECT status FROM users WHERE id = $1 AND deleted_at IS NULL`,
    [userId],
  );
  return result.rows[0]?.status ?? null;
}

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
  if (payload.type === 'user') {
    const status = await getUserStatus(payload.sub);
    if (!status) {
      return c.json({ error: 'unauthorized', message: '用户不存在或已注销' }, 401);
    }
    if (status !== 'active') {
      return c.json({ error: 'user_banned', message: '账号已被封禁，请联系客服' }, 403);
    }
  }
  c.set('auth', payload);
  await next();
}
