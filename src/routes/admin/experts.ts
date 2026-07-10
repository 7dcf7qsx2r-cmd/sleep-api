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
  createExpert,
  createExpertCredential,
  getExpert,
  listExperts,
  reviewExpertCredential,
  setExpertStatus,
  updateExpert,
} from '../../services/experts.js';

export const adminExpertRoutes = new Hono<{ Variables: AdminVariables }>();

adminExpertRoutes.use('*', requireAdminAuth);

function requestIp(c: { req: { header: (name: string) => string | undefined } }) {
  return c.req.header('x-forwarded-for') ?? c.req.header('x-real-ip');
}

const imageUrlSchema = z.string().max(500).refine((value) => {
  if (value.startsWith('/uploads/')) return true;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}, '请输入有效图片 URL');

const expertSchema = z.object({
  name: z.string().min(1).max(80),
  title: z.string().max(120).default(''),
  avatarUrl: imageUrlSchema.nullable().optional(),
  bio: z.string().max(2000).default(''),
  tags: z.array(z.string().max(40)).default([]),
  serviceMethods: z.array(z.string().max(40)).default([]),
  priceRmb: z.number().min(0).default(0),
  sortOrder: z.number().int().min(0).default(0),
  status: z.enum(['pending_review', 'published', 'archived']).default('pending_review'),
  reviewNote: z.string().max(500).nullable().optional(),
});

adminExpertRoutes.get('/', requireAdminPermission('experts:read'), async (c) => {
  return c.json({ items: await listExperts({ includeArchived: true }) });
});

adminExpertRoutes.get('/:id', requireAdminPermission('experts:read'), async (c) => {
  const expertId = c.req.param('id');
  if (!expertId) return c.json({ error: 'bad_request' }, 400);
  const detail = await getExpert(expertId, { includeUnpublished: true });
  if (!detail) return c.json({ error: 'not_found', message: '专家不存在' }, 404);
  return c.json(detail);
});

adminExpertRoutes.post(
  '/',
  requireAdminPermission('experts:write'),
  zValidator('json', expertSchema),
  async (c) => {
    const expert = await createExpert(c.req.valid('json'));
    const auth = c.get('adminAuth');
    await writeAdminAuditLog({
      adminUserId: auth.sub,
      action: 'expert.create',
      resourceType: 'expert',
      resourceId: expert.id,
      after: expert,
      ip: requestIp(c),
    });
    return c.json(expert, 201);
  },
);

adminExpertRoutes.patch(
  '/:id',
  requireAdminPermission('experts:write'),
  zValidator('json', expertSchema),
  async (c) => {
    const expertId = c.req.param('id');
    if (!expertId) return c.json({ error: 'bad_request' }, 400);
    const result = await updateExpert(expertId, c.req.valid('json'));
    if (!result) return c.json({ error: 'not_found', message: '专家不存在' }, 404);
    const auth = c.get('adminAuth');
    await writeAdminAuditLog({
      adminUserId: auth.sub,
      action: 'expert.update',
      resourceType: 'expert',
      resourceId: expertId,
      before: result.before,
      after: result.after,
      ip: requestIp(c),
    });
    return c.json(result.after);
  },
);

adminExpertRoutes.post(
  '/:id/status',
  requireAdminPermission('experts:review'),
  zValidator('json', z.object({
    status: z.enum(['pending_review', 'published', 'archived']),
    reviewNote: z.string().max(500).optional(),
  })),
  async (c) => {
    const expertId = c.req.param('id');
    if (!expertId) return c.json({ error: 'bad_request' }, 400);
    const body = c.req.valid('json');
    const result = await setExpertStatus(expertId, body.status, body.reviewNote);
    if (!result) return c.json({ error: 'not_found', message: '专家不存在' }, 404);
    const auth = c.get('adminAuth');
    await writeAdminAuditLog({
      adminUserId: auth.sub,
      action: `expert.${body.status}`,
      resourceType: 'expert',
      resourceId: expertId,
      before: result.before,
      after: result.after,
      ip: requestIp(c),
    });
    return c.json(result.after);
  },
);

adminExpertRoutes.post(
  '/:id/credentials',
  requireAdminPermission('experts:write'),
  zValidator('json', z.object({
    name: z.string().min(1).max(120),
    imageUrl: imageUrlSchema.nullable().optional(),
  })),
  async (c) => {
    const expertId = c.req.param('id');
    if (!expertId) return c.json({ error: 'bad_request' }, 400);
    const credential = await createExpertCredential({ expertId, ...c.req.valid('json') });
    return c.json(credential, 201);
  },
);

adminExpertRoutes.post(
  '/credentials/:id/review',
  requireAdminPermission('experts:review'),
  zValidator('json', z.object({
    status: z.enum(['pending', 'approved', 'rejected']),
    reviewNote: z.string().max(500).optional(),
  })),
  async (c) => {
    const credentialId = c.req.param('id');
    if (!credentialId) return c.json({ error: 'bad_request' }, 400);
    const result = await reviewExpertCredential({ credentialId, ...c.req.valid('json') });
    if (!result) return c.json({ error: 'not_found', message: '资质不存在' }, 404);
    const auth = c.get('adminAuth');
    await writeAdminAuditLog({
      adminUserId: auth.sub,
      action: `expert.credential.${result.after.status}`,
      resourceType: 'expert_credential',
      resourceId: credentialId,
      before: result.before,
      after: result.after,
      ip: requestIp(c),
    });
    return c.json(result.after);
  },
);
