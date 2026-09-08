import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, seedGateway, seedEgress } from './helpers.js';
import { selectEgress, routeState } from '../src/domain/routing.js';

const setPair = (ctx, gatewayId, egressId, status, latency = null) =>
  ctx.db.prepare('UPDATE gateway_egress SET status=?, latency_ms=?, checked_at=? WHERE gateway_id=? AND egress_id=?')
    .run(status, latency, Date.now(), gatewayId, egressId);

test('route selection and failover', async (t) => {
  const ctx = await startTestServer();
  t.after(() => ctx.close());
  const token = await ctx.login();
  const gateway = await seedGateway(ctx, token);
  const primary = await seedEgress(ctx, token, { name: 'Primary', priority: 10 });
  const backup = await seedEgress(ctx, token, { name: 'Backup', priority: 20 });

  const assign = (egressId, priority) => ctx.request('POST', `/api/v1/gateways/${gateway.id}/egresses`, {
    token, body: { egressId, priority },
  });
  const current = () => ctx.db.prepare('SELECT * FROM gateways WHERE id=?').get(gateway.id);
  const routes = async () => (await ctx.request('GET', '/api/v1/routes', { token })).body;

  await t.test('a gateway with no egress has no route and fails closed', async () => {
    const view = await routes();
    assert.equal(view.data[0].state, 'no-egress');
    const config = await ctx.request('GET', `/api/v1/gateways/${gateway.id}/xray-config`, { token });
    // Blackhole first (Xray's default outbound) plus an explicit block rule.
    assert.equal(config.body.data.config.outbounds[0].protocol, 'blackhole');
    const clientRule = config.body.data.config.routing.rules.find(
      (r) => r.inboundTag?.includes('client-in'),
    );
    assert.equal(clientRule.outboundTag, 'block');
  });

  await t.test('selects the first assigned egress', async () => {
    await assign(primary.id, 10);
    assert.equal(current().active_egress_id, primary.id);
    assert.match(current().active_egress_reason, /initial-selection/);
  });

  await t.test('keeps the primary when a lower-priority backup is added', async () => {
    await assign(backup.id, 20);
    assert.equal(current().active_egress_id, primary.id);
  });

  await t.test('route state separates ingress failure from egress failure', async () => {
    setPair(ctx, gateway.id, primary.id, 'online', 40);
    ctx.db.prepare("UPDATE gateways SET ingress_status='online' WHERE id=?").run(gateway.id);
    assert.equal((await routes()).data[0].state, 'healthy');

    ctx.db.prepare("UPDATE gateways SET ingress_status='offline' WHERE id=?").run(gateway.id);
    assert.equal((await routes()).data[0].state, 'ingress-down');

    ctx.db.prepare("UPDATE gateways SET ingress_status='online' WHERE id=?").run(gateway.id);
    setPair(ctx, gateway.id, primary.id, 'offline');
    // The selector has not run yet, so the active egress is still the dead one.
    const gatewayRow = current();
    const active = { pair_status: 'offline' };
    assert.equal(routeState(gatewayRow, active), 'egress-down');
  });

  await t.test('fails over to the backup when the primary goes offline', async () => {
    setPair(ctx, gateway.id, primary.id, 'offline');
    setPair(ctx, gateway.id, backup.id, 'online', 90);
    const before = current().config_version;

    const res = await ctx.request('POST', '/api/v1/routes/reevaluate', { token });
    assert.equal(res.status, 200);

    const after = current();
    assert.equal(after.active_egress_id, backup.id);
    assert.ok(after.config_version > before, 'failover must bump the config version');
    assert.match(after.active_egress_reason, /previous path unusable/);

    const view = await routes();
    assert.equal(view.data[0].egress.name, 'Backup');
    assert.equal(view.data[0].lastSwitch.fromEgressId, primary.id);
    assert.equal(view.data[0].lastSwitch.toEgressId, backup.id);

    const events = await ctx.request('GET', '/api/v1/events', { token });
    assert.ok(events.body.data.some((e) => e.type === 'route.switched'));
  });

  await t.test('the deployed config routes traffic through the new egress', async () => {
    const config = await ctx.request('GET', `/api/v1/gateways/${gateway.id}/xray-config`, { token });
    const rule = config.body.data.config.routing.rules.find((r) => r.network === 'tcp,udp');
    assert.equal(rule.outboundTag, `egress-${backup.id}`);
    assert.equal(config.body.data.config.outbounds[0].tag, `egress-${backup.id}`);
  });

  await t.test('returns to the primary once it recovers', async () => {
    setPair(ctx, gateway.id, primary.id, 'online', 30);
    await ctx.request('POST', '/api/v1/routes/reevaluate', { token });
    assert.equal(current().active_egress_id, primary.id);
  });

  await t.test('does not flap between equally ranked paths', async () => {
    setPair(ctx, gateway.id, primary.id, 'online', 30);
    setPair(ctx, gateway.id, backup.id, 'online', 5);
    const before = current();
    await ctx.request('POST', '/api/v1/routes/reevaluate', { token });
    const after = current();
    // Backup has better latency but worse priority: priority wins, no switch.
    assert.equal(after.active_egress_id, before.active_egress_id);
    assert.equal(after.config_version, before.config_version);
  });

  await t.test('a disabled egress is not selected', async () => {
    await ctx.request('PATCH', `/api/v1/egresses/${primary.id}`, { token, body: { enabled: false } });
    assert.equal(current().active_egress_id, backup.id);
  });

  await t.test('fails closed when every path is unusable', async () => {
    setPair(ctx, gateway.id, backup.id, 'offline');
    await ctx.request('POST', '/api/v1/routes/reevaluate', { token });
    assert.equal(current().active_egress_id, null);
    const view = await routes();
    assert.equal(view.data[0].state, 'no-egress');
    const events = await ctx.request('GET', '/api/v1/events', { token, });
    assert.ok(events.body.data.some((e) => e.type === 'route.unavailable' && e.severity === 'critical'));
  });

  await t.test('selection is deterministic for identical inputs', () => {
    const a = selectEgress(ctx.db, gateway.id, null);
    const b = selectEgress(ctx.db, gateway.id, null);
    assert.deepEqual(a.egress?.id ?? null, b.egress?.id ?? null);
  });

  await t.test('an unusable route removes the gateway from new subscriptions', async () => {
    const created = await ctx.request('POST', '/api/v1/subscribers', {
      token, body: { name: 'Route test', quotaGb: 1, days: 7 },
    });
    const res = await ctx.request('GET', `/sub/${created.body.data.subscriptionToken}?format=json`);
    assert.equal(res.status, 200);
    assert.equal(res.body.data.profiles.length, 0);
    assert.match(res.body.data.notice, /No gateway currently has a usable path/);
  });
});
