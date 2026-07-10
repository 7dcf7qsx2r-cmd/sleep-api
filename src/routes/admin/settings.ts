import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import {
  requireAdminAuth,
  requireAdminPermission,
  type AdminVariables,
} from '../../middleware/adminAuth.js';
import { writeAdminAuditLog, listAdminAuditLogs } from '../../modules/admin/audit.js';
import {
  ADMIN_PERMISSIONS,
  createAdminRole,
  createAdminUser,
  listAdminRoles,
  listAdminUsers,
  updateAdminRole,
  updateAdminUser,
} from '../../modules/admin/settings.service.js';

export const adminSettingsRoutes = new Hono<{ Variables: AdminVariables }>();

adminSettingsRoutes.use('*', requireAdminAuth);

function requestIp(c: { req: { header: (name: string) => string | undefined } }) {
  return c.req.header('x-forwarded-for') ?? c.req.header('x-real-ip');
}

const permissionsSchema = z.array(z.string().min(1)).default([]);

adminSettingsRoutes.get('/permissions', requireAdminPermission('settings:admin'), async (c) => {
  return c.json({ permissions: ADMIN_PERMISSIONS });
});

adminSettingsRoutes.get('/roles', requireAdminPermission('settings:admin'), async (c) => {
  return c.json({ items: await listAdminRoles() });
});

adminSettingsRoutes.post(
  '/roles',
  requireAdminPermission('settings:admin'),
  zValidator(
    'json',
    z.object({
      name: z.string().min(2).max(64),
      permissions: permissionsSchema,
    }),
  ),
  async (c) => {
    const body = c.req.valid('json');
    const role = await createAdminRole(body);
    const auth = c.get('adminAuth');
    await writeAdminAuditLog({
      adminUserId: auth.sub,
      action: 'admin.role.create',
      resourceType: 'admin_role',
      resourceId: role.id,
      after: role,
      ip: requestIp(c),
    });
    return c.json(role, 201);
  },
);

adminSettingsRoutes.patch(
  '/roles/:id',
  requireAdminPermission('settings:admin'),
  zValidator(
    'json',
    z.object({
      name: z.string().min(2).max(64),
      permissions: permissionsSchema,
    }),
  ),
  async (c) => {
    const roleId = c.req.param('id');
    const body = c.req.valid('json');
    const result = await updateAdminRole(roleId, body);
    if (!result) return c.json({ error: 'not_found', message: '角色不存在' }, 404);
    const auth = c.get('adminAuth');
    await writeAdminAuditLog({
      adminUserId: auth.sub,
      action: 'admin.role.update',
      resourceType: 'admin_role',
      resourceId: roleId,
      before: result.before,
      after: result.after,
      ip: requestIp(c),
    });
    return c.json(result.after);
  },
);

adminSettingsRoutes.get('/admin-users', requireAdminPermission('settings:admin'), async (c) => {
  return c.json({ items: await listAdminUsers() });
});

adminSettingsRoutes.post(
  '/admin-users',
  requireAdminPermission('settings:admin'),
  zValidator(
    'json',
    z.object({
      username: z.string().min(2).max(64),
      password: z.string().min(8).max(128),
      displayName: z.string().max(64).default(''),
      roleId: z.string().uuid(),
    }),
  ),
  async (c) => {
    const body = c.req.valid('json');
    const adminUser = await createAdminUser(body);
    if (!adminUser) return c.json({ error: 'create_failed' }, 400);
    const auth = c.get('adminAuth');
    await writeAdminAuditLog({
      adminUserId: auth.sub,
      action: 'admin.user.create',
      resourceType: 'admin_user',
      resourceId: adminUser.id,
      after: adminUser,
      ip: requestIp(c),
    });
    return c.json(adminUser, 201);
  },
);

adminSettingsRoutes.patch(
  '/admin-users/:id',
  requireAdminPermission('settings:admin'),
  zValidator(
    'json',
    z.object({
      displayName: z.string().max(64).default(''),
      roleId: z.string().uuid(),
      status: z.enum(['active', 'disabled']),
      password: z.string().min(8).max(128).optional(),
    }),
  ),
  async (c) => {
    const adminUserId = c.req.param('id');
    const auth = c.get('adminAuth');
    if (adminUserId === auth.sub && c.req.valid('json').status === 'disabled') {
      return c.json({ error: 'cannot_disable_self', message: '不能禁用当前登录管理员' }, 400);
    }
    const result = await updateAdminUser(adminUserId, c.req.valid('json'));
    if (!result) return c.json({ error: 'not_found', message: '管理员不存在' }, 404);
    await writeAdminAuditLog({
      adminUserId: auth.sub,
      action: 'admin.user.update',
      resourceType: 'admin_user',
      resourceId: adminUserId,
      before: result.before,
      after: result.after,
      ip: requestIp(c),
    });
    return c.json(result.after);
  },
);

adminSettingsRoutes.get(
  '/audit-logs',
  requireAdminPermission('audit:read'),
  zValidator(
    'query',
    z.object({
      adminUserId: z.string().uuid().optional(),
      action: z.string().optional(),
      resourceType: z.string().optional(),
      resourceId: z.string().optional(),
      page: z.coerce.number().int().min(1).optional(),
      pageSize: z.coerce.number().int().min(1).max(100).optional(),
    }),
  ),
  async (c) => {
    const q = c.req.valid('query');
    const result = await listAdminAuditLogs({
      ...q,
      page: q.page ?? 1,
      pageSize: q.pageSize ?? 20,
    });
    return c.json(result);
  },
);
