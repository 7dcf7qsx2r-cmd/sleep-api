import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { createGuestSession, loginOrRegisterByPhone, loginOrRegisterByWeChat, loginWithPassword, getUserAccountProfile } from '../services/auth.js';
import { copyBlobsFromGuestToUser } from '../services/dataBlob.js';
import { ensureEnergyAccount } from '../services/energy.js';
import { verifyToken } from '../lib/jwt.js';
import { normalizePhone, maskPhone } from '../lib/phone.js';
import { issueAndSendCode, SmsRateLimitError, verifyCode } from '../services/sms/codeStore.js';
import { isSmsConfigured } from '../services/sms/tencentSms.js';
import { exchangeWeChatCode, fetchWeChatUserInfo, isWeChatConfigured } from '../services/wechat.js';
import { requireAuth, type AuthVariables } from '../middleware/auth.js';

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
    const session = await createGuestSession(deviceId);
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
    const result = await loginWithPassword(username, password);
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
      phone: z.string().min(11).max(20),
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
      phone: z.string().min(11).max(20),
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

    const result = await loginOrRegisterByPhone(phone);
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
      console.error('[auth/wechat/login]', err);
      return c.json({ error: 'wechat_login_failed', message: '微信登录失败，请重试' }, 401);
    }
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
