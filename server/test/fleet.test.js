import test from 'node:test';
import assert from 'node:assert/strict';
import { homeGateways, routesForSubscriber } from '../src/domain/fleet.js';
import { startTestServer } from './helpers.js';
import { config } from '../src/config.js';

const gateway = (id, region = 'de') => ({ id, region, name: id });
const fleet = (count, regions = ['de', 'nl', 'fi', 'us']) =>
  Array.from({ length: count }, (_, i) => gateway(`gw_${i}`, regions[i % regions.length]));
const ids = (list) => list.map((g) => g.id ?? g.gateway.id);
const route = (g, state = 'healthy') => ({ gateway: g, active: null, state });

test('which gateways a subscriber is told about', async (t) => {
  await t.test('a fleet smaller than the share is handed over whole', () => {
    const all = fleet(3);
    assert.deepEqual(ids(homeGateways(all, 'sub_1', 4)), ids(all));
    assert.deepEqual(ids(homeGateways(all, 'sub_1', 3)), ids(all));
  });

  await t.test('a size of zero means the old behaviour: everyone gets everything', () => {
    const all = fleet(20);
    assert.deepEqual(ids(homeGateways(all, 'sub_1', 0)), ids(all));
  });

  await t.test('the same subscriber gets the same gateways every time', () => {
    // Not a nicety. A list that changes between requests means a client that
    // re-imports a subscription loses whichever server it was using.
    const all = fleet(20);
    const first = ids(homeGateways(all, 'sub_1', 4));
    for (let i = 0; i < 20; i += 1) {
      assert.deepEqual(ids(homeGateways(all, 'sub_1', 4)), first);
    }
    // And it does not depend on the order the fleet arrives in.
    assert.deepEqual(ids(homeGateways([...all].reverse(), 'sub_1', 4)).sort(), first.slice().sort());
  });

  await t.test('different subscribers get different gateways', () => {
    const all = fleet(20);
    const sets = Array.from({ length: 50 }, (_, i) => ids(homeGateways(all, `sub_${i}`, 4)).join(','));
    assert.ok(new Set(sets).size > 20, 'a fleet of 20 should not resolve to a handful of sets');
  });

  await t.test('one leak exposes a handful, not the fleet', () => {
    // The whole point. With 40 gateways and a share of 4, a censor who buys one
    // subscription learns four addresses.
    const all = fleet(40);
    assert.equal(homeGateways(all, 'sub_1', 4).length, 4);
  });

  await t.test('every gateway is used by somebody, and none carries the whole load', () => {
    const all = fleet(12);
    const counts = new Map(all.map((g) => [g.id, 0]));
    for (let i = 0; i < 1200; i += 1) {
      for (const g of homeGateways(all, `sub_${i}`, 4)) counts.set(g.id, counts.get(g.id) + 1);
    }
    const load = [...counts.values()];
    assert.ok(Math.min(...load) > 0, 'an unused gateway is a wasted one');
    // Perfectly even would be 400 each. Region-first picking skews it, so this
    // checks nothing is starved or swamped, not that it is uniform.
    assert.ok(Math.max(...load) < Math.min(...load) * 4, `lopsided: ${load.join(', ')}`);
  });

  await t.test('adding a gateway moves as few subscribers as possible', () => {
    // The property a modulo does not have. Renumbering the fleet on every
    // addition would hand every subscriber a new set — and teach all of them
    // about gateways they had no reason to know.
    const before = fleet(12);
    const after = [...before, gateway('gw_new', 'jp')];
    let moved = 0;
    const people = 500;
    for (let i = 0; i < people; i += 1) {
      const a = ids(homeGateways(before, `sub_${i}`, 4)).sort().join(',');
      const b = ids(homeGateways(after, `sub_${i}`, 4)).sort().join(',');
      if (a !== b) moved += 1;
    }
    assert.ok(moved < people * 0.6, `${moved}/${people} subscribers moved`);
  });

  await t.test('removing a gateway leaves everyone else where they were', () => {
    const before = fleet(12);
    const after = before.filter((g) => g.id !== 'gw_5');
    for (let i = 0; i < 300; i += 1) {
      const a = ids(homeGateways(before, `sub_${i}`, 4));
      if (a.includes('gw_5')) continue;
      assert.deepEqual(ids(homeGateways(after, `sub_${i}`, 4)), a, `sub_${i} moved for no reason`);
    }
  });

  await t.test('a share spans regions before it doubles up', () => {
    // Four gateways in Frankfurt are one German decision away from nothing, and
    // a subscriber cannot try elsewhere if elsewhere was never in their list.
    const all = fleet(24, ['de', 'nl', 'fi', 'us']);
    for (let i = 0; i < 100; i += 1) {
      const regions = new Set(homeGateways(all, `sub_${i}`, 4).map((g) => g.region));
      assert.equal(regions.size, 4, `sub_${i} got ${[...regions].join(', ')}`);
    }
  });

  await t.test('one region is not a reason to hand out fewer', () => {
    const all = fleet(20, ['de']);
    assert.equal(homeGateways(all, 'sub_1', 4).length, 4);
  });
});

test('narrowing to what is usable now', async (t) => {
  const all = fleet(12);
  const usable = (except = []) => all.filter((g) => !except.includes(g.id)).map((g) => route(g));

  await t.test('membership does not move when health flaps', () => {
    // Scoring the healthy pool instead of the enabled one would mean that every
    // time a gateway flapped, its subscribers were handed a different one — and
    // after enough flapping everyone would know every address.
    const mine = ids(routesForSubscriber(all, usable(), 'sub_7', { size: 4 }));
    const flapped = ids(routesForSubscriber(all, usable(['gw_0', 'gw_1']), 'sub_7', { size: 4 }));
    assert.ok(flapped.every((id) => mine.includes(id)), 'an outage elsewhere handed out new addresses');
  });

  await t.test('a subscriber sees only their own, and only the working ones', () => {
    const mine = ids(routesForSubscriber(all, usable(), 'sub_7', { size: 4 }));
    const withOneDown = ids(routesForSubscriber(all, usable([mine[0]]), 'sub_7', { size: 4 }));
    assert.deepEqual(withOneDown, mine.slice(1), 'the dead one is dropped, the rest stay put');
  });

  await t.test('nobody is left with nothing when all of theirs are down', () => {
    const mine = ids(routesForSubscriber(all, usable(), 'sub_7', { size: 4 }));
    const stranded = routesForSubscriber(all, usable(mine), 'sub_7', { size: 4 });
    // A customer with no working configuration has already left. Lending is
    // better than stranding — and it is bounded, not the whole fleet.
    assert.ok(stranded.length > 0);
    assert.ok(stranded.length <= 4);
    assert.ok(ids(stranded).every((id) => !mine.includes(id)));
  });

  await t.test('the operator\'s priority order survives the narrowing', () => {
    const chosen = routesForSubscriber(all, usable(), 'sub_3', { size: 4 });
    const order = ids(chosen).map((id) => all.findIndex((g) => g.id === id));
    assert.deepEqual(order, [...order].sort((a, b) => a - b), 'priority order was reshuffled');
  });
});

test('a subscription serves the subscriber their own gateways', async (t) => {
  const ctx = await startTestServer();
  t.after(() => ctx.close());
  const token = await ctx.login();
  const original = config.fleet.gatewaysPerSubscriber;
  config.fleet.gatewaysPerSubscriber = 2;
  t.after(() => { config.fleet.gatewaysPerSubscriber = original; });

  // Six healthy gateways across three regions.
  const now = Date.now();
  const eg = (await ctx.request('POST', '/api/v1/egresses', {
    token, body: { name: 'direct', region: 'de', kind: 'direct' },
  })).body.data.id;
  for (let i = 0; i < 6; i += 1) {
    const made = await ctx.request('POST', '/api/v1/gateways', {
      token,
      body: {
        name: `edge-${i}`, region: ['de', 'nl', 'fi'][i % 3],
        host: `203.0.113.${10 + i}`, port: 443, transport: 'ws', tlsMode: 'none',
      },
    });
    const id = made.body.data.id;
    await ctx.request('POST', `/api/v1/gateways/${id}/egresses`, { token, body: { egressId: eg } });
    ctx.db.prepare(`UPDATE gateways SET ingress_status='online', ingress_checked_at=?,
      active_egress_id=?, active_egress_since=? WHERE id=?`).run(now, eg, now, id);
    ctx.db.prepare("UPDATE gateway_egress SET status='online', checked_at=? WHERE gateway_id=?")
      .run(now, id);
  }

  const subs = [];
  for (let i = 0; i < 6; i += 1) {
    const made = await ctx.request('POST', '/api/v1/subscribers', {
      token, body: { name: `person-${i}`, quotaGb: 10, durationDays: 30 },
    });
    subs.push(made.body.data);
  }

  await t.test('each gets two of the six, not all six', async () => {
    const seen = new Set();
    for (const sub of subs) {
      const link = await ctx.request('GET', `/api/v1/subscribers/${sub.id}/subscription`, { token });
      const gateways = link.body.data.profiles.map((p) => p.gatewayId);
      assert.equal(gateways.length, 2, `${sub.name} was handed ${gateways.length} gateways`);
      gateways.forEach((id) => seen.add(id));
    }
    // Between them the fleet is used; individually nobody has a map of it.
    assert.ok(seen.size >= 4, `only ${seen.size} of 6 gateways were ever handed out`);
  });

  await t.test('the public subscription serves the same two, not a different pair', async () => {
    const link = await ctx.request('GET', `/api/v1/subscribers/${subs[0].id}/subscription`, { token });
    const fromConsole = link.body.data.profiles.map((p) => p.gatewayId).sort();
    const url = new URL(link.body.data.subscriptionUrl);
    const served = await ctx.request('GET', `${url.pathname}?format=json`);
    const fromSubscription = (served.body.data?.profiles || []).map((p) => p.gatewayId).sort();
    assert.deepEqual(fromSubscription, fromConsole);
  });
});
