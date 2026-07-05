import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { loginAdmin, getAdminById } from '../../modules/admin/auth.service.js';
import { requireAdminAuth, type AdminVariables } from '../../middleware/adminAuth.js';

export const adminAuthRoutes = new Hono<{ Variables: AdminVariables }>();

adminAuthRoutes.post(
  '/login',
  zValidator(
    'json',
    z.object({
      username: z.string().min(1),
      password: z.string().min(1),
    }),
  ),
  async (c) => {
    const { username, password } = c.req.valid('json');
    const session = await loginAdmin(username, password);
    if (!session) {
      return c.json({ error: 'invalid_credentials', message: '用户名或密码错误' }, 401);
    }
    return c.json(session);
  },
);

adminAuthRoutes.get('/me', requireAdminAuth, async (c) => {
  const auth = c.get('adminAuth');
  const admin = await getAdminById(auth.sub);
  if (!admin) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  return c.json({ admin });
});
