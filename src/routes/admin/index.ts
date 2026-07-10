import { Hono } from 'hono';
import { adminAuthRoutes } from './auth.js';
import { adminUserRoutes } from './users.js';
import { adminSettingsRoutes } from './settings.js';
import { adminProductRoutes } from './products.js';
import { adminOrderRoutes } from './orders.js';
import { adminExpertRoutes } from './experts.js';
import { adminOperationRoutes } from './operations.js';
import { adminUploadRoutes } from './uploads.js';

export const adminRoutes = new Hono();

adminRoutes.get('/health', (c) => c.json({ ok: true, app: 'sleep-admin-api' }));

adminRoutes.route('/auth', adminAuthRoutes);
adminRoutes.route('/users', adminUserRoutes);
adminRoutes.route('/products', adminProductRoutes);
adminRoutes.route('/orders', adminOrderRoutes);
adminRoutes.route('/experts', adminExpertRoutes);
adminRoutes.route('/operations', adminOperationRoutes);
adminRoutes.route('/uploads', adminUploadRoutes);
adminRoutes.route('/', adminSettingsRoutes);
