import { query } from '../../db/client.js';

export async function writeAdminAuditLog(params: {
  adminUserId: string | null;
  action: string;
  resourceType: string;
  resourceId?: string;
  before?: unknown;
  after?: unknown;
  ip?: string;
}): Promise<void> {
  await query(
    `INSERT INTO admin_audit_logs
      (admin_user_id, action, resource_type, resource_id, before_json, after_json, ip)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      params.adminUserId,
      params.action,
      params.resourceType,
      params.resourceId ?? null,
      params.before != null ? JSON.stringify(params.before) : null,
      params.after != null ? JSON.stringify(params.after) : null,
      params.ip ?? null,
    ],
  );
}
