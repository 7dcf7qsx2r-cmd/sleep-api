import { Hono } from 'hono';
import { listContentItems } from '../services/operations.js';

export const contentRoutes = new Hono();

contentRoutes.get('/', async (c) => {
  const placement = c.req.query('placement');
  const items = await listContentItems({ placement, publishedOnly: true });
  return c.json({ items });
});
