const base = process.env.SMOKE_BASE_URL ?? 'http://localhost:8787';

async function login(): Promise<string> {
  const res = await fetch(`${base}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'demo', password: 'demo123' }),
  });
  const data = (await res.json()) as { token?: string };
  if (!data.token) throw new Error('login failed');
  return data.token;
}

async function main() {
  const token = await login();
  const auth = { Authorization: `Bearer ${token}` };

  const tasks = await fetch(`${base}/energy/tasks`, { headers: auth });
  console.log('GET /energy/tasks', tasks.status);

  const complete = await fetch(`${base}/energy/tasks/breathing/complete`, {
    method: 'POST',
    headers: auth,
  });
  console.log('POST /energy/tasks/breathing/complete', complete.status);

  const spend = await fetch(`${base}/energy/spend`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      amount: 15,
      description: '唤醒小眠',
      sourceId: `force_wake:p2-test`,
      reason: 'force_wake',
    }),
  });
  console.log('POST /energy/spend', spend.status);

  const products = await fetch(`${base}/shop/products`, { headers: auth });
  console.log('GET /shop/products', products.status);

  const purchase = await fetch(`${base}/shop/purchase`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ productId: 'p4', paymentMethod: 'sandbox_wechat' }),
  });
  console.log('POST /shop/purchase sandbox', purchase.status);

  const account = await fetch(`${base}/energy/account`, { headers: auth });
  const acc = await account.json();
  console.log('balance after P2 ops', acc.balance);

  console.log('P2 integration OK');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
