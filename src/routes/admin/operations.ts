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
  createContentItem,
  createGrowthCampaign,
  listContentItems,
  listGrowthCampaigns,
  updateContentItem,
  updateGrowthCampaign,
} from '../../services/operations.js';

export const adminOperationRoutes = new Hono<{ Variables: AdminVariables }>();

adminOperationRoutes.use('*', requireAdminAuth);

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

const contentSchema = z.object({
  contentKey: z.string().min(1).max(120),
  placement: z.string().min(1).max(80),
  title: z.string().min(1).max(160),
  summary: z.string().max(500).default(''),
  body: z.string().max(5000).default(''),
  imageUrl: imageUrlSchema.nullable().optional(),
  actionUrl: z.string().max(500).nullable().optional(),
  status: z.enum(['draft', 'published', 'archived']).default('draft'),
  sortOrder: z.number().int().min(0).default(0),
  metadata: z.record(z.unknown()).optional(),
});

const campaignSchema = z.object({
  name: z.string().min(1).max(160),
  channel: z.string().min(1).max(80).default('in_app'),
  status: z.enum(['draft', 'active', 'paused', 'ended']).default('draft'),
  goal: z.string().max(500).default(''),
  budgetRmb: z.number().min(0).default(0),
  startsAt: z.string().datetime().nullable().optional(),
  endsAt: z.string().datetime().nullable().optional(),
  config: z.record(z.unknown()).optional(),
});

adminOperationRoutes.get('/contents', requireAdminPermission('content:read'), async (c) => {
  return c.json({ items: await listContentItems({ includeArchived: true }) });
});

adminOperationRoutes.post(
  '/contents',
  requireAdminPermission('content:write'),
  zValidator('json', contentSchema),
  async (c) => {
    const auth = c.get('adminAuth');
    const item = await createContentItem(c.req.valid('json'));
    await writeAdminAuditLog({
      adminUserId: auth.sub,
      action: 'content.create',
      resourceType: 'content',
      resourceId: item.id,
      after: item,
      ip: requestIp(c),
    });
    return c.json(item, 201);
  },
);

adminOperationRoutes.patch(
  '/contents/:id',
  requireAdminPermission('content:write'),
  zValidator('json', contentSchema),
  async (c) => {
    const id = c.req.param('id');
    if (!id) return c.json({ error: 'bad_request' }, 400);
    const result = await updateContentItem(id, c.req.valid('json'));
    if (!result) return c.json({ error: 'not_found', message: '内容不存在' }, 404);
    const auth = c.get('adminAuth');
    await writeAdminAuditLog({
      adminUserId: auth.sub,
      action: 'content.update',
      resourceType: 'content',
      resourceId: id,
      before: result.before,
      after: result.after,
      ip: requestIp(c),
    });
    return c.json(result.after);
  },
);

adminOperationRoutes.get('/campaigns', requireAdminPermission('growth:read'), async (c) => {
  return c.json({ items: await listGrowthCampaigns() });
});

adminOperationRoutes.post(
  '/campaigns',
  requireAdminPermission('growth:write'),
  zValidator('json', campaignSchema),
  async (c) => {
    const auth = c.get('adminAuth');
    const campaign = await createGrowthCampaign(c.req.valid('json'));
    await writeAdminAuditLog({
      adminUserId: auth.sub,
      action: 'growth.create',
      resourceType: 'growth_campaign',
      resourceId: campaign.id,
      after: campaign,
      ip: requestIp(c),
    });
    return c.json(campaign, 201);
  },
);

adminOperationRoutes.patch(
  '/campaigns/:id',
  requireAdminPermission('growth:write'),
  zValidator('json', campaignSchema),
  async (c) => {
    const id = c.req.param('id');
    if (!id) return c.json({ error: 'bad_request' }, 400);
    const result = await updateGrowthCampaign(id, c.req.valid('json'));
    if (!result) return c.json({ error: 'not_found', message: '活动不存在' }, 404);
    const auth = c.get('adminAuth');
    await writeAdminAuditLog({
      adminUserId: auth.sub,
      action: 'growth.update',
      resourceType: 'growth_campaign',
      resourceId: id,
      before: result.before,
      after: result.after,
      ip: requestIp(c),
    });
    return c.json(result.after);
  },
);
