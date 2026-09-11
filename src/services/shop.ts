import { randomBytes } from 'node:crypto';
import { query } from '../db/client.js';
import { config } from '../config.js';
import type { ShopProduct } from '../config/shopProducts.js';
import {
  buildAppPayParams,
  isAlipayConfigured,
  isPaidTradeStatus,
  queryAlipayTrade,
  toOrderString,
  verifyAlipayNotify,
} from '../lib/alipay.js';
import { spendEnergy } from './energyLedger.js';

interface ShopProductRow {
  id: string;
  category: ShopProductCategory;
  icon: string;
  name: string;
  summary: string;
  description: string;
  ai_reason: string;
  shop_name: string;
  image_slides: unknown;
  details: unknown;
  energy_price: number;
  original_energy_price: number;
  rmb_price: string;
  original_rmb_price: string;
  stock: number | null;
  status: 'draft' | 'published' | 'archived';
  sort_order: number;
}

export interface ShopProductInput {
  id?: string;
  category: ShopProductCategory;
  icon: string;
  name: string;
  summary: string;
  description: string;
  aiReason: string;
  shopName: string;
  imageSlides: string[];
  details: string[];
  energyPrice: number;
  originalEnergyPrice: number;
  rmbPrice: number;
  originalRmbPrice: number;
  stock?: number | null;
  status: 'draft' | 'published' | 'archived';
  sortOrder: number;
}

type OrderStatus = 'pending' | 'completed' | 'cancelled' | 'refunded';
type ShopProductCategory = 'recommend' | 'sleep' | 'wellness' | 'beauty' | 'energy';

export interface ShippingAddressSnapshot {
  receiverName: string;
  phone: string;
  region: string;
  detail: string;
}

interface AdminOrderRow {
  id: string;
  user_id: string;
  username: string | null;
  nickname: string | null;
  phone: string | null;
  product_id: string;
  product_name: string | null;
  payment_method: string;
  quantity: number;
  energy_spent: number | null;
  rmb_amount: string | null;
  status: OrderStatus;
  created_at: Date;
  updated_at: Date;
  address_snapshot_json: unknown;
}

interface OrderEventRow {
  id: string;
  order_id: string;
  event_type: string;
  before_status: string | null;
  after_status: string | null;
  note: string | null;
  actor_type: string;
  actor_id: string | null;
  metadata_json: unknown;
  created_at: Date;
}

function stringArray(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((item): item is string => typeof item === 'string');
}

function mapProduct(row: ShopProductRow): ShopProduct {
  return {
    id: row.id,
    category: row.category,
    icon: row.icon,
    name: row.name,
    summary: row.summary,
    description: row.description,
    aiReason: row.ai_reason,
    shopName: row.shop_name,
    imageSlides: stringArray(row.image_slides),
    details: stringArray(row.details),
    energyPrice: row.energy_price,
    originalEnergyPrice: row.original_energy_price,
    rmbPrice: Number(row.rmb_price),
    originalRmbPrice: Number(row.original_rmb_price),
    stock: row.stock,
    status: row.status,
    sortOrder: row.sort_order,
  };
}

function normalizeAddressSnapshot(input?: ShippingAddressSnapshot | null) {
  if (!input) return null;
  return {
    receiverName: input.receiverName?.trim() ?? '',
    phone: input.phone?.trim() ?? '',
    region: input.region?.trim() ?? '',
    detail: input.detail?.trim() ?? '',
  };
}

function productSnapshot(product: ShopProduct) {
  return {
    id: product.id,
    category: product.category,
    name: product.name,
    icon: product.icon,
    summary: product.summary,
    energyPrice: product.energyPrice,
    rmbPrice: product.rmbPrice,
  };
}

async function writeOrderEvent(params: {
  orderId: string;
  eventType: string;
  beforeStatus?: string | null;
  afterStatus?: string | null;
  note?: string;
  actorType?: 'system' | 'admin' | 'user';
  actorId?: string;
  metadata?: unknown;
}) {
  await query(
    `INSERT INTO shop_order_events
      (order_id, event_type, before_status, after_status, note, actor_type, actor_id, metadata_json)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
    [
      params.orderId,
      params.eventType,
      params.beforeStatus ?? null,
      params.afterStatus ?? null,
      params.note ?? null,
      params.actorType ?? 'system',
      params.actorId ?? null,
      JSON.stringify(params.metadata ?? {}),
    ],
  );
}

export async function listProducts(options: { includeArchived?: boolean } = {}) {
  const where = options.includeArchived ? '' : `WHERE status = 'published'`;
  const result = await query<ShopProductRow>(
    `SELECT id, category, icon, name, summary, description, ai_reason, shop_name,
            image_slides, details, energy_price, original_energy_price,
            rmb_price, original_rmb_price, stock, status, sort_order
     FROM shop_products
     ${where}
     ORDER BY sort_order ASC, created_at DESC`,
  );
  return result.rows.map(mapProduct);
}

export async function getProduct(productId: string, options: { includeUnpublished?: boolean } = {}) {
  const whereStatus = options.includeUnpublished ? '' : `AND status = 'published'`;
  const result = await query<ShopProductRow>(
    `SELECT id, category, icon, name, summary, description, ai_reason, shop_name,
            image_slides, details, energy_price, original_energy_price,
            rmb_price, original_rmb_price, stock, status, sort_order
     FROM shop_products
     WHERE id = $1 ${whereStatus}
     LIMIT 1`,
    [productId],
  );
  const row = result.rows[0];
  if (row) return mapProduct(row);
  return undefined;
}

export async function createProduct(input: ShopProductInput) {
  const id = input.id?.trim() || `p-${Date.now()}`;
  const result = await query<ShopProductRow>(
    `INSERT INTO shop_products (
      id, category, icon, name, summary, description, ai_reason, shop_name, image_slides,
      details, energy_price, original_energy_price, rmb_price, original_rmb_price,
      stock, status, sort_order, published_at
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11, $12, $13, $14, $15, $16, $17,
            CASE WHEN $16 = 'published' THEN NOW() ELSE NULL END)
    RETURNING id, category, icon, name, summary, description, ai_reason, shop_name, image_slides,
              details, energy_price, original_energy_price, rmb_price, original_rmb_price,
              stock, status, sort_order`,
    [
      id,
      input.category,
      input.icon,
      input.name,
      input.summary,
      input.description,
      input.aiReason,
      input.shopName,
      JSON.stringify(input.imageSlides),
      JSON.stringify(input.details),
      input.energyPrice,
      input.originalEnergyPrice,
      input.rmbPrice,
      input.originalRmbPrice,
      input.stock ?? null,
      input.status,
      input.sortOrder,
    ],
  );
  return mapProduct(result.rows[0]!);
}

export async function updateProduct(productId: string, input: ShopProductInput) {
  const before = await getProduct(productId, { includeUnpublished: true });
  if (!before) return null;
  const result = await query<ShopProductRow>(
    `UPDATE shop_products SET
      category = $2,
      icon = $3,
      name = $4,
      summary = $5,
      description = $6,
      ai_reason = $7,
      shop_name = $8,
      image_slides = $9::jsonb,
      details = $10::jsonb,
      energy_price = $11,
      original_energy_price = $12,
      rmb_price = $13,
      original_rmb_price = $14,
      stock = $15,
      status = $16,
      sort_order = $17,
      published_at = CASE WHEN $16 = 'published' AND published_at IS NULL THEN NOW() ELSE published_at END,
      updated_at = NOW()
     WHERE id = $1
     RETURNING id, category, icon, name, summary, description, ai_reason, shop_name, image_slides,
               details, energy_price, original_energy_price, rmb_price, original_rmb_price,
               stock, status, sort_order`,
    [
      productId,
      input.category,
      input.icon,
      input.name,
      input.summary,
      input.description,
      input.aiReason,
      input.shopName,
      JSON.stringify(input.imageSlides),
      JSON.stringify(input.details),
      input.energyPrice,
      input.originalEnergyPrice,
      input.rmbPrice,
      input.originalRmbPrice,
      input.stock ?? null,
      input.status,
      input.sortOrder,
    ],
  );
  return { before, after: mapProduct(result.rows[0]!) };
}

export async function setProductStatus(productId: string, status: 'draft' | 'published' | 'archived') {
  const before = await getProduct(productId, { includeUnpublished: true });
  if (!before) return null;
  const result = await query<ShopProductRow>(
    `UPDATE shop_products
     SET status = $2,
         published_at = CASE WHEN $2 = 'published' AND published_at IS NULL THEN NOW() ELSE published_at END,
         updated_at = NOW()
     WHERE id = $1
     RETURNING id, category, icon, name, summary, description, ai_reason, shop_name, image_slides,
               details, energy_price, original_energy_price, rmb_price, original_rmb_price,
               stock, status, sort_order`,
    [productId, status],
  );
  return { before, after: mapProduct(result.rows[0]!) };
}

export async function purchaseWithEnergy(
  userId: string,
  productId: string,
  quantity = 1,
  addressSnapshot?: ShippingAddressSnapshot | null,
) {
  const product = await getProduct(productId);
  if (!product) {
    return { success: false, error: 'product_not_found' as const };
  }
  const count = Math.max(1, Math.min(quantity, 99));
  const energySpent = product.energyPrice * count;

  const sourceId = `shop:energy:${productId}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
  const spend = await spendEnergy(
    userId,
    energySpent,
    count > 1 ? `购买商品：${product.name} x${count}` : `购买商品：${product.name}`,
    sourceId,
  );

  if (!spend.success) {
    return { success: false, error: 'insufficient_balance' as const, account: spend.account };
  }

  const order = await query<{ id: string }>(
    `INSERT INTO shop_orders (user_id, product_id, payment_method, quantity, energy_spent, status, product_snapshot_json, address_snapshot_json)
     VALUES ($1, $2, 'energy', $3, $4, 'completed', $5::jsonb, $6::jsonb)
     RETURNING id`,
    [
      userId,
      productId,
      count,
      energySpent,
      JSON.stringify(productSnapshot(product)),
      JSON.stringify(normalizeAddressSnapshot(addressSnapshot)),
    ],
  );
  await writeOrderEvent({
    orderId: order.rows[0]!.id,
    eventType: 'created',
    afterStatus: 'completed',
    actorType: 'user',
    actorId: userId,
    metadata: { paymentMethod: 'energy', productId, quantity: count },
  });

  return {
    success: true,
    orderId: order.rows[0]!.id,
    product,
    account: spend.account,
  };
}

export async function purchaseSandboxRmb(
  userId: string,
  productId: string,
  quantity = 1,
  addressSnapshot?: ShippingAddressSnapshot | null,
) {
  const product = await getProduct(productId);
  if (!product) {
    return { success: false, error: 'product_not_found' as const };
  }

  const count = Math.max(1, Math.min(quantity, 99));
  const order = await query<{ id: string }>(
    `INSERT INTO shop_orders (user_id, product_id, payment_method, quantity, rmb_amount, status, product_snapshot_json, address_snapshot_json)
     VALUES ($1, $2, 'sandbox_wechat', $3, $4, 'completed', $5::jsonb, $6::jsonb)
     RETURNING id`,
    [
      userId,
      productId,
      count,
      product.rmbPrice * count,
      JSON.stringify(productSnapshot(product)),
      JSON.stringify(normalizeAddressSnapshot(addressSnapshot)),
    ],
  );
  await writeOrderEvent({
    orderId: order.rows[0]!.id,
    eventType: 'created',
    afterStatus: 'completed',
    actorType: 'user',
    actorId: userId,
    metadata: { paymentMethod: 'sandbox_wechat', productId, quantity: count },
  });

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

function toCents(value: string | number): number {
  return Math.round(Number(value) * 100);
}

function formatRmbAmount(value: number): string {
  return (Math.round(value * 100) / 100).toFixed(2);
}

function newOutTradeNo(): string {
  return `xm${Date.now()}${randomBytes(4).toString('hex')}`;
}

export async function createAlipayAppPayment(
  userId: string,
  items: Array<{ productId: string; quantity?: number }>,
  addressSnapshot?: ShippingAddressSnapshot | null,
) {
  if (!isAlipayConfigured(config.alipay)) {
    return { success: false as const, error: 'alipay_not_configured' as const };
  }
  if (!items.length) {
    return { success: false as const, error: 'empty_cart' as const };
  }

  const resolved: Array<{ product: ShopProduct; quantity: number }> = [];
  for (const item of items) {
    const product = await getProduct(item.productId);
    if (!product) {
      return { success: false as const, error: 'product_not_found' as const };
    }
    resolved.push({
      product,
      quantity: Math.max(1, Math.min(item.quantity ?? 1, 99)),
    });
  }

  const totalAmount = resolved.reduce((sum, row) => sum + row.product.rmbPrice * row.quantity, 0);
  if (totalAmount <= 0) {
    return { success: false as const, error: 'invalid_amount' as const };
  }

  const outTradeNo = newOutTradeNo();
  const subject = resolved.length === 1
    ? `${resolved[0]!.product.name}${resolved[0]!.quantity > 1 ? ` x${resolved[0]!.quantity}` : ''}`
    : `小眠商城 ${resolved.length} 件商品`;
  const orderIds: string[] = [];

  for (const row of resolved) {
    const inserted = await query<{ id: string }>(
      `INSERT INTO shop_orders
        (user_id, product_id, payment_method, quantity, rmb_amount, status,
         product_snapshot_json, address_snapshot_json, out_trade_no)
       VALUES ($1, $2, 'alipay', $3, $4, 'pending', $5::jsonb, $6::jsonb, $7)
       RETURNING id`,
      [
        userId,
        row.product.id,
        row.quantity,
        row.product.rmbPrice * row.quantity,
        JSON.stringify(productSnapshot(row.product)),
        JSON.stringify(normalizeAddressSnapshot(addressSnapshot)),
        outTradeNo,
      ],
    );
    const orderId = inserted.rows[0]!.id;
    orderIds.push(orderId);
    await writeOrderEvent({
      orderId,
      eventType: 'created',
      afterStatus: 'pending',
      actorType: 'user',
      actorId: userId,
      metadata: { paymentMethod: 'alipay', productId: row.product.id, quantity: row.quantity, outTradeNo },
    });
  }

  const params = buildAppPayParams(config.alipay, {
    outTradeNo,
    totalAmount: formatRmbAmount(totalAmount),
    subject: subject.slice(0, 256),
  });

  return {
    success: true as const,
    outTradeNo,
    orderIds,
    orderString: toOrderString(params),
    totalAmount: formatRmbAmount(totalAmount),
    subject,
  };
}

async function markAlipayOrdersPaid(outTradeNo: string, alipayTradeNo: string | undefined, totalAmount: string | undefined) {
  const pending = await query<{
    id: string;
    status: string;
    rmb_amount: string;
  }>(
    `SELECT id, status, rmb_amount::text AS rmb_amount
     FROM shop_orders
     WHERE out_trade_no = $1`,
    [outTradeNo],
  );
  if (!pending.rows.length) {
    return { ok: false as const, error: 'order_not_found' as const };
  }

  const expectedCents = pending.rows.reduce((sum, row) => sum + toCents(row.rmb_amount), 0);
  if (totalAmount != null && toCents(totalAmount) !== expectedCents) {
    return { ok: false as const, error: 'amount_mismatch' as const };
  }

  const alreadyPaid = pending.rows.every((row) => row.status === 'completed');
  if (alreadyPaid) {
    return { ok: true as const, alreadyPaid: true, orderIds: pending.rows.map((row) => row.id) };
  }

  await query(
    `UPDATE shop_orders
     SET status = 'completed',
         alipay_trade_no = COALESCE($2, alipay_trade_no),
         updated_at = NOW()
     WHERE out_trade_no = $1 AND status = 'pending'`,
    [outTradeNo, alipayTradeNo ?? null],
  );

  for (const row of pending.rows) {
    if (row.status === 'completed') continue;
    await writeOrderEvent({
      orderId: row.id,
      eventType: 'paid',
      beforeStatus: row.status,
      afterStatus: 'completed',
      metadata: { outTradeNo, alipayTradeNo },
    });
  }

  return { ok: true as const, alreadyPaid: false, orderIds: pending.rows.map((row) => row.id) };
}

export async function handleAlipayNotify(payload: Record<string, string>) {
  if (!isAlipayConfigured(config.alipay)) {
    return { ok: false as const, error: 'alipay_not_configured' as const };
  }
  if (!verifyAlipayNotify(payload, config.alipay.alipayPublicKey)) {
    return { ok: false as const, error: 'bad_sign' as const };
  }
  if (!isPaidTradeStatus(payload.trade_status)) {
    return { ok: true as const, ignored: true };
  }
  return markAlipayOrdersPaid(payload.out_trade_no, payload.trade_no, payload.total_amount);
}

export async function confirmAlipayPayment(userId: string, outTradeNo: string) {
  if (!isAlipayConfigured(config.alipay)) {
    return { success: false as const, error: 'alipay_not_configured' as const };
  }
  const owned = await query<{ id: string; status: string }>(
    `SELECT id, status FROM shop_orders WHERE out_trade_no = $1 AND user_id = $2`,
    [outTradeNo, userId],
  );
  if (!owned.rows.length) {
    return { success: false as const, error: 'order_not_found' as const };
  }
  if (owned.rows.every((row) => row.status === 'completed')) {
    return { success: true as const, status: 'completed' as const, outTradeNo };
  }

  const queried = await queryAlipayTrade(config.alipay, outTradeNo);
  if (queried.code === '10000' && isPaidTradeStatus(queried.tradeStatus)) {
    const paid = await markAlipayOrdersPaid(outTradeNo, queried.tradeNo, queried.totalAmount);
    if (!paid.ok) return { success: false as const, error: paid.error };
    return { success: true as const, status: 'completed' as const, outTradeNo };
  }

  return {
    success: true as const,
    status: 'pending' as const,
    outTradeNo,
    alipayStatus: queried.tradeStatus ?? queried.msg,
  };
}

export async function getAlipayPayment(userId: string, outTradeNo: string) {
  const rows = await query<{ id: string; status: string; rmb_amount: string }>(
    `SELECT id, status, rmb_amount::text AS rmb_amount
     FROM shop_orders
     WHERE out_trade_no = $1 AND user_id = $2`,
    [outTradeNo, userId],
  );
  if (!rows.rows.length) return null;
  const completed = rows.rows.every((row) => row.status === 'completed');
  return {
    outTradeNo,
    status: completed ? 'completed' : 'pending',
    orderIds: rows.rows.map((row) => row.id),
    totalAmount: formatRmbAmount(rows.rows.reduce((sum, row) => sum + Number(row.rmb_amount), 0)),
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

function maskPhoneForAdmin(phone: string | null): string | null {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 7) return phone;
  return `${digits.slice(0, 3)}****${digits.slice(-4)}`;
}

function parseAddressSnapshot(raw: unknown): ShippingAddressSnapshot | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const receiverName = typeof o.receiverName === 'string' ? o.receiverName.trim() : '';
  const phone = typeof o.phone === 'string' ? o.phone.trim() : '';
  const region = typeof o.region === 'string' ? o.region.trim() : '';
  const detail = typeof o.detail === 'string' ? o.detail.trim() : '';
  if (!receiverName && !phone && !region && !detail) return null;
  return { receiverName, phone, region, detail };
}

function mapAdminOrder(row: AdminOrderRow) {
  return {
    id: row.id,
    userId: row.user_id,
    username: row.username,
    nickname: row.nickname,
    phoneMasked: maskPhoneForAdmin(row.phone),
    productId: row.product_id,
    productName: row.product_name ?? row.product_id,
    paymentMethod: row.payment_method,
    quantity: row.quantity,
    energySpent: row.energy_spent,
    rmbAmount: row.rmb_amount != null ? Number(row.rmb_amount) : null,
    status: row.status,
    address: parseAddressSnapshot(row.address_snapshot_json),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function mapOrderEvent(row: OrderEventRow) {
  return {
    id: row.id,
    orderId: row.order_id,
    eventType: row.event_type,
    beforeStatus: row.before_status,
    afterStatus: row.after_status,
    note: row.note,
    actorType: row.actor_type,
    actorId: row.actor_id,
    metadata: row.metadata_json,
    createdAt: row.created_at.toISOString(),
  };
}

export async function listOrdersForAdmin(params: {
  q?: string;
  status?: OrderStatus;
  paymentMethod?: string;
  page: number;
  pageSize: number;
}) {
  const page = Math.max(1, params.page);
  const pageSize = Math.min(100, Math.max(1, params.pageSize));
  const where: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  if (params.status) {
    where.push(`o.status = $${idx++}`);
    values.push(params.status);
  }
  if (params.paymentMethod) {
    where.push(`o.payment_method = $${idx++}`);
    values.push(params.paymentMethod);
  }
  if (params.q?.trim()) {
    const q = `%${params.q.trim()}%`;
    where.push(`(o.id::text ILIKE $${idx} OR o.product_id ILIKE $${idx} OR u.username ILIKE $${idx} OR u.phone ILIKE $${idx} OR p.nickname ILIKE $${idx})`);
    values.push(q);
    idx += 1;
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const count = await query<{ count: string }>(
    `SELECT COUNT(*)::text AS count
     FROM shop_orders o
     JOIN users u ON u.id = o.user_id
     LEFT JOIN user_profiles p ON p.user_id = u.id
     ${whereSql}`,
    values,
  );
  const result = await query<AdminOrderRow>(
    `SELECT o.id, o.user_id, u.username, p.nickname, u.phone,
            o.product_id, sp.name AS product_name, o.payment_method, o.quantity,
            o.energy_spent, o.rmb_amount, o.status, o.address_snapshot_json,
            o.created_at, o.updated_at
     FROM shop_orders o
     JOIN users u ON u.id = o.user_id
     LEFT JOIN user_profiles p ON p.user_id = u.id
     LEFT JOIN shop_products sp ON sp.id = o.product_id
     ${whereSql}
     ORDER BY o.created_at DESC
     LIMIT $${idx++} OFFSET $${idx}`,
    [...values, pageSize, (page - 1) * pageSize],
  );

  return {
    items: result.rows.map(mapAdminOrder),
    total: Number.parseInt(count.rows[0]?.count ?? '0', 10),
    page,
    pageSize,
  };
}

export async function getOrderDetailForAdmin(orderId: string) {
  const order = await query<AdminOrderRow & { product_snapshot_json: unknown }>(
    `SELECT o.id, o.user_id, u.username, p.nickname, u.phone,
            o.product_id, sp.name AS product_name, o.payment_method, o.quantity,
            o.energy_spent, o.rmb_amount, o.status, o.address_snapshot_json,
            o.created_at, o.updated_at, o.product_snapshot_json
     FROM shop_orders o
     JOIN users u ON u.id = o.user_id
     LEFT JOIN user_profiles p ON p.user_id = u.id
     LEFT JOIN shop_products sp ON sp.id = o.product_id
     WHERE o.id = $1`,
    [orderId],
  );
  const row = order.rows[0];
  if (!row) return null;
  const events = await query<OrderEventRow>(
    `SELECT id, order_id, event_type, before_status, after_status, note,
            actor_type, actor_id, metadata_json, created_at
     FROM shop_order_events
     WHERE order_id = $1
     ORDER BY created_at ASC`,
    [orderId],
  );
  return {
    ...mapAdminOrder(row),
    productSnapshot: row.product_snapshot_json,
    events: events.rows.map(mapOrderEvent),
  };
}

export async function updateOrderStatusForAdmin(params: {
  orderId: string;
  status: OrderStatus;
  note?: string;
  adminUserId: string;
}) {
  const before = await getOrderDetailForAdmin(params.orderId);
  if (!before) return null;
  const updated = await query<AdminOrderRow>(
    `UPDATE shop_orders
     SET status = $2, updated_at = NOW()
     WHERE id = $1
     RETURNING id, user_id, NULL::text AS username, NULL::text AS nickname, NULL::text AS phone,
               product_id, NULL::text AS product_name, payment_method, quantity,
               energy_spent, rmb_amount, status, created_at, updated_at`,
    [params.orderId, params.status],
  );
  await writeOrderEvent({
    orderId: params.orderId,
    eventType: 'status_changed',
    beforeStatus: before.status,
    afterStatus: params.status,
    note: params.note,
    actorType: 'admin',
    actorId: params.adminUserId,
  });
  return { before, after: mapAdminOrder(updated.rows[0]!) };
}
