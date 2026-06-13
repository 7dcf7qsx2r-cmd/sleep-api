/**
 * P0+P1 联调脚本 — 模拟客户端完整流程
 * 用法: npm run integration
 */
const base = process.env.SMOKE_BASE_URL ?? 'http://localhost:8787';

async function req<T = unknown>(
  path: string,
  options?: RequestInit,
): Promise<{ ok: boolean; status: number; json: T | null }> {
  const res = await fetch(`${base}${path}`, options);
  let json: T | null = null;
  try {
    json = (await res.json()) as T;
  } catch {
    json = null;
  }
  return { ok: res.ok, status: res.status, json };
}

function log(step: string, ok: boolean, detail?: string) {
  const mark = ok ? '✓' : '✗';
  console.log(`${mark} ${step}${detail ? ` — ${detail}` : ''}`);
  if (!ok) throw new Error(step);
}

async function main() {
  console.log('=== P0+P1 联调 @', base, '===\n');

  const health = await req('/health');
  log('P0 health', health.ok, JSON.stringify(health.json));

  const guest = await req<{ token: string; guestId: string }>('/auth/guest', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceId: 'integration-test-device' }),
  });
  log('P0 guest auth', guest.ok);
  const guestToken = guest.json!.token;

  const dreamPayload = {
    version: 0,
    data: [
      {
        id: 'dream_integration_1',
        date: '06-12',
        text: '梦见在雾里走，远处有灯塔',
        tags: ['雾', '海'],
        mood: '平静',
      },
    ],
  };
  const pushGuest = await req('/sync/dream_diary', {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${guestToken}`,
    },
    body: JSON.stringify(dreamPayload),
  });
  log('P1 guest push dream_diary', pushGuest.ok);

  const chat = await req('/ai/chat', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${guestToken}`,
    },
    body: JSON.stringify({ message: '有点睡不着', fallback: '我在听。' }),
  });
  log('P0 guest chat', chat.ok);

  const login = await req<{ token: string; userId: string }>('/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'demo', password: 'demo123' }),
  });
  log('P0 login', login.ok);
  const userToken = login.json!.token;

  const merge = await req('/auth/merge-guest', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${userToken}`,
    },
    body: JSON.stringify({ guestToken }),
  });
  log('P1 merge-guest', merge.ok);

  const bootstrap = await req<{
    domains: Array<{ domain: string; data: unknown; version: number }>;
    energy: { balance: number } | null;
  }>('/sync/bootstrap', {
    headers: { Authorization: `Bearer ${userToken}` },
  });
  log('P1 bootstrap', bootstrap.ok);

  const diary = bootstrap.json?.domains.find((d) => d.domain === 'dream_diary');
  const hasDream =
    Array.isArray(diary?.data) &&
    (diary.data as Array<{ id: string }>).some((e) => e.id === 'dream_integration_1');
  log('P1 merged dream in bootstrap', hasDream, hasDream ? 'found dream_integration_1' : 'missing');

  const energy = await req<{ balance: number }>('/energy/account', {
    headers: { Authorization: `Bearer ${userToken}` },
  });
  log('P1 energy account', energy.ok, `balance=${energy.json?.balance}`);

  const interpret = await req('/ai/dream/interpret', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${userToken}`,
    },
    body: JSON.stringify({
      dreamText: '梦见在雾里走',
      mood: '平静',
      contextBlock: '联调测试',
      personalImagery: [{ motif: '雾', personalNote: '常出现在夜里' }],
      isIncomplete: false,
    }),
  });
  log('P0 interpret', interpret.ok);

  const profileBlob = bootstrap.json?.domains.find((d) => d.domain === 'profile');
  const currentVersion = profileBlob?.version ?? 0;
  const staleVersion = currentVersion > 0 ? currentVersion - 1 : 0;
  const conflict = await req('/sync/profile', {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${userToken}`,
    },
    body: JSON.stringify({
      version: staleVersion,
      data: { nickname: '冲突测试', avatar: '🌙', sleepType: '浅睡', sleepScore: 70, points: 0 },
    }),
  });
  const expectConflict = currentVersion > 0 || staleVersion === 0 && profileBlob;
  log(
    'P1 version conflict (expect 409)',
    conflict.status === 409 || (currentVersion === 0 && conflict.ok),
    `status=${conflict.status} serverVer=${currentVersion}`,
  );

  console.log('\n=== 全部联调通过 ===');
}

main().catch((err) => {
  console.error('\n联调失败:', err.message);
  process.exit(1);
});
