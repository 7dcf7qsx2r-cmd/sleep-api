import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { requireAdminAuth, requireAdminPermission, type AdminVariables } from '../../middleware/adminAuth.js';
import { writeAdminAuditLog } from '../../modules/admin/audit.js';
import { query } from '../../db/client.js';
import { getFlags, setFlag, setUserModeDisabled } from '../../services/cbti/plans.js';
import { pushDeliveryStats } from '../../services/push.js';

export const adminCbtiRoutes = new Hono<{ Variables: AdminVariables }>();

adminCbtiRoutes.use('*', requireAdminAuth);

function requestIp(c: { req: { header: (name: string) => string | undefined } }) {
  return c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || c.req.header('x-real-ip') || undefined;
}

adminCbtiRoutes.get('/flags', requireAdminPermission('dashboard:read'), async (c) => c.json(await getFlags()));

/** 熔断：计划模式整体关闭（mode_kill_switch）或只关夜间离床提醒（leave_bed_prompts_off）。 */
adminCbtiRoutes.put(
  '/flags/:key',
  requireAdminPermission('settings:admin'),
  zValidator('param', z.object({ key: z.enum(['mode_kill_switch', 'leave_bed_prompts_off']) })),
  zValidator('json', z.object({ enabled: z.boolean() })),
  async (c) => {
    const { key } = c.req.valid('param');
    const { enabled } = c.req.valid('json');
    const before = await getFlags();
    await setFlag(key, enabled);
    await writeAdminAuditLog({
      adminUserId: c.get('adminAuth').sub,
      action: 'cbti.flag.set',
      resourceType: 'cbti_flag',
      resourceId: key,
      before,
      after: { [key]: enabled },
      ip: requestIp(c),
    });
    return c.json(await getFlags());
  },
);

adminCbtiRoutes.put(
  '/users/:userId/mode',
  requireAdminPermission('users:write'),
  zValidator('param', z.object({ userId: z.string().uuid() })),
  zValidator('json', z.object({ disabled: z.boolean() })),
  async (c) => {
    const { userId } = c.req.valid('param');
    const { disabled } = c.req.valid('json');
    const updated = await setUserModeDisabled(userId, disabled);
    if (!updated) return c.json({ error: 'no_active_plan' }, 404);
    await writeAdminAuditLog({
      adminUserId: c.get('adminAuth').sub,
      action: 'cbti.user_mode.set',
      resourceType: 'user',
      resourceId: userId,
      after: { modeDisabled: disabled },
      ip: requestIp(c),
    });
    return c.json({ ok: true });
  },
);

adminCbtiRoutes.get('/overview', requireAdminPermission('dashboard:read'), async (c) => {
  const plans = await query<{ status: string; track: string; n: string | number }>(
    `SELECT status, track, COUNT(*) AS n FROM cbti_plans GROUP BY status, track ORDER BY status, track`,
  );
  const mismatches = await query<{ n: string | number }>(
    `SELECT COUNT(*) AS n FROM cbti_settlements WHERE mismatch AND created_at >= NOW() - INTERVAL '14 days'`,
  );
  return c.json({
    plans: plans.rows.map((r) => ({ status: r.status, track: r.track, count: Number(r.n) })),
    settlementMismatches14d: Number(mismatches.rows[0]?.n ?? 0),
  });
});

adminCbtiRoutes.get(
  '/push-stats',
  requireAdminPermission('dashboard:read'),
  zValidator('query', z.object({ days: z.coerce.number().int().min(1).max(90).optional() })),
  async (c) => c.json({ stats: await pushDeliveryStats(c.req.valid('query').days ?? 14) }),
);
