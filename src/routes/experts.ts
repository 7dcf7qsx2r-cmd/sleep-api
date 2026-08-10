import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { listExperts, getExpert } from '../services/experts.js';
import { requireAuth, type AuthVariables } from '../middleware/auth.js';
import {
  createExpertConsultation,
  getUserExpertConsultation,
  listUserExpertConsultations,
} from '../services/expertConsultations.js';

export const expertRoutes = new Hono();

const consultationRoutes = new Hono<{ Variables: AuthVariables }>();
consultationRoutes.use('*', requireAuth);

function requireUserId(c: { get: (key: 'auth') => { sub: string; type: string } }) {
  const auth = c.get('auth');
  if (auth.type !== 'user') return null;
  return auth.sub;
}

const createConsultationSchema = z.object({
  expertId: z.string().uuid(),
  question: z.string().trim().min(10, '请至少描述 10 个字的睡眠困扰').max(2000),
  preferredTime: z.string().trim().min(2, '请选择期望联系时段').max(120),
  privacyConsent: z.literal(true, {
    errorMap: () => ({ message: '需同意隐私说明后才能提交' }),
  }),
});

consultationRoutes.post(
  '/',
  zValidator('json', createConsultationSchema),
  async (c) => {
    const userId = requireUserId(c);
    if (!userId) {
      return c.json({ error: 'guest_forbidden', message: '登录后可预约专家咨询' }, 403);
    }

    const body = c.req.valid('json');
    const consultation = await createExpertConsultation({
      userId,
      expertId: body.expertId,
      question: body.question,
      preferredTime: body.preferredTime,
      privacyConsent: body.privacyConsent,
    });
    if (!consultation) {
      return c.json({ error: 'not_found', message: '专家不存在或未上架' }, 404);
    }
    return c.json({ consultation }, 201);
  },
);

consultationRoutes.get('/', async (c) => {
  const userId = requireUserId(c);
  if (!userId) {
    return c.json({ error: 'guest_forbidden', message: '登录后可查看咨询记录' }, 403);
  }
  const consultations = await listUserExpertConsultations(userId);
  return c.json({ consultations });
});

consultationRoutes.get('/:id', async (c) => {
  const userId = requireUserId(c);
  if (!userId) {
    return c.json({ error: 'guest_forbidden', message: '登录后可查看咨询记录' }, 403);
  }
  const consultationId = c.req.param('id');
  const consultation = await getUserExpertConsultation(userId, consultationId);
  if (!consultation) {
    return c.json({ error: 'not_found', message: '咨询记录不存在' }, 404);
  }
  return c.json({ consultation });
});

expertRoutes.get('/', async (c) => {
  return c.json({ experts: await listExperts() });
});

expertRoutes.route('/consultations', consultationRoutes);

expertRoutes.get('/:id', async (c) => {
  const expertId = c.req.param('id');
  if (!expertId) return c.json({ error: 'bad_request' }, 400);
  const expert = await getExpert(expertId);
  if (!expert) return c.json({ error: 'not_found', message: '专家不存在或未上架' }, 404);
  return c.json(expert);
});
