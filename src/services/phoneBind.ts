import { query, withTransaction } from '../db/client.js';
import { maskPhone } from '../lib/phone.js';
import { fillEmptyBlobsFromUserToUser } from './dataBlob.js';
import { absorbEnergyFromUser, ensureEnergyAccount } from './energy.js';

export type OtherAccountPreview = {
  nickname: string;
  phoneMasked: string;
  createdAt: string;
  hasWeChat: boolean;
};

export type BindPhoneResult =
  | { ok: true; status: 'bound' | 'already_bound' | 'merged'; phoneMasked: string; mergedFromUserId?: string }
  | { ok: false; error: 'already_bound_other'; message: string; phoneMasked: string }
  | { ok: false; error: 'phone_taken'; message: string; needsMerge: true; otherAccount: OtherAccountPreview }
  | { ok: false; error: 'phone_bound_to_wechat'; message: string }
  | { ok: false; error: 'phone_account_banned'; message: string }
  | { ok: false; error: 'not_found'; message: string };

type OccupyingUser = {
  id: string;
  phone: string;
  status: string;
  wechat_openid: string | null;
  created_at: Date;
  nickname: string | null;
};

function previewOf(row: OccupyingUser): OtherAccountPreview {
  return {
    nickname: row.nickname?.trim() || '小眠用户',
    phoneMasked: maskPhone(row.phone),
    createdAt: row.created_at.toISOString(),
    hasWeChat: Boolean(row.wechat_openid),
  };
}

async function findOccupyingUser(phone: string): Promise<OccupyingUser | null> {
  const row = await query<OccupyingUser>(
    `SELECT u.id, u.phone, u.status, u.wechat_openid, u.created_at, p.nickname
     FROM users u
     LEFT JOIN user_profiles p ON p.user_id = u.id
     WHERE u.phone = $1 AND u.deleted_at IS NULL
     LIMIT 1`,
    [phone],
  );
  return row.rows[0] ?? null;
}

export async function bindPhoneToUser(params: {
  userId: string;
  phone: string;
  confirmMerge?: boolean;
}): Promise<BindPhoneResult> {
  const { userId, phone, confirmMerge = false } = params;
  const phoneMasked = maskPhone(phone);

  const current = await query<{
    id: string;
    phone: string | null;
    status: string;
    wechat_openid: string | null;
  }>(
    `SELECT id, phone, status, wechat_openid FROM users
     WHERE id = $1 AND deleted_at IS NULL`,
    [userId],
  );
  const me = current.rows[0];
  if (!me) {
    return { ok: false, error: 'not_found', message: '账号不存在' };
  }
  if (me.status && me.status !== 'active') {
    return { ok: false, error: 'phone_account_banned', message: '账号已被封禁，请联系客服' };
  }

  if (me.phone === phone) {
    return { ok: true, status: 'already_bound', phoneMasked };
  }
  if (me.phone) {
    return {
      ok: false,
      error: 'already_bound_other',
      message: '当前账号已绑定其他手机号',
      phoneMasked: maskPhone(me.phone),
    };
  }

  const occupying = await findOccupyingUser(phone);
  if (!occupying) {
    try {
      await query(`UPDATE users SET phone = $1 WHERE id = $2 AND deleted_at IS NULL`, [phone, userId]);
    } catch {
      const raced = await findOccupyingUser(phone);
      if (raced && raced.id !== userId) {
        return {
          ok: false,
          error: 'phone_taken',
          message: '该手机号已注册另一个账号，合并后微信和短信都会进入当前账号',
          needsMerge: true,
          otherAccount: previewOf(raced),
        };
      }
      throw new Error('bind_phone_failed');
    }
    return { ok: true, status: 'bound', phoneMasked };
  }

  if (occupying.id === userId) {
    return { ok: true, status: 'already_bound', phoneMasked };
  }
  if (occupying.status && occupying.status !== 'active') {
    return { ok: false, error: 'phone_account_banned', message: '该手机号对应账号已被封禁，无法绑定' };
  }
  if (occupying.wechat_openid) {
    return {
      ok: false,
      error: 'phone_bound_to_wechat',
      message: '该手机号已绑定其他微信账号，无法合并。请用该手机号登录后再处理。',
    };
  }

  if (!confirmMerge) {
    return {
      ok: false,
      error: 'phone_taken',
      message: '该手机号已注册另一个账号，合并后微信和短信都会进入当前账号',
      needsMerge: true,
      otherAccount: previewOf(occupying),
    };
  }

  await ensureEnergyAccount(userId);
  await withTransaction(async (q) => {
    await fillEmptyBlobsFromUserToUser(occupying.id, userId, q);
    await absorbEnergyFromUser(occupying.id, userId, q);
    await q(
      `UPDATE users
       SET phone = NULL,
           deleted_at = NOW(),
           merged_into_user_id = $2
       WHERE id = $1 AND deleted_at IS NULL`,
      [occupying.id, userId],
    );
    await q(
      `UPDATE users SET phone = $1 WHERE id = $2 AND deleted_at IS NULL`,
      [phone, userId],
    );
  });

  return {
    ok: true,
    status: 'merged',
    phoneMasked,
    mergedFromUserId: occupying.id,
  };
}
