import { SignJWT, jwtVerify } from 'jose';
import { config } from '../config.js';

export interface AdminAuthPayload {
  sub: string;
  type: 'admin';
  role: string;
  permissions: string[];
}

const secret = new TextEncoder().encode(config.jwtSecret);

export async function signAdminToken(payload: Omit<AdminAuthPayload, 'type'>): Promise<string> {
  return new SignJWT({
    type: 'admin',
    role: payload.role,
    permissions: payload.permissions,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(payload.sub)
    .setIssuedAt()
    .setExpirationTime('8h')
    .sign(secret);
}

export async function verifyAdminToken(token: string): Promise<AdminAuthPayload | null> {
  try {
    const { payload } = await jwtVerify(token, secret);
    const sub = payload.sub;
    const type = payload.type;
    if (!sub || type !== 'admin') return null;
    const role = typeof payload.role === 'string' ? payload.role : '';
    const permissions = Array.isArray(payload.permissions)
      ? payload.permissions.filter((p): p is string => typeof p === 'string')
      : [];
    return { sub, type: 'admin', role, permissions };
  } catch {
    return null;
  }
}

export function hasPermission(permissions: string[], required: string): boolean {
  if (permissions.includes('*')) return true;
  return permissions.includes(required);
}
