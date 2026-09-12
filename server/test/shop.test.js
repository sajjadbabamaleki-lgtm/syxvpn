import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, seedGateway, seedEgress } from './helpers.js';
import { createPaymentWatcher } from '../src/services/payments.js';
import { toMicro } from '../src/domain/shop.js';

const PAY_ADDRESS = 'TLabAddressForTestsOnly000000000000';
const USDT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';

const shopConfig = (overrides = {}) => ({
  enabled: true,
  sessionTtlSeconds: 3600,
  payAddress: PAY_ADDRESS,
  tronApiUrl: 'https://api.trongrid.io',
  tronApiKey: '',
  usdtContract: USDT,
  paymentWindowMinutes: 60,
  pollSeconds: 30,
  confirmations: 19,
  maxOpenOrders: 2,
  watcherEnabled: true,
  supportContact: '',
  ...overrides,
});

/** In-memory stand-in for TronGrid so payment logic is tested without a chain. */
function fakeTron({ transfers = [], latestBlock = 1000, statuses = {} } = {}) {
  return {
    transfers,
    async incomingTransfers() { return this.transfers; },
    async latestBlock() { return latestBlock; },
    async transactionStatus(txHash) {
      return statuses[txHash] || { found: true, blockNumber: latestBlock - 30, success: true };
    },
  };
}

async function usableGateway(ctx, token) {
  const gateway = await seedGateway(ctx, token);
  const egress = await seedEgress(ctx, token);
  await ctx.request('POST', `/api/v1/gateways/${gateway.id}/egresses`, {
    token, body: { egressId: egress.id, priority: 10 },
  });
  ctx.db.prepare("UPDATE gateways SET ingress_status='online', ingress_checked_at=? WHERE id=?")
    .run(Date.now(), gateway.id);
  ctx.db.prepare("UPDATE gateway_egress SET status='online', checked_at=? WHERE gateway_id=?")
    .run(Date.now(), gateway.id);
  return gateway;
}

test('storefront: accounts, plans and USDT orders', async (t) => {
  const ctx = await startTestServer();
  t.after(() => ctx.close());
  const adminToken = await ctx.login();
  await usableGateway(ctx, adminToken);

  let plan;
  let customerToken;

  await t.test('an operator creates a sellable plan', async () => {
    const res = await ctx.request('POST', '/api/v1/plans', {
      token: adminToken,
      body: { name: '50 GB · 30 days', quotaGb: 50, durationDays: 30, priceUsdt: 4.5 },
    });
    assert.equal(res.status, 201);
    plan = res.body.data;
    assert.equal(plan.priceUsdt, 4.5);
    assert.equal(plan.priceMicro, 4500000);
    assert.equal(plan.quotaBytes, 50 * 1024 ** 3);
  });

  await t.test('plans are public but plan management is not', async () => {
    const publicList = await ctx.request('GET', '/api/v1/shop/plans');
    assert.equal(publicList.status, 200);
    assert.equal(publicList.body.data.length, 1);

    const unauthorised = await ctx.request('POST', '/api/v1/plans', {
      body: { name: 'free', quotaGb: 1, durationDays: 1, priceUsdt: 0.01 },
    });
    assert.equal(unauthorised.status, 401);
  });

  await t.test('registration creates a session', async () => {
    const res = await ctx.request('POST', '/api/v1/shop/register', {
      body: { email: 'Buyer@Example.com', password: 'a-good-password' },
    });
    assert.equal(res.status, 201);
    customerToken = res.body.data.token;
    // Email is normalised, and no password material is echoed back.
    assert.equal(res.body.data.customer.email, 'buyer@example.com');
    assert.ok(!JSON.stringify(res.body).includes('a-good-password'));
  });

  await t.test('a duplicate email is rejected', async () => {
    const res = await ctx.request('POST', '/api/v1/shop/register', {
      body: { email: 'buyer@example.com', password: 'another-password' },
    });
    assert.equal(res.status, 409);
  });

  await t.test('a wrong password does not sign in', async () => {
    const res = await ctx.request('POST', '/api/v1/shop/login', {
      body: { email: 'buyer@example.com', password: 'wrong-password' },
    });
    assert.equal(res.status, 401);
  });

  await t.test('a customer session cannot reach the admin API', async () => {
    const res = await ctx.request('GET', '/api/v1/gateways', { token: customerToken });
    assert.equal(res.status, 401);
  });

  await t.test('an admin session cannot impersonate a customer', async () => {
    const res = await ctx.request('GET', '/api/v1/shop/me', { token: adminToken });
    assert.equal(res.status, 401);
  });

  await t.test('a new customer has no subscription yet', async () => {
    const res = await ctx.request('GET', '/api/v1/shop/me', { token: customerToken });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.subscription, null);
    assert.deepEqual(res.body.data.orders, []);
  });

  await t.test('ordering is refused when no payment address is configured', async () => {
    const res = await ctx.request('POST', '/api/v1/shop/orders', {
      token: customerToken, body: { planId: plan.id },
    });
    assert.equal(res.status, 400);
    assert.match(res.body.error.message, /not configured/i);
  });
});

test('storefront: a by-the-gigabyte plan is bought by the unit', async (t) => {
  const ctx = await startTestServer();
  t.after(() => ctx.close());
  const adminToken = await ctx.login();
  await usableGateway(ctx, adminToken);

  // Payments on, and the by-the-gigabyte shelf open, for this suite only.
  const { config } = await import('../src/config.js');
  const originalShop = { ...config.shop };
  Object.assign(config.shop, shopConfig({ volumeSales: true, maxOrderUnits: 50 }));
  t.after(() => Object.assign(config.shop, originalShop));

  // The unit being sold: 10 GB, priced per unit rather than per plan.
  const created = await ctx.request('POST', '/api/v1/plans', {
    token: adminToken,
    body: {
      name: 'Configs · by the gigabyte',
      quotaGb: 10,
      durationDays: 30,
      priceUsdt: 1,
      product: 'configs',
      billing: 'volume',
    },
  });
  assert.equal(created.status, 201);
  const unit = created.body.data;

  const register = await ctx.request('POST', '/api/v1/shop/register', {
    body: { email: 'sizes@example.com', password: 'a-good-password' },
  });
  const token = register.body.data.token;

  await t.test('a size multiplies both the quota and the price', async () => {
    const res = await ctx.request('POST', '/api/v1/shop/orders', {
      token, body: { planId: unit.id, units: 12 },
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.data.quotaBytes, 120 * 1024 ** 3);
    assert.equal(res.body.data.priceUsdt, 12);
    // The order names the size, not the plan it was built from.
    assert.match(res.body.data.planName, /12/);
    await ctx.request('POST', `/api/v1/shop/orders/${res.body.data.id}/cancel`, { token });
  });

  await t.test('a size past the ceiling is refused', async () => {
    const res = await ctx.request('POST', '/api/v1/shop/orders', {
      token, body: { planId: unit.id, units: 400 },
    });
    assert.equal(res.status, 400);
  });

  await t.test('a plan sold by time cannot be bought in multiples', async () => {
    const monthly = await ctx.request('POST', '/api/v1/plans', {
      token: adminToken,
      body: { name: 'Monthly', quotaGb: 0, durationDays: 30, priceUsdt: 6 },
    });
    const res = await ctx.request('POST', '/api/v1/shop/orders', {
      token, body: { planId: monthly.body.data.id, units: 3 },
    });
    assert.equal(res.status, 400);
  });
});

test('storefront: a listed address gets the VPN product without buying it', async (t) => {
  const ctx = await startTestServer();
  t.after(() => ctx.close());
  const adminToken = await ctx.login();
  await usableGateway(ctx, adminToken);

  const { config } = await import('../src/config.js');
  const originalShop = { ...config.shop };
  Object.assign(config.shop, shopConfig({ compedEmails: ['carried@example.com'], compedDays: 365 }));
  t.after(() => Object.assign(config.shop, originalShop));

  await t.test('a listed address is carried from its first sign-in', async () => {
    const res = await ctx.request('POST', '/api/v1/shop/register', {
      body: { email: 'Carried@example.com', password: 'a-good-password' },
    });
    assert.equal(res.status, 201);
    const me = await ctx.request('GET', '/api/v1/shop/me', { token: res.body.data.token });
    assert.equal(me.status, 200);
    assert.ok(me.body.data.subscription, 'a listed address has a subscription without an order');
    // Unmetered: there is no quota on a grant, only a date.
    assert.equal(me.body.data.subscription.quotaBytes, 0);
    assert.deepEqual(me.body.data.orders, []);
  });

  await t.test('an address that is not listed gets nothing', async () => {
    const res = await ctx.request('POST', '/api/v1/shop/register', {
      body: { email: 'paying@example.com', password: 'a-good-password' },
    });
    const me = await ctx.request('GET', '/api/v1/shop/me', { token: res.body.data.token });
    assert.equal(me.body.data.subscription, null);
  });

  await t.test('the grant covers both tabs, not just the VPN one', async () => {
    const row = ctx.db.prepare('SELECT product, quota_bytes FROM subscribers WHERE name = ?')
      .get('carried@example.com');
    assert.equal(row.product, 'all');
    assert.equal(row.quota_bytes, 0);
  });

  await t.test('the grant is renewed rather than duplicated on the next sign-in', async () => {
    const before = ctx.db.prepare('SELECT COUNT(*) n FROM subscribers WHERE customer_id IS NOT NULL').get().n;
    const again = await ctx.request('POST', '/api/v1/shop/login', {
      body: { email: 'carried@example.com', password: 'a-good-password' },
    });
    assert.equal(again.status, 200);
    const after = ctx.db.prepare('SELECT COUNT(*) n FROM subscribers WHERE customer_id IS NOT NULL').get().n;
    assert.equal(after, before);
  });
});

test('storefront: on-chain settlement', async (t) => {
  const ctx = await startTestServer();
  t.after(() => ctx.close());
  const adminToken = await ctx.login();
  await usableGateway(ctx, adminToken);

  // Point the storefront at a payment address for this suite.
  const { config } = await import('../src/config.js');
  const originalShop = { ...config.shop };
  Object.assign(config.shop, shopConfig());
  t.after(() => Object.assign(config.shop, originalShop));

  const plan = (await ctx.request('POST', '/api/v1/plans', {
    token: adminToken,
    body: { name: '10 GB · 30 days', quotaGb: 10, durationDays: 30, priceUsdt: 2 },
  })).body.data;

  const customerToken = (await ctx.request('POST', '/api/v1/shop/register', {
    body: { email: 'chain@example.com', password: 'a-good-password' },
  })).body.data.token;

  let order;

  await t.test('an order asks for a unique, exact amount', async () => {
    const res = await ctx.request('POST', '/api/v1/shop/orders', {
      token: customerToken, body: { planId: plan.id },
    });
    assert.equal(res.status, 201);
    order = res.body.data;
    assert.equal(order.status, 'pending');
    assert.equal(order.payAddress, PAY_ADDRESS);
    assert.equal(order.asset, 'USDT-TRC20');
    assert.equal(order.payAmountMicro, toMicro(2));

    // A second customer's order for the same plan gets a different amount, so a
    // transfer is attributable to exactly one of them.
    const otherToken = (await ctx.request('POST', '/api/v1/shop/register', {
      body: { email: 'second@example.com', password: 'a-good-password' },
    })).body.data.token;
    const other = await ctx.request('POST', '/api/v1/shop/orders', {
      token: otherToken, body: { planId: plan.id },
    });
    assert.notEqual(other.body.data.payAmountMicro, order.payAmountMicro);
  });

  await t.test('claiming to have paid does not provision anything', async () => {
    const res = await ctx.request('GET', `/api/v1/shop/orders/${order.id}`, { token: customerToken });
    assert.equal(res.body.data.status, 'pending');
    assert.equal(res.body.data.subscription, null);
    const me = await ctx.request('GET', '/api/v1/shop/me', { token: customerToken });
    assert.equal(me.body.data.subscription, null);
  });

  await t.test('an unconfirmed transfer is shown as seen but not fulfilled', async () => {
    const client = fakeTron({
      latestBlock: 1000,
      transfers: [{
        txHash: 'tx-unconfirmed',
        from: 'TCustomerAddress',
        to: PAY_ADDRESS,
        amountMicro: order.payAmountMicro,
        contract: USDT,
        timestamp: Date.now(),
      }],
      statuses: { 'tx-unconfirmed': { found: true, blockNumber: 995, success: true } },
    });
    const watcher = createPaymentWatcher(ctx.db, { cfg: shopConfig(), client });
    const summary = await watcher.tick();
    assert.equal(summary.matched, 1);
    assert.equal(summary.settled, 0);
    assert.equal(summary.pendingConfirmation, 1);

    const res = await ctx.request('GET', `/api/v1/shop/orders/${order.id}`, { token: customerToken });
    assert.equal(res.body.data.status, 'paid');
    assert.equal(res.body.data.subscription, null);
  });

  await t.test('a confirmed transfer settles the order and provisions a subscription', async () => {
    const client = fakeTron({
      latestBlock: 1000,
      transfers: [{
        txHash: 'tx-confirmed',
        from: 'TCustomerAddress',
        to: PAY_ADDRESS,
        amountMicro: order.payAmountMicro,
        contract: USDT,
        timestamp: Date.now(),
      }],
      statuses: { 'tx-confirmed': { found: true, blockNumber: 900, success: true } },
    });
    const watcher = createPaymentWatcher(ctx.db, { cfg: shopConfig(), client });
    const summary = await watcher.tick();
    assert.equal(summary.settled, 1);

    const res = await ctx.request('GET', `/api/v1/shop/orders/${order.id}`, { token: customerToken });
    assert.equal(res.body.data.status, 'fulfilled');
    assert.equal(res.body.data.txHash, 'tx-confirmed');
    assert.equal(res.body.data.settledBy, 'chain');

    const subscription = res.body.data.subscription;
    assert.ok(subscription, 'a subscription is provisioned');
    assert.equal(subscription.quotaBytes, 10 * 1024 ** 3);
    assert.match(subscription.subscriptionUrl, /\/sub\/[A-Za-z0-9_-]{40,}$/);
    assert.equal(subscription.profiles.length, 1);
    assert.match(subscription.profiles[0].uri, /^vless:\/\//);
  });

  await t.test('the subscription URL actually serves the profile', async () => {
    const me = await ctx.request('GET', '/api/v1/shop/me', { token: customerToken });
    const url = new URL(me.body.data.subscription.subscriptionUrl);
    const res = await ctx.request('GET', url.pathname);
    assert.equal(res.status, 200);
    const decoded = Buffer.from(res.text, 'base64').toString('utf8');
    assert.match(decoded, /^vless:\/\//);
  });

  await t.test('replaying the same transfer does not provision twice', async () => {
    const before = ctx.db.prepare('SELECT count(*) AS n FROM subscribers').get().n;
    const client = fakeTron({
      latestBlock: 1000,
      transfers: [{
        txHash: 'tx-confirmed',
        from: 'TCustomerAddress',
        to: PAY_ADDRESS,
        amountMicro: order.payAmountMicro,
        contract: USDT,
        timestamp: Date.now(),
      }],
    });
    const watcher = createPaymentWatcher(ctx.db, { cfg: shopConfig(), client });
    const summary = await watcher.tick();
    assert.equal(summary.settled, 0);
    assert.equal(ctx.db.prepare('SELECT count(*) AS n FROM subscribers').get().n, before);
  });

  await t.test('a transfer with no matching amount is ignored', async () => {
    const client = fakeTron({
      transfers: [{
        txHash: 'tx-stranger', from: 'TSomeone', to: PAY_ADDRESS,
        amountMicro: 999999, contract: USDT, timestamp: Date.now(),
      }],
    });
    const watcher = createPaymentWatcher(ctx.db, { cfg: shopConfig(), client });
    const summary = await watcher.tick();
    assert.equal(summary.matched, 0);
    assert.equal(summary.settled, 0);
  });

  await t.test('a failed transaction never settles an order', async () => {
    const second = (await ctx.request('POST', '/api/v1/shop/orders', {
      token: customerToken, body: { planId: plan.id },
    })).body.data;
    const client = fakeTron({
      transfers: [{
        txHash: 'tx-reverted', from: 'TSomeone', to: PAY_ADDRESS,
        amountMicro: second.payAmountMicro, contract: USDT, timestamp: Date.now(),
      }],
      statuses: { 'tx-reverted': { found: true, blockNumber: 900, success: false } },
    });
    const watcher = createPaymentWatcher(ctx.db, { cfg: shopConfig(), client });
    const summary = await watcher.tick();
    assert.equal(summary.settled, 0);
    const res = await ctx.request('GET', `/api/v1/shop/orders/${second.id}`, { token: customerToken });
    assert.equal(res.body.data.status, 'pending');
    await ctx.request('POST', `/api/v1/shop/orders/${second.id}/cancel`, { token: customerToken });
  });

  await t.test('renewal tops up the same subscription URL instead of issuing a new one', async () => {
    const before = (await ctx.request('GET', '/api/v1/shop/me', { token: customerToken })).body.data.subscription;
    const renewal = (await ctx.request('POST', '/api/v1/shop/orders', {
      token: customerToken, body: { planId: plan.id },
    })).body.data;
    const client = fakeTron({
      transfers: [{
        txHash: 'tx-renewal', from: 'TCustomerAddress', to: PAY_ADDRESS,
        amountMicro: renewal.payAmountMicro, contract: USDT, timestamp: Date.now(),
      }],
      statuses: { 'tx-renewal': { found: true, blockNumber: 900, success: true } },
    });
    await createPaymentWatcher(ctx.db, { cfg: shopConfig(), client }).tick();

    const after = (await ctx.request('GET', '/api/v1/shop/me', { token: customerToken })).body.data.subscription;
    assert.equal(after.id, before.id, 'same subscription');
    assert.equal(after.subscriptionUrl, before.subscriptionUrl, 'same URL, so the client keeps working');
    assert.ok(new Date(after.expiresAt) > new Date(before.expiresAt), 'expiry extended');
    assert.equal(after.quotaBytes, 20 * 1024 ** 3, 'remaining quota plus the new plan');
  });

  await t.test('an order expires when it is not paid in time', async () => {
    const stale = (await ctx.request('POST', '/api/v1/shop/orders', {
      token: customerToken, body: { planId: plan.id },
    })).body.data;
    ctx.db.prepare('UPDATE orders SET expires_at = ? WHERE id = ?').run(Date.now() - 1000, stale.id);
    await createPaymentWatcher(ctx.db, { cfg: shopConfig(), client: fakeTron() }).tick();
    const res = await ctx.request('GET', `/api/v1/shop/orders/${stale.id}`, { token: customerToken });
    assert.equal(res.body.data.status, 'expired');
  });

  await t.test('a customer cannot read another customer order', async () => {
    const otherToken = (await ctx.request('POST', '/api/v1/shop/register', {
      body: { email: 'nosy@example.com', password: 'a-good-password' },
    })).body.data.token;
    const res = await ctx.request('GET', `/api/v1/shop/orders/${order.id}`, { token: otherToken });
    assert.equal(res.status, 404);
  });

  await t.test('an operator can settle a payment by hand, recorded as such', async () => {
    const manual = (await ctx.request('POST', '/api/v1/shop/orders', {
      token: customerToken, body: { planId: plan.id },
    })).body.data;
    const res = await ctx.request('POST', `/api/v1/orders/${manual.id}/settle`, {
      token: adminToken, body: { note: 'paid by direct transfer' },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.order.status, 'fulfilled');
    assert.equal(res.body.data.order.settledBy, 'admin:admin');
    const events = await ctx.request('GET', '/api/v1/events', { token: adminToken });
    assert.ok(events.body.data.some((e) => e.type === 'order.settled_manually'));
  });
});
