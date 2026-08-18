import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import {
  requireAdminAuth,
  requireAdminPermission,
  type AdminVariables,
} from '../../middleware/adminAuth.js';
import { getVoiceMetricsSummary } from '../../services/voiceMetrics.js';
import { getVoiceProviderStatus } from '../../services/providerCircuit.js';
import { getConcurrencySnapshot } from '../../services/concurrency.js';

export const adminVoiceMetricsRoutes = new Hono<{ Variables: AdminVariables }>();

adminVoiceMetricsRoutes.use('*', requireAdminAuth);

adminVoiceMetricsRoutes.get(
  '/',
  requireAdminPermission('dashboard:read'),
  zValidator(
    'query',
    z.object({
      hours: z.coerce.number().int().min(1).max(24 * 90).optional(),
    }),
  ),
  async (c) => {
    const { hours = 24 } = c.req.valid('query');
    c.header('Cache-Control', 'no-store');
    return c.json({
      ...(await getVoiceMetricsSummary(hours)),
      provider: getVoiceProviderStatus(),
      concurrency: getConcurrencySnapshot(),
      privacy: {
        storesText: false,
        storesAudio: false,
        subjectIdentifiersHashed: true,
      },
    });
  },
);
