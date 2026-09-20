import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';
import { clientProfile } from '../src/domain/xray.js';
import { inboundProfile } from '../src/domain/inbounds.js';

/**
 * The Android client reads these responses by hand (HttpURLConnection plus
 * kotlinx.serialization's JsonObject), so a renamed field would not fail any
 * build — it would fail on a customer's phone, in the middle of paying.
 *
 * Each list below is exactly what
 * `android/app/src/main/java/pro/syxvpn/app/data/ControlPlaneClient.kt`
 * looks up. Renaming a field on either side should break this test.
 */
const SHOP_CONFIG_PAYMENT = ['configured', 'chain', 'asset', 'address', 'contract', 'confirmations', 'windowMinutes'];
// product and billing are new: a plan card that does not say which of the two
// things it buys, and whether it is by time or by the gigabyte, is a refund
// request.
const PLAN = ['id', 'name', 'description', 'quotaBytes', 'durationDays', 'priceMicro', 'product', 'billing'];
const ORDER = [
  'id', 'planName', 'status', 'quotaBytes', 'durationDays',
  'payAmountMicro', 'payAddress', 'chain', 'asset', 'confirmations', 'txHash', 'expiresAt',
];
// The installed app reads `subscription`; the next one reads `subscriptions`,
// one per product. Both are served until every phone has been replaced.
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
    supportContact: '@syxvpnsupport',
    // The app reads this to decide whether to offer the trial on its first
    // screen, so the contract covers it like any other field it parses.
    trialDays: 3,
    trialGb: 1,
  });
  t.after(() => Object.assign(config.shop, originalShop));

  await t.test('GET /shop/config carries the payment block and the support contact', async () => {
    const res = await ctx.request('GET', '/api/v1/shop/config');
    assert.equal(res.status, 200);
    has(res.body.data.payment, SHOP_CONFIG_PAYMENT, 'shop config payment');
    // The Support tab shows this and turns it into a link; null means "not set",
    // which the app states rather than hiding behind a dead button.
    assert.equal(res.body.data.supportContact, '@syxvpnsupport');
    // The first screen offers the trial from these numbers rather than from
    // anything compiled into the build, so an operator can change the offer
    // without shipping an APK.
    assert.deepEqual(res.body.data.trial, { days: 3, gb: 1 });
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

    // An unpaid order provisions nothing. Said against what the account is
    // actually carrying rather than against "no subscription at all": this
    // deployment hands every new account a trial, so absence stopped being
    // the evidence and the trial's own size is.
    const me = await ctx.request('GET', '/api/v1/shop/me', { token: customerToken });
    assert.equal(me.body.data.subscription.quotaBytes, 1024 * 1024 * 1024, 'still only the trial');
    assert.equal(me.body.data.orders[0].status, 'pending', 'and the order is still unpaid');
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

/**
 * The same pinning, for the profiles of the other doors.
 *
 * `ShadowsocksProfile.parse` and `TrojanProfile.parse` are the client side of
 * this, and they live in a repository this test cannot import. What they need
 * is small and exact, and every one of these assertions is a line of that
 * parser: get one wrong and the app reads a profile it was handed as garbage,
 * on a phone, at the moment its usual door stopped working.
 */
test('the extra-inbound profiles carry what the Android parsers read', async (t) => {
  const gateway = {
    id: 'gw_x', name: 'Edge A', region: 'de', host: '203.0.113.4', port: 443,
    sni: 'edge.example.net',
  };
  const uuid = '11111111-2222-3333-4444-555555555555';

  await t.test('shadowsocks is SIP002: base64url userinfo, explicit port', () => {
    const inbound = {
      id: 'ib_ss', kind: 'shadowsocks', port: 8388,
      method: '2022-blake3-aes-256-gcm', server_key: Buffer.alloc(32, 7).toString('base64'),
    };
    const uri = inboundProfile(gateway, inbound, uuid);
    assert.match(uri, /^ss:\/\//);
    const [userinfo, address] = uri.slice('ss://'.length).split('#')[0].split('@');
    // Base64url, because the standard alphabet's '+' and '/' do not survive a
    // URL, and the client decodes both but is written this one.
    assert.ok(!/[+/]/.test(userinfo), 'userinfo must be base64url');
    const decoded = Buffer.from(userinfo, 'base64url').toString('utf8');
    // method:serverKey:userKey — the client splits on the FIRST colon and
    // treats the rest as the password, which is what Xray wants.
    const [method, ...rest] = decoded.split(':');
    assert.equal(method, '2022-blake3-aes-256-gcm');
    assert.equal(rest.length, 2, 'a 2022 password is both keys, joined');
    for (const key of rest) assert.equal(Buffer.from(key, 'base64').length, 32);
    // The port is never implied: the parser refuses a line without one.
    assert.match(address, /^203\.0\.113\.4:8388$/);
  });

  await t.test('trojan says it is TLS and which name to claim', () => {
    const uri = inboundProfile(gateway, { id: 'ib_tj', kind: 'trojan', port: 8443 }, uuid);
    const parsed = new URL(uri);
    assert.equal(parsed.protocol, 'trojan:');
    assert.ok(parsed.username, 'the password is the userinfo');
    // security=none is refused by the client outright, so it must never be
    // written: trojan without TLS cannot work at all.
    assert.equal(parsed.searchParams.get('security'), 'tls');
    assert.equal(parsed.searchParams.get('sni'), 'edge.example.net');
  });

  await t.test('a second REALITY door is a vless line the existing parser reads', () => {
    const inbound = {
      id: 'ib_re', kind: 'reality', port: 8444,
      reality_server_names: 'www.microsoft.com',
      reality_short_ids: 'a1b2c3d4',
      reality_public_key: 'uNm292XHIOI0wHLfn5fiOOquk47pn6kjiYhqwermDjA',
      reality_fingerprint: 'chrome',
    };
    const params = new URL(inboundProfile(gateway, inbound, uuid)).searchParams;
    for (const key of ['security', 'type', 'flow', 'sni', 'fp', 'pbk', 'sid']) {
      assert.ok(params.get(key), `a REALITY profile must carry "${key}"`);
    }
    assert.equal(params.get('security'), 'reality');
    assert.equal(params.get('type'), 'tcp');
  });

  await t.test('a label keeps the region ahead of the protocol', () => {
    // The client reads the country off the label when a subscription is fetched
    // as a plain list, because that form carries no region field at all.
    const uri = inboundProfile(gateway, { id: 'ib_re2', kind: 'reality', port: 8445 }, uuid);
    const label = decodeURIComponent(uri.split('#')[1]);
    assert.equal(label, 'Edge A · de · reality');
  });
});
