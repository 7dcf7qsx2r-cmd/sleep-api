const base = process.env.SMOKE_BASE_URL ?? 'http://localhost:8787';

async function req(path: string, options?: RequestInit & { headers?: Record<string, string> }) {
  const res = await fetch(`${base}${path}`, options);
  const text = await res.text();
  let json: unknown = null;
  try { json = JSON.parse(text); } catch { json = text; }
  return { ok: res.ok, status: res.status, json };
}

async function main() {
  console.log('P3 integration @', base);

  // 1. Login
  const login = await req('/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'demo', password: 'demo123' }),
  });
  if (!login.ok) throw new Error('login failed');
  const token = (login.json as { token?: string }).token;
  if (!token) throw new Error('no token');
  const authHeader = { Authorization: `Bearer ${token}` };

  // 2. Register push device
  const registerPush = await req('/push/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeader },
    body: JSON.stringify({ platform: 'android', token: 'test-fcm-token-' + Date.now() }),
  });
  console.log('POST /push/register', registerPush.status);
  if (!registerPush.ok) throw new Error('push register failed');

  // 3. Send a dream bottle
  const sendBottle = await req('/social/bottles', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeader },
    body: JSON.stringify({ content: '梦见一片星空，很安静', moodTags: ['平静', '星空'], bottleType: 'random' }),
  });
  console.log('POST /social/bottles', sendBottle.status);
  if (!sendBottle.ok) throw new Error('send bottle failed');
  const bottleId = (sendBottle.json as { bottle?: { id: string } }).bottle?.id;
  if (!bottleId) throw new Error('no bottle id');

  // 4. List sent bottles
  const sent = await req('/social/bottles/sent', { headers: authHeader });
  console.log('GET /social/bottles/sent', sent.status, (sent.json as { bottles?: unknown[] }).bottles?.length);
  if (!sent.ok) throw new Error('list sent failed');

  // 5. Pick a random bottle (might not find one if only ours exists)
  const picked = await req('/social/bottles/random', { headers: authHeader });
  console.log('GET /social/bottles/random', picked.status);
  // 404 is ok if no other bottles exist

  // 6. Reply to own bottle (for test)
  const reply = await req(`/social/bottles/${bottleId}/reply`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeader },
    body: JSON.stringify({ content: '谢谢分享，星空很美' }),
  });
  console.log('POST /social/bottles/:id/reply', reply.status);
  if (!reply.ok) throw new Error('reply failed');

  // 7. List replies
  const replies = await req(`/social/bottles/${bottleId}/replies`, { headers: authHeader });
  console.log('GET /social/bottles/:id/replies', replies.status, (replies.json as { replies?: unknown[] }).replies?.length);
  if (!replies.ok) throw new Error('list replies failed');

  // 8. Create feed post
  const post = await req('/social/feed', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeader },
    body: JSON.stringify({ type: 'milestone', content: { title: '连续早睡7天', score: 85 } }),
  });
  console.log('POST /social/feed', post.status);
  if (!post.ok) throw new Error('create post failed');
  const postId = (post.json as { post?: { id: string } }).post?.id;

  // 9. List feed
  const feed = await req('/social/feed', { headers: authHeader });
  console.log('GET /social/feed', feed.status, (feed.json as { posts?: unknown[] }).posts?.length);
  if (!feed.ok) throw new Error('list feed failed');

  // 10. Like feed post
  if (postId) {
    const like = await req(`/social/feed/${postId}/like`, {
      method: 'POST',
      headers: authHeader,
    });
    console.log('POST /social/feed/:id/like', like.status);
    if (!like.ok) throw new Error('like failed');
  }

  // 11. Check energy tasks include social tasks
  const tasks = await req('/energy/tasks', { headers: authHeader });
  const taskList = (tasks.json as { tasks?: Array<{ id: string }> }).tasks ?? [];
  const hasSocial = ['send_bottle', 'pick_bottle', 'reply_bottle', 'post_feed', 'like_feed'].every(
    (id) => taskList.some((t) => t.id === id),
  );
  console.log('GET /energy/tasks social tasks present:', hasSocial);
  if (!hasSocial) throw new Error('social energy tasks missing');

  console.log('P3 integration OK');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
