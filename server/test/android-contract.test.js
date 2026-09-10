import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';
import { clientProfile } from '../src/domain/xray.js';

/**
 * The Android client reads these responses by hand (HttpURLConnection plus
 * kotlinx.serialization's JsonObject), so a renamed field would not fail any
 * build — it would fail on a customer's phone, in the middle of paying.
 *
 * Each list below is exactly what
 * `android/app/src/main/java/net/jordanvpn/app/data/ControlPlaneClient.kt`
 * looks up. Renaming a field on either side should break this test.
 */
const SHOP_CONFIG_PAYMENT = ['configured', 'chain', 'asset', 'address', 'contract', 'confirmations', 'windowMinutes'];
const PLAN = ['id', 'name', 'description', 'quotaBytes', 'durationDays', 'priceMicro'];
const ORDER = [
  'id', 'planName', 'status', 'quotaBytes', 'durationDays',
  'payAmountMicro', 'payAddress', 'chain', 'asset', 'confirmations', 'txHash', 'expiresAt',
];
const SUBSCRIPTION = ['active', 'state', 'usedBytes', 'quotaBytes', 'expiresAt', 'subscriptionUrl', 'profiles'];

const has = (object, keys, what) => keys.forEach((key) => {
  assert.ok(key in object, `${what} is missing "${key}" — the Android client reads it`);
});

test('the Android client reads fields the storefront actually returns', async (t) => {
  const ctx = await startTestServer();
  t.after(() => ctx.close());
  const adminToken = await ctx.login();

  const { config } = await import('../src/config.js');
  const originalShop = { ...config.shop };
  Object.assign(config.shop, {
    ...config.shop,
    enabled: true,
    payAddress: 'TLabAddressForTestsOnly000000000000',
    usdtContract: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
    confirmations: 19,
    paymentWindowMinutes: 60,
    maxOpenOrders: 2,
    supportContact: '@jordanhelp',
  });
  t.after(() => Object.assign(config.shop, originalShop));

  await t.test('GET /shop/config carries the payment block and the support contact', async () => {
    const res = await ctx.request('GET', '/api/v1/shop/config');
    assert.equal(res.status, 200);
    has(res.body.data.payment, SHOP_CONFIG_PAYMENT, 'shop config payment');
    // The Support tab shows this and turns it into a link; null means "not set",
    // which the app states rather than hiding behind a dead button.
    assert.equal(res.body.data.supportContact, '@jordanhelp');
  });

  await t.test('GET /shop/plans carries every field the plan card shows', async () => {
    await ctx.request('POST', '/api/v1/plans', {
      token: adminToken,
      body: { name: '50 GB · 30 days', quotaGb: 50, durationDays: 30, priceUsdt: 4.5 },
    });
    const res = await ctx.request('GET', '/api/v1/shop/plans');
    assert.equal(res.status, 200);
    has(res.body.data[0], PLAN, 'plan');
    // Money reaches the app as an integer; the app never formats through a float.
    assert.equal(res.body.data[0].priceMicro, 4_500_000);
  });

  await t.test('an order carries the exact amount and the address', async () => {
    const customerToken = (await ctx.request('POST', '/api/v1/shop/register', {
      body: { email: 'android@example.com', password: 'a-good-password' },
    })).body.data.token;
    const planId = (await ctx.request('GET', '/api/v1/shop/plans')).body.data[0].id;

    const created = await ctx.request('POST', '/api/v1/shop/orders', {
      token: customerToken, body: { planId } });
    assert.equal(created.status, 201);
    has(created.body.data, ORDER, 'order');
    assert.equal(created.body.data.status, 'pending');

    // The screen polls this while the payment is outstanding.
    const polled = await ctx.request('GET', `/api/v1/shop/orders/${created.body.data.id}`, {
      token: customerToken,
    });
    has(polled.body.data, ORDER, 'polled order');

    // And it finds an already open order when the tab is reopened.
    const list = await ctx.request('GET', '/api/v1/shop/orders', { token: customerToken });
    assert.equal(list.body.data.length, 1);
    has(list.body.data[0], ORDER, 'listed order');

    const me = await ctx.request('GET', '/api/v1/shop/me', { token: customerToken });
    assert.equal(me.body.data.subscription, null, 'an unpaid order provisions nothing');
  });

  await t.test('a subscription carries what the account and connect screens show', async () => {
    // Provision one directly: settlement is covered by shop.test.js, this is
    // about the shape the app parses.
    const customerToken = (await ctx.request('POST', '/api/v1/shop/register', {
      body: { email: 'subscribed@example.com', password: 'a-good-password' },
    })).body.data.token;
    const { createSubscriber } = await import('../src/domain/subscribers.js');
    const customerId = ctx.db.prepare('SELECT id FROM customers WHERE email = ?')
      .get('subscribed@example.com').id;
    createSubscriber(ctx.db, {
      name: 'android-contract',
      quotaBytes: 10 * 1024 ** 3,
      expiresAt: Date.now() + 30 * 86400000,
      customerId,
    });

    const res = await ctx.request('GET', '/api/v1/shop/me', { token: customerToken });
    assert.equal(res.status, 200);
    has(res.body.data.subscription, SUBSCRIPTION, 'subscription');
  });
});

/**
 * `VlessProfile.parse` reads these parameter names out of a `vless://` line,
 * and it cannot be unit-tested where it lives: it is built on android.net.Uri,
 * which is a stub on a JVM test runner. So the contract is pinned from this
 * side, where the profiles are generated.
 */
test('a REALITY profile carries the parameters the Android parser reads', () => {
  const gateway = {
    id: 'gw_r', name: 'Edge R', region: 'de', host: '203.0.113.9', port: 443,
    transport: 'reality', tls_mode: 'none',
    reality_dest: 'www.microsoft.com:443',
    reality_server_names: 'www.microsoft.com',
    reality_public_key: 'uNm292XHIOI0wHLfn5fiOOquk47pn6kjiYhqwermDjA',
    reality_short_ids: 'a1b2c3d4',
    reality_fingerprint: 'chrome',
  };
  const params = new URL(clientProfile(gateway, '11111111-2222-3333-4444-555555555555')).searchParams;
  // Reject the profile outright if any of these is missing: the app does.
  for (const key of ['security', 'type', 'flow', 'sni', 'fp', 'pbk', 'sid']) {
    assert.ok(params.get(key), `a REALITY profile must carry "${key}"`);
  }
  // The two the parser refuses to guess at.
  assert.equal(params.get('security'), 'reality');
  assert.equal(params.get('type'), 'tcp');
});
