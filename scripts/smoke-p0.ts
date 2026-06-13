const base = process.env.SMOKE_BASE_URL ?? 'http://localhost:8787';

async function req(path: string, options?: RequestInit & { headers?: Record<string, string> }) {
  const res = await fetch(`${base}${path}`, options);
  const text = await res.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { ok: res.ok, status: res.status, json };
}

async function main() {
  console.log('smoke P0 @', base);

  const health = await req('/health');
  console.log('GET /health', health.status, health.json);
  if (!health.ok) throw new Error('health failed');

  const guest = await req('/auth/guest', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceId: 'smoke-device' }),
  });
  console.log('POST /auth/guest', guest.status);
  if (!guest.ok) throw new Error('guest auth failed');
  const guestToken = (guest.json as { token?: string }).token;
  if (!guestToken) throw new Error('no guest token');

  const login = await req('/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'demo', password: 'demo123' }),
  });
  console.log('POST /auth/login', login.status);
  if (!login.ok) throw new Error('login failed');
  const userToken = (login.json as { token?: string }).token;
  if (!userToken) throw new Error('no user token');

  const chat = await req('/ai/chat', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${userToken}`,
    },
    body: JSON.stringify({
      message: '今晚有点睡不着',
      fallback: '我在听。',
    }),
  });
  console.log('POST /ai/chat', chat.status, (chat.json as { isFallback?: boolean }).isFallback);
  if (!chat.ok) throw new Error('chat failed');

  const interpret = await req('/ai/dream/interpret', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${userToken}`,
    },
    body: JSON.stringify({
      dreamText: '梦见在海边走，雾很大',
      mood: '平静',
      contextBlock: '最近工作压力大',
      personalImagery: [{ motif: '海', personalNote: '小时候常去海边' }],
      isIncomplete: false,
    }),
  });
  console.log('POST /ai/dream/interpret', interpret.status);
  if (!interpret.ok) throw new Error('interpret failed');

  const quota = await req('/ai/quota', {
    headers: { Authorization: `Bearer ${guestToken}` },
  });
  console.log('GET /ai/quota', quota.status, quota.json);
  if (!quota.ok) throw new Error('quota failed');

  const syncBootstrap = await req('/sync/bootstrap', {
    headers: { Authorization: `Bearer ${userToken}` },
  });
  console.log('GET /sync/bootstrap', syncBootstrap.status);
  if (!syncBootstrap.ok) throw new Error('sync bootstrap failed');

  const syncPut = await req('/sync/profile', {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${userToken}`,
    },
    body: JSON.stringify({
      version: 0,
      data: { nickname: '冒烟测试', avatar: '🌙', sleepType: '浅睡易醒型', sleepScore: 80, points: 100 },
    }),
  });
  console.log('PUT /sync/profile', syncPut.status);
  if (!syncPut.ok) throw new Error('sync put failed');

  const energy = await req('/energy/account', {
    headers: { Authorization: `Bearer ${userToken}` },
  });
  console.log('GET /energy/account', energy.status);
  if (!energy.ok) throw new Error('energy account failed');

  console.log('P0+P1 smoke OK');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
