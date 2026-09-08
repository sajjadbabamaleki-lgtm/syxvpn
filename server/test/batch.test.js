import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, seedGateway, seedEgress } from './helpers.js';
import { gatewayServerConfig, structuralConfig, stableStringify } from '../src/domain/xray.js';

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

test('issuing subscriptions in bulk', async (t) => {
  const ctx = await startTestServer();
  t.after(() => ctx.close());
  const token = await ctx.login();
  const gateway = await usableGateway(ctx, token);
  let batchId;

  await t.test('creates the requested number with unique tokens and links', async () => {
    const res = await ctx.request('POST', '/api/v1/subscribers/batch', {
      token, body: { count: 50, namePrefix: 'tg-2026-09-08', quotaGb: 20, days: 30 },
    });
    assert.equal(res.status, 201);
    batchId = res.body.data.batchId;
    const items = res.body.data.items;
    assert.equal(items.length, 50);

    const urls = new Set(items.map((i) => i.subscriptionUrl));
    assert.equal(urls.size, 50, 'every link is unique');
    for (const item of items) {
      assert.match(item.subscriptionUrl, /\/sub\/[A-Za-z0-9_-]{40,}$/);
      assert.equal(item.quotaBytes, 20 * 1024 ** 3);
      // A ready-to-send single config, not only a subscription link.
      assert.equal(item.profiles.length, 1);
      assert.match(item.profiles[0], /^vless:\/\//);
    }
    assert.match(items[0].name, /^tg-2026-09-08-001$/);
    assert.match(items[49].name, /^tg-2026-09-08-050$/);
  });

  await t.test('costs the data plane one config version, not fifty', async () => {
    const before = ctx.db.prepare('SELECT config_version FROM gateways WHERE id=?').get(gateway.id).config_version;
    await ctx.request('POST', '/api/v1/subscribers/batch', {
      token, body: { count: 25, namePrefix: 'second', quotaGb: 5, days: 7 },
    });
    const after = ctx.db.prepare('SELECT config_version FROM gateways WHERE id=?').get(gateway.id).config_version;
    assert.equal(after - before, 1, 'a batch is one data-plane update');
  });

  await t.test('records one event for the batch rather than one per subscriber', async () => {
    const events = await ctx.request('GET', '/api/v1/events?limit=200', { token });
    const batchEvents = events.body.data.filter((e) => e.targetType === 'batch');
    assert.equal(batchEvents.length, 2);
    assert.match(batchEvents[0].message, /25 subscriptions issued/);
  });

  await t.test('lists batches with how many are still usable', async () => {
    const res = await ctx.request('GET', '/api/v1/subscribers/batches', { token });
    assert.equal(res.status, 200);
    const batch = res.body.data.find((b) => b.batchId === batchId);
    assert.equal(batch.total, 50);
    assert.equal(batch.active, 50);
  });

  await t.test('exports a batch as text ready to paste, and as csv', async () => {
    const txt = await ctx.request('GET', `/api/v1/subscribers/batches/${batchId}?format=txt`, { token });
    assert.equal(txt.status, 200);
    const lines = txt.text.trim().split('\n').filter(Boolean);
    assert.equal(lines.length, 100, 'a name and a link per subscriber');
    assert.match(lines[1], /^http.*\/sub\//);

    const csv = await ctx.request('GET', `/api/v1/subscribers/batches/${batchId}?format=csv`, { token });
    assert.equal(csv.status, 200);
    assert.match(csv.headers.get('content-type'), /text\/csv/);
    const rows = csv.text.trim().split('\n');
    assert.equal(rows[0], 'name,subscription_url,quota_bytes,used_bytes,expires_at,status');
    assert.equal(rows.length, 51);
  });

  await t.test('a subscription link can be read again later', async () => {
    const list = await ctx.request('GET', `/api/v1/subscribers/batches/${batchId}`, { token });
    const first = list.body.data[0];
    const revealed = await ctx.request('GET', `/api/v1/subscribers/${first.id}/subscription`, { token });
    assert.equal(revealed.status, 200);
    assert.equal(revealed.body.data.subscriptionUrl, first.subscriptionUrl);
    assert.match(revealed.body.data.profiles[0].uri, /^vless:\/\//);

    // Reading a live credential is audited.
    const events = await ctx.request('GET', '/api/v1/events?limit=20', { token });
    assert.ok(events.body.data.some((e) => e.type === 'subscriber.link_revealed'));
  });

  await t.test('the exported links actually work', async () => {
    const list = await ctx.request('GET', `/api/v1/subscribers/batches/${batchId}`, { token });
    for (const item of list.body.data.slice(0, 3)) {
      const url = new URL(item.subscriptionUrl);
      const res = await ctx.request('GET', url.pathname);
      assert.equal(res.status, 200);
      assert.match(Buffer.from(res.text, 'base64').toString('utf8'), /^vless:\/\//);
    }
  });

  await t.test('rejects an implausible batch', async () => {
    for (const body of [
      { count: 0, namePrefix: 'x', quotaGb: 1 },
      { count: 5000, namePrefix: 'x', quotaGb: 1 },
      { count: 5, namePrefix: '', quotaGb: 1 },
      { count: 5, namePrefix: 'bad/prefix', quotaGb: 1 },
    ]) {
      const res = await ctx.request('POST', '/api/v1/subscribers/batch', { token, body });
      assert.equal(res.status, 422, JSON.stringify(body));
    }
  });

  await t.test('bulk issuing needs an operator session', async () => {
    const res = await ctx.request('POST', '/api/v1/subscribers/batch', {
      body: { count: 5, namePrefix: 'x', quotaGb: 1 },
    });
    assert.equal(res.status, 401);
  });
});

test('client changes are separable from structural changes', async (t) => {
  const gateway = {
    id: 'gw', name: 'A', region: 'r', host: 'h', port: 443,
    tls_mode: 'none', ws_path: '/ws', block_private_ranges: 1,
  };
  const egresses = [{ id: 'e1', kind: 'direct', enabled: 1 }];
  const hash = (config) => stableStringify(structuralConfig(config));

  await t.test('adding or removing a subscriber leaves the structure identical', () => {
    const one = gatewayServerConfig(gateway, [{ credentialId: 'cr_a', uuid: 'u1' }], egresses, 'e1');
    const many = gatewayServerConfig(gateway, [
      { credentialId: 'cr_a', uuid: 'u1' },
      { credentialId: 'cr_b', uuid: 'u2' },
    ], egresses, 'e1');
    const none = gatewayServerConfig(gateway, [], egresses, 'e1');
    assert.equal(hash(one), hash(many));
    assert.equal(hash(one), hash(none));
    // The configs themselves obviously differ; only the structure matches.
    assert.notEqual(stableStringify(one), stableStringify(many));
  });

  await t.test('changing the gateway or its routing does change the structure', () => {
    const base = gatewayServerConfig(gateway, [], egresses, 'e1');
    assert.notEqual(hash(base), hash(gatewayServerConfig({ ...gateway, ws_path: '/other' }, [], egresses, 'e1')));
    assert.notEqual(hash(base), hash(gatewayServerConfig({ ...gateway, port: 8443 }, [], egresses, 'e1')));
    assert.notEqual(hash(base), hash(gatewayServerConfig(gateway, [], egresses, null)));
    assert.notEqual(
      hash(base),
      hash(gatewayServerConfig(gateway, [], [...egresses, { id: 'e2', kind: 'direct', enabled: 1 }], 'e1')),
    );
  });

  await t.test('the agent bundle carries both hashes', async () => {
    const ctx = await startTestServer();
    const token = await ctx.login();
    const gw = await seedGateway(ctx, token);
    const bundle = await ctx.agentRequest('GET', '/api/v1/agent/config', {
      key: gw.agentKey, gatewayId: gw.id,
    });
    assert.equal(bundle.status, 200);
    assert.match(bundle.body.data.hash, /^[0-9a-f]{16}$/);
    assert.match(bundle.body.data.structureHash, /^[0-9a-f]{16}$/);
    assert.equal(bundle.body.data.inboundTag, 'client-in');
    await ctx.close();
  });
});
