import { config } from '../config.js';

export interface WeChatTokenResponse {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  openid?: string;
  scope?: string;
  unionid?: string;
  errcode?: number;
  errmsg?: string;
}

export interface WeChatUserInfo {
  nickname?: string;
  headimgurl?: string;
}

export function isWeChatConfigured(): boolean {
  return Boolean(config.wechat.appId && config.wechat.appSecret);
}

export async function exchangeWeChatCode(code: string): Promise<{
  openid: string;
  unionid?: string;
  accessToken: string;
}> {
  const { appId, appSecret } = config.wechat;
  if (!appId || !appSecret) {
    throw new Error('wechat_not_configured');
  }

  const url = new URL('https://api.weixin.qq.com/sns/oauth2/access_token');
  url.searchParams.set('appid', appId);
  url.searchParams.set('secret', appSecret);
  url.searchParams.set('code', code);
  url.searchParams.set('grant_type', 'authorization_code');

  const res = await fetch(url.toString());
  const data = (await res.json()) as WeChatTokenResponse;
  if (data.errcode || !data.openid || !data.access_token) {
    throw new Error(data.errmsg ?? 'wechat_token_failed');
  }

  return {
    openid: data.openid,
    unionid: data.unionid,
    accessToken: data.access_token,
  };
}

export async function fetchWeChatUserInfo(
  accessToken: string,
  openid: string,
): Promise<WeChatUserInfo | null> {
  const url = new URL('https://api.weixin.qq.com/sns/userinfo');
  url.searchParams.set('access_token', accessToken);
  url.searchParams.set('openid', openid);
  url.searchParams.set('lang', 'zh_CN');

  const res = await fetch(url.toString());
  const data = (await res.json()) as WeChatUserInfo & { errcode?: number; errmsg?: string };
  if (data.errcode) {
    console.warn('[wechat] userinfo failed:', data.errcode, data.errmsg ?? '');
    return null;
  }
  if (!data.nickname && !data.headimgurl) return null;
  const headimgurl = data.headimgurl?.replace(/^http:\/\//i, 'https://');
  return { nickname: data.nickname, headimgurl };
}
