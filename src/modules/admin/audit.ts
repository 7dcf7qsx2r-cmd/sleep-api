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

interface AdminAuditLogRow {
  id: string;
  admin_user_id: string | null;
  admin_username: string | null;
  admin_display_name: string | null;
  action: string;
  resource_type: string;
  resource_id: string | null;
  before_json: unknown;
  after_json: unknown;
  ip: string | null;
  created_at: Date;
}

export async function listAdminAuditLogs(params: {
  adminUserId?: string;
  action?: string;
  resourceType?: string;
  resourceId?: string;
  page: number;
  pageSize: number;
}) {
  const page = Math.max(1, params.page);
  const pageSize = Math.min(100, Math.max(1, params.pageSize));
  const where: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  if (params.adminUserId) {
    where.push(`l.admin_user_id = $${idx++}`);
    values.push(params.adminUserId);
  }
  if (params.action) {
    where.push(`l.action ILIKE $${idx++}`);
    values.push(`%${params.action}%`);
  }
  if (params.resourceType) {
    where.push(`l.resource_type = $${idx++}`);
    values.push(params.resourceType);
  }
  if (params.resourceId) {
    where.push(`l.resource_id = $${idx++}`);
    values.push(params.resourceId);
  }

  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const countResult = await query<{ count: string }>(
    `SELECT COUNT(*)::text AS count
     FROM admin_audit_logs l
     ${whereSql}`,
    values,
  );

  const limitIdx = idx++;
  const offsetIdx = idx;
  const result = await query<AdminAuditLogRow>(
    `SELECT l.id, l.admin_user_id, au.username AS admin_username,
            au.display_name AS admin_display_name, l.action, l.resource_type,
            l.resource_id, l.before_json, l.after_json, l.ip, l.created_at
     FROM admin_audit_logs l
     LEFT JOIN admin_users au ON au.id = l.admin_user_id
     ${whereSql}
     ORDER BY l.created_at DESC
     LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
    [...values, pageSize, (page - 1) * pageSize],
  );

  return {
    items: result.rows.map((row) => ({
      id: row.id,
      adminUserId: row.admin_user_id,
      adminUsername: row.admin_username,
      adminDisplayName: row.admin_display_name,
      action: row.action,
      resourceType: row.resource_type,
      resourceId: row.resource_id,
      before: row.before_json,
      after: row.after_json,
      ip: row.ip,
      createdAt: row.created_at.toISOString(),
    })),
    total: Number.parseInt(countResult.rows[0]?.count ?? '0', 10),
    page,
    pageSize,
  };
}
