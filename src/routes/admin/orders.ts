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
  getOrderDetailForAdmin,
  listOrdersForAdmin,
  updateOrderStatusForAdmin,
} from '../../services/shop.js';

export const adminOrderRoutes = new Hono<{ Variables: AdminVariables }>();

adminOrderRoutes.use('*', requireAdminAuth);

function requestIp(c: { req: { header: (name: string) => string | undefined } }) {
  return c.req.header('x-forwarded-for') ?? c.req.header('x-real-ip');
}

adminOrderRoutes.get(
  '/',
  requireAdminPermission('orders:read'),
  zValidator(
    'query',
    z.object({
      q: z.string().optional(),
      status: z.enum(['pending', 'completed', 'cancelled', 'refunded']).optional(),
      paymentMethod: z.string().optional(),
      page: z.coerce.number().int().min(1).optional(),
      pageSize: z.coerce.number().int().min(1).max(100).optional(),
    }),
  ),
  async (c) => {
    const q = c.req.valid('query');
    const result = await listOrdersForAdmin({
      q: q.q,
      status: q.status,
      paymentMethod: q.paymentMethod,
      page: q.page ?? 1,
      pageSize: q.pageSize ?? 20,
    });
    return c.json(result);
  },
);

adminOrderRoutes.get(
  '/:id',
  requireAdminPermission('orders:read'),
  async (c) => {
    const orderId = c.req.param('id');
    if (!orderId) return c.json({ error: 'bad_request' }, 400);
    const detail = await getOrderDetailForAdmin(orderId);
    if (!detail) return c.json({ error: 'not_found', message: '订单不存在' }, 404);
    return c.json(detail);
  },
);

adminOrderRoutes.post(
  '/:id/status',
  requireAdminPermission('orders:refund'),
  zValidator(
    'json',
    z.object({
      status: z.enum(['pending', 'completed', 'cancelled', 'refunded']),
      note: z.string().max(500).optional(),
    }),
  ),
  async (c) => {
    const auth = c.get('adminAuth');
    const body = c.req.valid('json');
    const orderId = c.req.param('id');
    if (!orderId) return c.json({ error: 'bad_request' }, 400);
    const result = await updateOrderStatusForAdmin({
      orderId,
      status: body.status,
      note: body.note,
      adminUserId: auth.sub,
    });
    if (!result) return c.json({ error: 'not_found', message: '订单不存在' }, 404);
    await writeAdminAuditLog({
      adminUserId: auth.sub,
      action: `order.${body.status}`,
      resourceType: 'order',
      resourceId: orderId,
      before: result.before,
      after: result.after,
      ip: requestIp(c),
    });
    const detail = await getOrderDetailForAdmin(orderId);
    return c.json(detail);
  },
);
