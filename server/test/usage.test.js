import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, seedGateway, seedEgress } from './helpers.js';

test('usage accounting', async (t) => {
  const ctx = await startTestServer();
  t.after(() => ctx.close());
  const token = await ctx.login();
  const gateway = await seedGateway(ctx, token);
  const key = gateway.agentKey;
  const egress = await seedEgress(ctx, token);
  await ctx.request('POST', `/api/v1/gateways/${gateway.id}/egresses`, {
    token, body: { egressId: egress.id, priority: 10 },
  });

  const created = await ctx.request('POST', '/api/v1/subscribers', {
    token, body: { name: 'Metered', quotaBytes: 10000, days: 7 },
  });
  const subscriberId = created.body.data.id;
  const credentialId = ctx.db.prepare("SELECT id FROM credentials WHERE subscriber_id=?").get(subscriberId).id;

  const report = (reportId, uplink, downlink) => ctx.agentRequest('POST', '/api/v1/agent/usage', {
    key, gatewayId: gateway.id, body: { reportId, counters: [{ credentialId, uplink, downlink }] },
  });
  const used = () => ctx.db.prepare('SELECT used_bytes FROM subscribers WHERE id=?').get(subscriberId).used_bytes;

  await t.test('counts the first cumulative report in full', async () => {
    const res = await report('report-00000001', 100, 400);
    assert.equal(res.status, 200);
    assert.equal(res.body.data.appliedBytes, 500);
    assert.equal(used(), 500);
  });

  await t.test('counts only the delta of a later cumulative report', async () => {
    const res = await report('report-00000002', 300, 900);
    assert.equal(res.body.data.appliedBytes, 700);
    assert.equal(used(), 1200);
  });

  await t.test('ignores a replayed report id', async () => {
    const res = await report('report-00000002', 300, 900);
    assert.equal(res.body.data.duplicate, true);
    assert.equal(res.body.data.appliedBytes, 0);
    assert.equal(used(), 1200);
  });

  await t.test('treats a counter reset as a restart, not a huge delta', async () => {
    // Xray restarted: counters begin again from a low value.
    const res = await report('report-00000003', 50, 50);
    assert.equal(res.body.data.appliedBytes, 100);
    assert.equal(used(), 1300);
  });

  await t.test('drops counters for unknown credentials', async () => {
    const res = await ctx.agentRequest('POST', '/api/v1/agent/usage', {
      key,
      gatewayId: gateway.id,
      body: { reportId: 'report-00000004', counters: [{ credentialId: 'cr_does_not_exist', uplink: 999999, downlink: 1 }] },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.appliedBytes, 0);
    assert.equal(used(), 1300);
  });

  await t.test('rejects negative and non-numeric counters', async () => {
    const res = await ctx.agentRequest('POST', '/api/v1/agent/usage', {
      key,
      gatewayId: gateway.id,
      body: { reportId: 'report-00000005', counters: [{ credentialId, uplink: -5, downlink: 'lots' }] },
    });
    assert.equal(res.status, 422);
  });

  await t.test('crossing the quota removes the client from the data plane', async () => {
    const before = ctx.db.prepare('SELECT config_version FROM gateways WHERE id=?').get(gateway.id).config_version;
    const res = await report('report-00000006', 6000, 6000);
    assert.equal(res.body.data.exhausted, 1);
    assert.ok(used() >= 10000);

    const after = ctx.db.prepare('SELECT config_version FROM gateways WHERE id=?').get(gateway.id).config_version;
    assert.ok(after > before, 'quota exhaustion must bump the config version');

    const config = await ctx.request('GET', `/api/v1/gateways/${gateway.id}/xray-config`, { token });
    assert.equal(config.body.data.config.inbounds[0].settings.clients.length, 0);

    const events = await ctx.request('GET', '/api/v1/events', { token });
    assert.ok(events.body.data.some((e) => e.type === 'subscriber.quota_exhausted'));
  });

  await t.test('a subscriber over quota can no longer fetch a subscription', async () => {
    const res = await ctx.request('GET', `/sub/${created.body.data.subscriptionToken}`);
    assert.equal(res.status, 404);
  });

  await t.test('clamps an implausible counter jump', async () => {
    const fresh = await ctx.request('POST', '/api/v1/subscribers', {
      token, body: { name: 'Clamp', quotaBytes: 0, days: 7 },
    });
    const clampCredential = ctx.db.prepare('SELECT id FROM credentials WHERE subscriber_id=?')
      .get(fresh.body.data.id).id;
    const res = await ctx.agentRequest('POST', '/api/v1/agent/usage', {
      key,
      gatewayId: gateway.id,
      body: {
        reportId: 'report-00000007',
        counters: [{ credentialId: clampCredential, uplink: 2 ** 53 - 1, downlink: 0 }],
      },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.appliedBytes, 1024 ** 4);
    const events = await ctx.request('GET', '/api/v1/events', { token });
    assert.ok(events.body.data.some((e) => e.type === 'usage.clamped'));
  });

  await t.test('usage cannot be posted without agent authentication', async () => {
    const res = await ctx.request('POST', '/api/v1/agent/usage', {
      body: { reportId: 'report-99999999', counters: [{ credentialId, uplink: 1, downlink: 1 }] },
    });
    assert.equal(res.status, 401);
  });
});
