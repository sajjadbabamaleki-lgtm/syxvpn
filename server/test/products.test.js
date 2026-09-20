import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';
import { config } from '../src/config.js';

/**
 * The VPN tab and the Configs tab are two products, sold separately.
 *
 * They used to share one subscription per customer, which meant buying Configs
 * topped up the quota the VPN tab was spending — a customer paying for one
 * thing and being given more of another.
 */
const shop = (ctx) => async (path, opts) => ctx.request(opts?.method || 'GET', `/api/v1/shop${path}`, opts);

async function setup(t) {
  const ctx = await startTestServer();
  t.after(() => ctx.close());
  const admin = await ctx.login();

  const original = { ...config.shop };
  Object.assign(config.shop, {
    ...config.shop,
    enabled: true,
    // Off: this suite watches accounts that have bought nothing.
    trialDays: 0,
    payAddress: 'TLabAddressForTestsOnly000000000000',
    paymentWindowMinutes: 60,
    maxOpenOrders: 5,
    volumeSales: false,
  });
  t.after(() => Object.assign(config.shop, original));

  const plan = async (body) => (await ctx.request('POST', '/api/v1/plans', { token: admin, body })).body.data;
  const vpn = await plan({ name: 'VPN · 1 month', product: 'vpn', quotaGb: 100, durationDays: 30, priceUsdt: 3 });
  const configsMonthly = await plan({
    name: 'Configs · 1 month', product: 'configs', quotaGb: 100, durationDays: 30, priceUsdt: 3,
  });
  const configsVolume = await plan({
    name: 'Configs · 2 GB', product: 'configs', billing: 'volume', quotaGb: 2, durationDays: 365, priceUsdt: 1,
  });

  const token = (await ctx.request('POST', '/api/v1/shop/register', {
    body: { email: `buyer-${Math.random().toString(36).slice(2)}@example.com`, password: 'a-good-password' },
  })).body.data.token;

  const buy = async (planId) => {
    const order = (await ctx.request('POST', '/api/v1/shop/orders', { token, body: { planId } })).body.data;
    const settled = await ctx.request('POST', `/api/v1/orders/${order.id}/settle`, {
      token: admin, body: { note: 'test' },
    });
    assert.equal(settled.status, 200, settled.text);
    return order;
  };

  return { ctx, admin, token, vpn, configsMonthly, configsVolume, buy, api: shop(ctx) };
}

test('two products, two entitlements', async (t) => {
  const { ctx, token, vpn, configsMonthly, buy } = await setup(t);

  await t.test('a plan says which of the two it sells, and how it is priced', async () => {
    const res = await ctx.request('GET', '/api/v1/shop/plans');
    const sold = res.body.data;
    assert.equal(sold.find((p) => p.id === vpn.id).product, 'vpn');
    assert.equal(sold.find((p) => p.id === vpn.id).billing, 'duration');
    assert.equal(sold.find((p) => p.id === configsMonthly.id).product, 'configs');
  });

  await t.test('buying the VPN plan entitles the VPN tab and nothing else', async () => {
    await buy(vpn.id);
    const me = (await ctx.request('GET', '/api/v1/shop/me', { token })).body.data;
    assert.ok(me.subscriptions.vpn, 'bought');
    assert.equal(me.subscriptions.configs, null, 'not bought');
  });

  await t.test('buying Configs does not top up the VPN quota', async () => {
    const before = (await ctx.request('GET', '/api/v1/shop/me', { token })).body.data.subscriptions.vpn;
    await buy(configsMonthly.id);
    const after = (await ctx.request('GET', '/api/v1/shop/me', { token })).body.data;

    assert.ok(after.subscriptions.configs, 'the second product is now held too');
    assert.notEqual(after.subscriptions.configs.id, before.id, 'and it is its own subscription');
    // The whole point. A customer who buys Configs is not buying more VPN.
    assert.equal(after.subscriptions.vpn.quotaBytes, before.quotaBytes);
    assert.equal(after.subscriptions.vpn.expiresAt, before.expiresAt);
  });

  await t.test('renewing the same product does top it up, as it always did', async () => {
    const before = (await ctx.request('GET', '/api/v1/shop/me', { token })).body.data.subscriptions.vpn;
    await buy(vpn.id);
    const after = (await ctx.request('GET', '/api/v1/shop/me', { token })).body.data.subscriptions.vpn;
    assert.equal(after.id, before.id, 'the same subscription, so the URL already in their client keeps working');
    assert.ok(new Date(after.expiresAt) > new Date(before.expiresAt));
  });

  await t.test('the two subscriptions have different URLs', async () => {
    const me = (await ctx.request('GET', '/api/v1/shop/me', { token })).body.data;
    assert.notEqual(me.subscriptions.vpn.subscriptionUrl, me.subscriptions.configs.subscriptionUrl);
  });
});

test('by-the-gigabyte plans are a shelf that can be taken down', async (t) => {
  const { ctx, admin, configsVolume } = await setup(t);

  await t.test('they are not on sale by default', async () => {
    // They are settled by hand, and a plan nobody is there to fulfil should not
    // be on the shelf.
    const sold = (await ctx.request('GET', '/api/v1/shop/plans')).body.data;
    assert.ok(!sold.some((p) => p.id === configsVolume.id));
    assert.ok(sold.length > 0, 'the duration plans are unaffected');
  });

  await t.test('one switch puts the whole shelf back', async () => {
    config.shop.volumeSales = true;
    const sold = (await ctx.request('GET', '/api/v1/shop/plans')).body.data;
    assert.ok(sold.some((p) => p.id === configsVolume.id));
    config.shop.volumeSales = false;
  });

  await t.test('an operator still sees them, because they are still theirs to manage', async () => {
    const all = (await ctx.request('GET', '/api/v1/plans', { token: admin })).body.data;
    assert.ok(all.some((p) => p.id === configsVolume.id));
  });

  await t.test('a customer cannot order one while the shelf is down', async () => {
    const token = (await ctx.request('POST', '/api/v1/shop/register', {
      body: { email: 'volume-buyer@example.com', password: 'a-good-password' },
    })).body.data.token;
    const res = await ctx.request('POST', '/api/v1/shop/orders', { token, body: { planId: configsVolume.id } });
    assert.notEqual(res.status, 201, 'a plan that is not on sale is not orderable');
  });
});

test('subscriptions sold before the split keep both', async (t) => {
  const { ctx } = await setup(t);
  const token = (await ctx.request('POST', '/api/v1/shop/register', {
    body: { email: 'grandfathered@example.com', password: 'a-good-password' },
  })).body.data.token;
  const customerId = ctx.db.prepare('SELECT id FROM customers WHERE email = ?').get('grandfathered@example.com').id;

  const { createSubscriber } = await import('../src/domain/subscribers.js');
  // What the migration leaves behind: sold before there were two products.
  createSubscriber(ctx.db, {
    name: 'bought before the split',
    quotaBytes: 50 * 1024 ** 3,
    expiresAt: Date.now() + 30 * 86400000,
    customerId,
    product: 'all',
  });

  await t.test('it answers for both, because taking half of it away is not a migration', async () => {
    const me = (await ctx.request('GET', '/api/v1/shop/me', { token })).body.data;
    assert.ok(me.subscriptions.vpn);
    assert.ok(me.subscriptions.configs);
    assert.equal(me.subscriptions.vpn.id, me.subscriptions.configs.id, 'one subscription, answering twice');
  });

  await t.test('and the field the installed app reads is still there', async () => {
    // Changing the shape of this would leave a paying customer's phone showing
    // them no subscription at all.
    const me = (await ctx.request('GET', '/api/v1/shop/me', { token })).body.data;
    assert.ok(me.subscription);
    assert.equal(me.subscription.id, me.subscriptions.vpn.id);
  });
});
