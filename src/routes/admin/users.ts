import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import {
  requireAdminAuth,
  requireAdminPermission,
  type AdminVariables,
} from '../../middleware/adminAuth.js';
import { writeAdminAuditLog } from '../../modules/admin/audit.js';
import {
  listUsersForAdmin,
  getUserDetailForAdmin,
  setUserStatusForAdmin,
  getUserStatsSummary,
} from '../../modules/identity/service.js';

export const adminUserRoutes = new Hono<{ Variables: AdminVariables }>();

adminUserRoutes.use('*', requireAdminAuth);

adminUserRoutes.get(
  '/stats',
  requireAdminPermission('users:read'),
  async (c) => {
    const stats = await getUserStatsSummary();
    return c.json(stats);
  },
);

adminUserRoutes.get(
  '/',
  requireAdminPermission('users:read'),
  zValidator(
    'query',
    z.object({
      q: z.string().optional(),
      status: z.enum(['active', 'banned']).optional(),
      registerVia: z.enum(['phone', 'wechat', 'password']).optional(),
      page: z.coerce.number().int().min(1).optional(),
      pageSize: z.coerce.number().int().min(1).max(100).optional(),
    }),
  ),
  async (c) => {
    const q = c.req.valid('query');
    const result = await listUsersForAdmin({
      q: q.q,
      status: q.status,
      registerVia: q.registerVia,
      page: q.page ?? 1,
      pageSize: q.pageSize ?? 20,
    });
    return c.json(result);
  },
);

adminUserRoutes.get(
  '/:id',
  requireAdminPermission('users:read'),
  async (c) => {
    const userId = c.req.param('id');
    if (!userId) return c.json({ error: 'bad_request' }, 400);
    const detail = await getUserDetailForAdmin(userId);
    if (!detail) {
      return c.json({ error: 'not_found', message: '用户不存在' }, 404);
    }
    return c.json(detail);
  },
);

adminUserRoutes.patch(
  '/:id/status',
  requireAdminPermission('users:write'),
  zValidator(
    'json',
    z.object({
      status: z.enum(['active', 'banned']),
      reason: z.string().max(500).optional(),
    }),
  ),
  async (c) => {
    const userId = c.req.param('id');
    if (!userId) return c.json({ error: 'bad_request' }, 400);
    const body = c.req.valid('json');
    const result = await setUserStatusForAdmin(userId, body.status, body.reason);
    if (!result) {
      return c.json({ error: 'not_found', message: '用户不存在' }, 404);
    }

    const auth = c.get('adminAuth');
    await writeAdminAuditLog({
      adminUserId: auth.sub,
      action: body.status === 'banned' ? 'user.ban' : 'user.unban',
      resourceType: 'user',
      resourceId: userId,
      before: { status: result.before },
      after: { status: result.after, reason: body.reason ?? null },
      ip: c.req.header('x-forwarded-for') ?? c.req.header('x-real-ip'),
    });

    const detail = await getUserDetailForAdmin(userId);
    return c.json(detail);
  },
);
