import { SignJWT, jwtVerify } from 'jose';
import { config } from '../config.js';

export type SubjectType = 'guest' | 'user';

export interface AuthPayload {
  sub: string;
  type: SubjectType;
}

const secret = new TextEncoder().encode(config.jwtSecret);

export async function signToken(payload: AuthPayload): Promise<string> {
  return new SignJWT({ type: payload.type })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(payload.sub)
    .setIssuedAt()
    .setExpirationTime(config.jwtExpiresIn)
    .sign(secret);
}

export async function verifyToken(token: string): Promise<AuthPayload | null> {
  try {
    const { payload } = await jwtVerify(token, secret);
    const sub = payload.sub;
    const type = payload.type as SubjectType | undefined;
    if (!sub || type !== 'guest' && type !== 'user') return null;
    return { sub, type };
  } catch {
    return null;
  }
}
