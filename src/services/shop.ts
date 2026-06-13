import { query } from '../db/client.js';
import { getShopProduct, SHOP_PRODUCTS } from '../config/shopProducts.js';
import { spendEnergy } from './energyLedger.js';

export function listProducts() {
  return SHOP_PRODUCTS;
}

export async function purchaseWithEnergy(userId: string, productId: string) {
  const product = getShopProduct(productId);
  if (!product) {
    return { success: false, error: 'product_not_found' as const };
  }

  const sourceId = `shop:energy:${productId}:${Date.now()}`;
  const spend = await spendEnergy(
    userId,
    product.energyPrice,
    `购买商品：${product.name}`,
    sourceId,
  );

  if (!spend.success) {
    return { success: false, error: 'insufficient_balance' as const, account: spend.account };
  }

  const order = await query<{ id: string }>(
    `INSERT INTO shop_orders (user_id, product_id, payment_method, energy_spent, status)
     VALUES ($1, $2, 'energy', $3, 'completed')
     RETURNING id`,
    [userId, productId, product.energyPrice],
  );

  return {
    success: true,
    orderId: order.rows[0]!.id,
    product,
    account: spend.account,
  };
}

export async function purchaseSandboxRmb(userId: string, productId: string) {
  const product = getShopProduct(productId);
  if (!product) {
    return { success: false, error: 'product_not_found' as const };
  }

  const order = await query<{ id: string }>(
    `INSERT INTO shop_orders (user_id, product_id, payment_method, rmb_amount, status)
     VALUES ($1, $2, 'sandbox_wechat', $3, 'completed')
     RETURNING id`,
    [userId, productId, product.rmbPrice],
  );

  const { ensureEnergyAccount } = await import('./energy.js');
  const account = await ensureEnergyAccount(userId);

  return {
    success: true,
    orderId: order.rows[0]!.id,
    product,
    account,
    sandbox: true,
  };
}

export async function listUserOrders(userId: string, limit = 20) {
  const row = await query<{
    id: string;
    product_id: string;
    payment_method: string;
    energy_spent: number | null;
    rmb_amount: string | null;
    status: string;
    created_at: Date;
  }>(
    `SELECT id, product_id, payment_method, energy_spent, rmb_amount, status, created_at
     FROM shop_orders WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [userId, limit],
  );
  return row.rows.map((r) => ({
    id: r.id,
    productId: r.product_id,
    paymentMethod: r.payment_method,
    energySpent: r.energy_spent,
    rmbAmount: r.rmb_amount ? Number(r.rmb_amount) : null,
    status: r.status,
    createdAt: r.created_at.toISOString(),
  }));
}
