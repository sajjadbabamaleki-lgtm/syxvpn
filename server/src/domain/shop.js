import { newId, randomToken, sha256, hashPassword, verifyPassword } from '../lib/crypto.js';
import { conflict, badRequest, notFound } from '../lib/errors.js';
import { recordEvent } from './events.js';
import { createSubscriber, subscriberForCustomer, topUpSubscriber, getSubscriber } from './subscribers.js';
import { config } from '../config.js';

/**
 * Storefront domain: customers, plans and USDT orders.
 *
 * Money is handled in micro-USDT integers (1 USDT = 1_000_000), which is also
 * the on-chain precision of TRC-20 USDT, so an order amount compares exactly
 * against a transfer value with no rounding anywhere.
 */

export const MICRO = 1_000_000;
export const toMicro = (usdt) => Math.round(Number(usdt) * MICRO);
export const fromMicro = (micro) => Number(micro) / MICRO;

// ---------------------------------------------------------------- customers

export function registerCustomer(db, { email, password }) {
  const normalized = String(email).trim().toLowerCase();
  const existing = db.prepare('SELECT id FROM customers WHERE email = ?').get(normalized);
  if (existing) throw conflict('An account with this email already exists');
  const now = Date.now();
  const id = newId('cus');
  db.prepare('INSERT INTO customers (id,email,password_hash,created_at,updated_at) VALUES (?,?,?,?,?)')
    .run(id, normalized, hashPassword(password), now, now);
  recordEvent(db, {
    type: 'customer.registered', targetType: 'customer', targetId: id,
    message: `Customer account created (${normalized})`,
  });
  return { id, email: normalized };
}

export function loginCustomer(db, { email, password, userAgent }) {
  const normalized = String(email).trim().toLowerCase();
  const customer = db.prepare('SELECT * FROM customers WHERE email = ?').get(normalized);
  // Constant work whether or not the account exists.
  const stored = customer?.password_hash
    || 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
  const okPassword = verifyPassword(password, stored);
  if (!customer || !okPassword || customer.status !== 'active') return null;

  const token = randomToken(32);
  const now = Date.now();
  const expiresAt = now + config.shop.sessionTtlSeconds * 1000;
  db.prepare(`INSERT INTO customer_sessions (token_hash,customer_id,created_at,expires_at,last_used_at,user_agent)
      VALUES (?,?,?,?,?,?)`)
    .run(sha256(token), customer.id, now, expiresAt, now, (userAgent || '').slice(0, 200));
  db.prepare('UPDATE customers SET last_login_at = ? WHERE id = ?').run(now, customer.id);
  db.prepare('DELETE FROM customer_sessions WHERE expires_at <= ?').run(now);
  return { token, expiresAt, customer: { id: customer.id, email: customer.email } };
}

export function logoutCustomer(db, token) {
  if (token) db.prepare('DELETE FROM customer_sessions WHERE token_hash = ?').run(sha256(token));
}

export function customerForSession(db, token) {
  if (!token) return null;
  const session = db.prepare('SELECT * FROM customer_sessions WHERE token_hash = ?').get(sha256(token));
  if (!session) return null;
  if (session.expires_at <= Date.now()) {
    db.prepare('DELETE FROM customer_sessions WHERE token_hash = ?').run(session.token_hash);
    return null;
  }
  const customer = db.prepare('SELECT id, email, status FROM customers WHERE id = ?').get(session.customer_id);
  if (!customer || customer.status !== 'active') return null;
  db.prepare('UPDATE customer_sessions SET last_used_at = ? WHERE token_hash = ?').run(Date.now(), session.token_hash);
  return customer;
}

// -------------------------------------------------------------------- plans

/**
 * Plans on sale.
 *
 * Volume plans come and go as a group: they are settled by hand, so there are
 * stretches where nobody is there to settle one, and a plan that cannot be
 * fulfilled should not be on the shelf. One switch turns the whole shelf off
 * rather than an operator remembering to disable each plan and re-enable it.
 */
export function listPlans(db, { includeDisabled = false, volumeSales = config.shop.volumeSales } = {}) {
  if (!includeDisabled && !volumeSales) {
    return db.prepare(
      "SELECT * FROM plans WHERE enabled = 1 AND billing != 'volume' ORDER BY sort_order, price_micro",
    ).all();
  }
  return listPlansRaw(db, { includeDisabled });
}

function listPlansRaw(db, { includeDisabled = false } = {}) {
  const where = includeDisabled ? '' : 'WHERE enabled = 1';
  return db.prepare(`SELECT * FROM plans ${where} ORDER BY sort_order, price_micro`).all();
}

export function getPlan(db, id) {
  return db.prepare('SELECT * FROM plans WHERE id = ?').get(id) || null;
}

export function createPlan(db, input) {
  const now = Date.now();
  const id = newId('plan');
  db.prepare(`INSERT INTO plans (id,name,description,quota_bytes,duration_days,price_micro,enabled,sort_order,product,billing,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, input.name, input.description ?? null, input.quotaBytes, input.durationDays,
      input.priceMicro, input.enabled === false ? 0 : 1, input.sortOrder ?? 100,
      input.product ?? 'vpn', input.billing ?? 'duration', now, now);
  return getPlan(db, id);
}

const PLAN_COLUMNS = {
  name: 'name', description: 'description', quotaBytes: 'quota_bytes',
  durationDays: 'duration_days', priceMicro: 'price_micro', enabled: 'enabled', sortOrder: 'sort_order',
};

export function updatePlan(db, id, patch) {
  if (!getPlan(db, id)) return null;
  const fields = [];
  const params = [];
  for (const [key, column] of Object.entries(PLAN_COLUMNS)) {
    if (patch[key] === undefined) continue;
    let value = patch[key];
    if (typeof value === 'boolean') value = value ? 1 : 0;
    fields.push(`${column} = ?`);
    params.push(value);
  }
  if (!fields.length) return getPlan(db, id);
  params.push(Date.now(), id);
  db.prepare(`UPDATE plans SET ${fields.join(', ')}, updated_at = ? WHERE id = ?`).run(...params);
  return getPlan(db, id);
}

export function deletePlan(db, id) {
  // Orders keep their own copy of the plan terms, so removing a plan never
  // rewrites the history of what someone bought.
  return db.prepare('DELETE FROM plans WHERE id = ?').run(id).changes > 0;
}

// ------------------------------------------------------------------- orders

/**
 * Picks an amount no other open order is waiting for, by adding a few
 * micro-USDT to the price. That makes an incoming transfer attributable to
 * exactly one order without allocating a deposit address per order.
 */
function uniqueAmount(db, priceMicro, now) {
  // A seen-but-unconfirmed order keeps its amount reserved until it settles.
  const taken = new Set(
    db.prepare(`SELECT pay_amount_micro FROM orders
        WHERE status = 'paid' OR (status = 'pending' AND expires_at > ?)`)
      .all(now).map((r) => r.pay_amount_micro),
  );
  for (let delta = 0; delta < 1000; delta += 1) {
    const candidate = priceMicro + delta;
    if (!taken.has(candidate)) return candidate;
  }
  throw conflict('Too many payments are pending; try again in a few minutes');
}

export function createOrder(db, customerId, planId) {
  if (!config.shop.payAddress) {
    throw badRequest('Payments are not configured on this deployment');
  }
  const plan = getPlan(db, planId);
  // Not merely enabled: on sale. A by-the-gigabyte plan is settled by hand, and
  // while nobody is there to settle one it is off the shelf — which has to mean
  // it cannot be ordered, not just that it is not listed. A plan id is not a
  // secret; it was in the response the last time the shelf was up.
  if (!plan || plan.enabled !== 1) throw notFound('Plan');
  if (plan.billing === 'volume' && !config.shop.volumeSales) throw notFound('Plan');

  const now = Date.now();
  expireStaleOrders(db, now);

  const open = db.prepare(`SELECT id FROM orders
      WHERE customer_id = ? AND (status = 'paid' OR (status = 'pending' AND expires_at > ?))`)
    .all(customerId, now);
  if (open.length >= config.shop.maxOpenOrders) {
    throw conflict('You already have a payment waiting. Finish or cancel it first.');
  }

  const id = newId('ord');
  const payAmount = uniqueAmount(db, plan.price_micro, now);
  db.prepare(`INSERT INTO orders
      (id,customer_id,plan_id,plan_name,quota_bytes,duration_days,status,price_micro,pay_amount_micro,
       pay_address,chain,asset,created_at,expires_at,product)
      VALUES (?,?,?,?,?,?, 'pending', ?,?,?,?,?,?,?,?)`)
    .run(id, customerId, plan.id, plan.name, plan.quota_bytes, plan.duration_days,
      plan.price_micro, payAmount, config.shop.payAddress, 'tron', 'USDT-TRC20',
      // The plan carries the product, but a plan can be edited or deleted after
      // the sale, and an order is the record of what was actually bought.
      now, now + config.shop.paymentWindowMinutes * 60000, plan.product);

  recordEvent(db, {
    type: 'order.created', targetType: 'order', targetId: id,
    message: `Order for ${plan.name} awaiting ${fromMicro(payAmount)} USDT`,
    data: { planId: plan.id, amountMicro: payAmount },
  });
  return getOrder(db, id);
}

export function getOrder(db, id) {
  return db.prepare('SELECT * FROM orders WHERE id = ?').get(id) || null;
}

export function listOrders(db, customerId, limit = 20) {
  return db.prepare('SELECT * FROM orders WHERE customer_id = ? ORDER BY created_at DESC LIMIT ?')
    .all(customerId, limit);
}

export function cancelOrder(db, id, customerId) {
  const info = db.prepare(
    "UPDATE orders SET status = 'cancelled' WHERE id = ? AND customer_id = ? AND status = 'pending'",
  ).run(id, customerId);
  return info.changes > 0;
}

export function expireStaleOrders(db, now = Date.now()) {
  const stale = db.prepare("SELECT id FROM orders WHERE status = 'pending' AND expires_at <= ?").all(now);
  if (!stale.length) return 0;
  db.prepare("UPDATE orders SET status = 'expired' WHERE status = 'pending' AND expires_at <= ?").run(now);
  return stale.length;
}

export function openOrders(db, now = Date.now()) {
  return db.prepare(`SELECT * FROM orders
      WHERE status = 'paid' OR (status = 'pending' AND expires_at > ?)`).all(now);
}

/**
 * Marks an order paid and provisions it.
 *
 * Fulfilment is idempotent and runs in one transaction with the payment record,
 * so a payment can never be recorded without the subscription it bought.
 */
export function settleOrder(db, orderId, { txHash, fromAddress, confirmations, settledBy = 'chain' }) {
  const order = getOrder(db, orderId);
  if (!order) return null;
  if (order.status === 'fulfilled') return { order, alreadySettled: true };
  if (order.status !== 'pending' && order.status !== 'paid') {
    throw conflict(`Order is ${order.status} and cannot be settled`);
  }

  const now = Date.now();
  let subscriberId = null;

  const run = db.transaction(() => {
    // The subscription for the product this order was for. Buying Configs must
    // not top up the quota the VPN tab is spending, which is what one shared
    // subscription per customer meant.
    const existing = subscriberForCustomer(db, order.customer_id, order.product);
    if (existing) {
      topUpSubscriber(db, existing.id, {
        quotaBytes: order.quota_bytes,
        durationDays: order.duration_days,
      });
      subscriberId = existing.id;
    } else {
      const customer = db.prepare('SELECT email FROM customers WHERE id = ?').get(order.customer_id);
      const created = createSubscriber(db, {
        name: customer?.email || order.customer_id,
        quotaBytes: order.quota_bytes,
        expiresAt: now + order.duration_days * 86400000,
        note: `created by order ${order.id}`,
        customerId: order.customer_id,
        product: order.product,
      });
      subscriberId = created.id;
    }

    db.prepare(`UPDATE orders SET status = 'fulfilled', tx_hash = ?, from_address = ?, confirmations = ?,
        settled_by = ?, paid_at = COALESCE(paid_at, ?), fulfilled_at = ?, subscriber_id = ?
        WHERE id = ?`)
      .run(txHash ?? null, fromAddress ?? null, confirmations ?? null, settledBy, now, now, subscriberId, order.id);

    recordEvent(db, {
      type: 'order.fulfilled', targetType: 'order', targetId: order.id,
      message: `Order ${order.id} settled (${fromMicro(order.pay_amount_micro)} USDT via ${settledBy}) and provisioned`,
      data: { txHash, subscriberId, settledBy },
    });
  });
  run();

  return { order: getOrder(db, orderId), subscriber: getSubscriber(db, subscriberId) };
}

/**
 * Finds the open order an incoming transfer pays for, by exact amount.
 *
 * `paid` is included so a transfer that was seen before it had enough
 * confirmations is still settled on a later pass.
 */
export function matchOrderForTransfer(db, { amountMicro, timestamp }) {
  return db.prepare(`SELECT * FROM orders
      WHERE pay_amount_micro = ?
        AND (status = 'paid' OR (status = 'pending' AND expires_at >= ?))
        AND created_at <= ?
      ORDER BY created_at LIMIT 1`)
    .get(amountMicro, timestamp - 60000, timestamp + 60000) || null;
}

export function transferAlreadyApplied(db, txHash) {
  return Boolean(db.prepare('SELECT 1 FROM orders WHERE tx_hash = ?').get(txHash));
}
