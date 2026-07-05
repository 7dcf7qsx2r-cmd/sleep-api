import { Hono } from 'hono';
import { adminAuthRoutes } from './auth.js';
import { adminUserRoutes } from './users.js';

export const adminRoutes = new Hono();

adminRoutes.route('/auth', adminAuthRoutes);
adminRoutes.route('/users', adminUserRoutes);

adminRoutes.get('/health', (c) => c.json({ ok: true, app: 'sleep-admin-api' }));
