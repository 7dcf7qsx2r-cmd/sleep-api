import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { createGuestSession, loginOrRegisterByPhone, loginOrRegisterByWeChat, loginWithPassword, getUserAccountProfile, UserBannedError } from '../services/auth.js';
import { bindPhoneToUser } from '../services/phoneBind.js';
import { copyBlobsFromGuestToUser } from '../services/dataBlob.js';
import { ensureEnergyAccount } from '../services/energy.js';
import { verifyToken } from '../lib/jwt.js';
import { normalizePhone, maskPhone } from '../lib/phone.js';
import { consumeLatestCode, issueAndSendCode, SmsRateLimitError, verifyCode } from '../services/sms/codeStore.js';
import { isSmsConfigured } from '../services/sms/tencentSms.js';
import {
  exchangeMiniProgramCode,
  exchangeWeChatCode,
  fetchWeChatUserInfo,
  isWeChatConfigured,
  isWeChatMpConfigured,
} from '../services/wechat.js';
import { requireAuth, type AuthVariables } from '../middleware/auth.js';
import { config } from '../config.js';
import { consumeFixedWindow } from '../services/rateLimit.js';
import { recordVoiceEvent } from '../services/voiceMetrics.js';

export const authRoutes = new Hono<{ Variables: AuthVariables }>();

function clientIp(c: { req: { header: (name: string) => string | undefined } }): string | undefined {
  const forwarded = c.req.header('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0]?.trim();
  return c.req.header('x-real-ip');
}

authRoutes.post(
  '/guest',
  zValidator(
    'json',
    z.object({
      deviceId: z.string().max(128).optional(),
    }),
  ),
  async (c) => {
    const { deviceId } = c.req.valid('json');
    const ip = clientIp(c) ?? 'unknown';
    const deviceKey = deviceId?.trim() || `legacy:${c.req.header('user-agent') ?? 'unknown'}`;
    const checks = await Promise.all([
      consumeFixedWindow({
        action: 'guest_mint_device_minute',
        key: deviceKey,
        limit: config.guestMint.perMinuteDevice,
        windowMs: 60_000,
      }),
      consumeFixedWindow({
        action: 'guest_mint_device_day',
        key: deviceKey,
        limit: config.guestMint.perDayDevice,
        windowMs: 24 * 60 * 60_000,
      }),
      consumeFixedWindow({
        action: 'guest_mint_ip_hour',
        key: ip,
        limit: config.guestMint.perHourIp,
        windowMs: 60 * 60_000,
      }),
    ]);
    const rejected = checks.find((check) => !check.allowed);
    if (rejected) {
      c.header('Retry-After', String(rejected.retryAfterSec));
      await recordVoiceEvent({ feature: 'guest_mint', outcome: 'rate_limited' });
      return c.json({
        error: 'guest_rate_limited',
        message: '请求过于频繁，请稍后再试',
      }, 429);
    }

    const session = await createGuestSession(deviceId);
    await recordVoiceEvent({ feature: 'guest_mint', outcome: 'success' });
    return c.json({
      token: session.token,
      guestId: session.guestId,
      subjectType: 'guest',
      expiresIn: process.env.JWT_EXPIRES_IN ?? '30d',
    });
  },
);

authRoutes.post(
  '/login',
  zValidator(
    'json',
    z.object({
      username: z.string().min(1).max(64),
      password: z.string().min(1).max(128),
    }),
  ),
  async (c) => {
    const { username, password } = c.req.valid('json');
    let result;
    try {
      result = await loginWithPassword(username, password);
    } catch (err) {
      if (err instanceof UserBannedError) {
        return c.json({ error: 'user_banned', message: '账号已被封禁，请联系客服' }, 403);
      }
      throw err;
    }
    if (!result) {
      return c.json({ error: 'invalid_credentials', message: '用户名或密码错误' }, 401);
    }
    await ensureEnergyAccount(result.userId);
    return c.json({
      token: result.token,
      userId: result.userId,
      username: result.username,
      subjectType: 'user',
      expiresIn: process.env.JWT_EXPIRES_IN ?? '30d',
    });
  },
);

authRoutes.post(
  '/sms/send',
  zValidator(
    'json',
    z.object({
      phone: z.string().min(1).max(20),
    }),
  ),
  async (c) => {
    if (!isSmsConfigured()) {
      return c.json({ error: 'sms_not_configured', message: '短信服务未配置' }, 503);
    }
    const phone = normalizePhone(c.req.valid('json').phone);
    if (!phone) {
      return c.json({ error: 'invalid_phone', message: '请输入有效的中国大陆手机号' }, 400);
    }
    try {
      const { expiresIn } = await issueAndSendCode(phone, clientIp(c));
      return c.json({ ok: true, expiresIn, phone: maskPhone(phone) });
    } catch (err) {
      if (err instanceof SmsRateLimitError) {
        return c.json({ error: 'rate_limited', message: err.message }, 429);
      }
      console.error('[auth/sms/send]', err);
      return c.json({ error: 'sms_send_failed', message: '验证码发送失败，请稍后重试' }, 502);
    }
  },
);

authRoutes.post(
  '/sms/login',
  zValidator(
    'json',
    z.object({
      phone: z.string().min(1).max(20),
      code: z.string().regex(/^\d{6}$/),
    }),
  ),
  async (c) => {
    const { phone: rawPhone, code } = c.req.valid('json');
    const phone = normalizePhone(rawPhone);
    if (!phone) {
      return c.json({ error: 'invalid_phone', message: '请输入有效的中国大陆手机号' }, 400);
    }

    const ok = await verifyCode(phone, code);
    if (!ok) {
      return c.json({ error: 'invalid_code', message: '验证码错误或已过期' }, 401);
    }

    let result;
    try {
      result = await loginOrRegisterByPhone(phone);
    } catch (err) {
      if (err instanceof UserBannedError) {
        return c.json({ error: 'user_banned', message: '账号已被封禁，请联系客服' }, 403);
      }
      throw err;
    }
    await ensureEnergyAccount(result.userId);
    return c.json({
      token: result.token,
      userId: result.userId,
      username: result.username,
      phone: maskPhone(result.phone),
      isNewUser: result.isNewUser,
      subjectType: 'user',
      expiresIn: process.env.JWT_EXPIRES_IN ?? '30d',
    });
  },
);

authRoutes.post(
  '/wechat/login',
  zValidator(
    'json',
    z.object({
      code: z.string().min(1).max(512),
    }),
  ),
  async (c) => {
    if (!isWeChatConfigured()) {
      return c.json({ error: 'wechat_not_configured', message: '微信登录未配置' }, 503);
    }

    const { code } = c.req.valid('json');
    try {
      const tokenInfo = await exchangeWeChatCode(code);
      const profile = await fetchWeChatUserInfo(tokenInfo.accessToken, tokenInfo.openid);
      const result = await loginOrRegisterByWeChat({
        openid: tokenInfo.openid,
        unionid: tokenInfo.unionid,
        nickname: profile?.nickname,
        avatarUrl: profile?.headimgurl,
      });
      await ensureEnergyAccount(result.userId);
      return c.json({
        token: result.token,
        userId: result.userId,
        username: result.username,
        nickname: result.nickname,
        avatarUrl: result.avatarUrl,
        isNewUser: result.isNewUser,
        subjectType: 'user',
        expiresIn: process.env.JWT_EXPIRES_IN ?? '30d',
      });
    } catch (err) {
      if (err instanceof UserBannedError) {
        return c.json({ error: 'user_banned', message: '账号已被封禁，请联系客服' }, 403);
      }
      console.error('[auth/wechat/login]', err);
      return c.json({ error: 'wechat_login_failed', message: '微信登录失败，请重试' }, 401);
    }
  },
);

authRoutes.post(
  '/wechat/mp/login',
  zValidator(
    'json',
    z.object({
      code: z.string().min(1).max(512),
      nickname: z.string().max(64).optional(),
      avatarUrl: z.string().url().max(512).optional(),
    }),
  ),
  async (c) => {
    if (!isWeChatMpConfigured()) {
      return c.json({ error: 'wechat_mp_not_configured', message: '小程序登录未配置' }, 503);
    }

    const { code, nickname, avatarUrl } = c.req.valid('json');
    try {
      const session = await exchangeMiniProgramCode(code);
      const result = await loginOrRegisterByWeChat({
        openid: session.openid,
        unionid: session.unionid,
        nickname,
        avatarUrl,
      });
      await ensureEnergyAccount(result.userId);
      return c.json({
        token: result.token,
        userId: result.userId,
        username: result.username,
        nickname: result.nickname,
        avatarUrl: result.avatarUrl,
        isNewUser: result.isNewUser,
        subjectType: 'user',
        expiresIn: process.env.JWT_EXPIRES_IN ?? '30d',
      });
    } catch (err) {
      if (err instanceof UserBannedError) {
        return c.json({ error: 'user_banned', message: '账号已被封禁，请联系客服' }, 403);
      }
      console.error('[auth/wechat/mp/login]', err);
      return c.json({ error: 'wechat_mp_login_failed', message: '小程序登录失败，请重试' }, 401);
    }
  },
);

authRoutes.post(
  '/phone/bind',
  requireAuth,
  zValidator(
    'json',
    z.object({
      phone: z.string().min(1).max(20),
      code: z.string().regex(/^\d{6}$/),
      confirmMerge: z.boolean().optional(),
    }),
  ),
  async (c) => {
    const auth = c.get('auth');
    if (auth.type !== 'user') {
      return c.json({ error: 'user_required', message: '请先登录后再绑定手机号' }, 403);
    }

    const { phone: rawPhone, code, confirmMerge } = c.req.valid('json');
    const phone = normalizePhone(rawPhone);
    if (!phone) {
      return c.json({ error: 'invalid_phone', message: '请输入有效的中国大陆手机号' }, 400);
    }

    const ok = await verifyCode(phone, code, { consume: false });
    if (!ok) {
      return c.json({ error: 'invalid_code', message: '验证码错误或已过期' }, 401);
    }

    const result = await bindPhoneToUser({
      userId: auth.sub,
      phone,
      confirmMerge: Boolean(confirmMerge),
    });

    if (!result.ok) {
      if (result.error === 'phone_taken') {
        return c.json({
          error: result.error,
          message: result.message,
          needsMerge: true,
          otherAccount: result.otherAccount,
        }, 409);
      }
      if (result.error === 'not_found') {
        return c.json({ error: result.error, message: result.message }, 404);
      }
      return c.json({
        error: result.error,
        message: result.message,
        phone: 'phoneMasked' in result ? result.phoneMasked : undefined,
      }, 409);
    }

    await consumeLatestCode(phone);
    const profile = await getUserAccountProfile(auth.sub);
    return c.json({
      ok: true,
      status: result.status,
      phone: result.phoneMasked,
      mergedFromUserId: result.mergedFromUserId ?? null,
      userId: auth.sub,
      profile,
    });
  },
);

authRoutes.get('/me', requireAuth, async (c) => {
  const auth = c.get('auth');
  if (auth.type !== 'user') {
    return c.json({ error: 'user_required' }, 403);
  }
  const profile = await getUserAccountProfile(auth.sub);
  if (!profile) {
    return c.json({ error: 'not_found' }, 404);
  }
  return c.json({ profile });
});

authRoutes.post(
  '/merge-guest',
  zValidator(
    'json',
    z.object({
      guestToken: z.string().min(10),
    }),
  ),
  async (c) => {
    const guestPayload = await verifyToken(c.req.valid('json').guestToken);
    if (!guestPayload || guestPayload.type !== 'guest') {
      return c.json({ error: 'invalid_guest_token' }, 400);
    }

    const header = c.req.header('Authorization');
    const userToken = header?.startsWith('Bearer ') ? header.slice(7) : null;
    if (!userToken) {
      return c.json({ error: 'unauthorized' }, 401);
    }
    const userPayload = await verifyToken(userToken);
    if (!userPayload || userPayload.type !== 'user') {
      return c.json({ error: 'user_token_required' }, 401);
    }

    await copyBlobsFromGuestToUser(guestPayload.sub, userPayload.sub);
    await ensureEnergyAccount(userPayload.sub);

    return c.json({
      merged: true,
      userId: userPayload.sub,
      guestId: guestPayload.sub,
    });
  },
);
