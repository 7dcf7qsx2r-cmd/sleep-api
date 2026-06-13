import type { AuthPayload } from './jwt.js';

export type OwnerType = 'guest' | 'user';

export interface OwnerRef {
  ownerType: OwnerType;
  ownerId: string;
}

export function ownerFromAuth(auth: AuthPayload): OwnerRef {
  return { ownerType: auth.type, ownerId: auth.sub };
}
