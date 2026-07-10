import { Hono } from 'hono';
import { listExperts, getExpert } from '../services/experts.js';

export const expertRoutes = new Hono();

expertRoutes.get('/', async (c) => {
  return c.json({ experts: await listExperts() });
});

expertRoutes.get('/:id', async (c) => {
  const expertId = c.req.param('id');
  if (!expertId) return c.json({ error: 'bad_request' }, 400);
  const expert = await getExpert(expertId);
  if (!expert) return c.json({ error: 'not_found', message: '专家不存在或未上架' }, 404);
  return c.json(expert);
});
