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
  createProduct,
  listProducts,
  setProductStatus,
  updateProduct,
} from '../../services/shop.js';

export const adminProductRoutes = new Hono<{ Variables: AdminVariables }>();

adminProductRoutes.use('*', requireAdminAuth);

function requestIp(c: { req: { header: (name: string) => string | undefined } }) {
  return c.req.header('x-forwarded-for') ?? c.req.header('x-real-ip');
}

const productCategorySchema = z.enum(['recommend', 'sleep', 'wellness', 'beauty', 'energy']);

const productSchema = z.object({
  id: z.string().min(1).max(64).optional(),
  category: productCategorySchema.default('recommend'),
  icon: z.string().max(32).default(''),
  name: z.string().min(1).max(120),
  summary: z.string().max(200).default(''),
  description: z.string().max(1000).default(''),
  aiReason: z.string().max(1000).default(''),
  shopName: z.string().max(120).default('小眠官方'),
  imageSlides: z.array(z.string().max(500)).default([]),
  details: z.array(z.string().max(200)).default([]),
  energyPrice: z.number().int().min(0),
  originalEnergyPrice: z.number().int().min(0),
  rmbPrice: z.number().min(0),
  originalRmbPrice: z.number().min(0),
  stock: z.number().int().min(0).nullable().optional(),
  status: z.enum(['draft', 'published', 'archived']).default('draft'),
  sortOrder: z.number().int().min(0).default(0),
});

adminProductRoutes.get(
  '/',
  requireAdminPermission('products:read'),
  async (c) => {
    const products = await listProducts({ includeArchived: true });
    return c.json({ items: products });
  },
);

adminProductRoutes.post(
  '/',
  requireAdminPermission('products:write'),
  zValidator('json', productSchema),
  async (c) => {
    const body = c.req.valid('json');
    const product = await createProduct(body);
    const auth = c.get('adminAuth');
    await writeAdminAuditLog({
      adminUserId: auth.sub,
      action: 'product.create',
      resourceType: 'product',
      resourceId: product.id,
      after: product,
      ip: requestIp(c),
    });
    return c.json(product, 201);
  },
);

adminProductRoutes.patch(
  '/:id',
  requireAdminPermission('products:write'),
  zValidator('json', productSchema.omit({ id: true })),
  async (c) => {
    const productId = c.req.param('id');
    const result = await updateProduct(productId, c.req.valid('json'));
    if (!result) return c.json({ error: 'not_found', message: '商品不存在' }, 404);
    const auth = c.get('adminAuth');
    await writeAdminAuditLog({
      adminUserId: auth.sub,
      action: 'product.update',
      resourceType: 'product',
      resourceId: productId,
      before: result.before,
      after: result.after,
      ip: requestIp(c),
    });
    return c.json(result.after);
  },
);

adminProductRoutes.post(
  '/:id/status',
  requireAdminPermission('products:publish'),
  zValidator('json', z.object({ status: z.enum(['draft', 'published', 'archived']) })),
  async (c) => {
    const productId = c.req.param('id');
    const { status } = c.req.valid('json');
    const result = await setProductStatus(productId, status);
    if (!result) return c.json({ error: 'not_found', message: '商品不存在' }, 404);
    const auth = c.get('adminAuth');
    await writeAdminAuditLog({
      adminUserId: auth.sub,
      action: `product.${status}`,
      resourceType: 'product',
      resourceId: productId,
      before: result.before,
      after: result.after,
      ip: requestIp(c),
    });
    return c.json(result.after);
  },
);
