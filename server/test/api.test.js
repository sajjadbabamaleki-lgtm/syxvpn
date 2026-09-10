import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, seedGateway, seedEgress } from './helpers.js';

test('API contract and input validation', async (t) => {
  const ctx = await startTestServer();
  t.after(() => ctx.close());
  const token = await ctx.login();

  await t.test('liveness and readiness are separate', async () => {
    const health = await ctx.request('GET', '/health');
    assert.equal(health.status, 200);
    assert.equal(health.body.data.status, 'ok');

    const readiness = await ctx.request('GET', '/readiness');
    assert.equal(readiness.status, 200);
    assert.equal(readiness.body.data.checks.database, 'ok');
  });

  await t.test('readiness fails when the control plane has no administrator', async () => {
    const noAdmin = await startTestServer();
    noAdmin.db.prepare('DELETE FROM admins').run();
    const res = await noAdmin.request('GET', '/readiness');
    assert.equal(res.status, 503);
    assert.equal(res.body.error.code, 'NOT_READY');
    await noAdmin.close();
  });

  await t.test('unknown routes return the standard error envelope', async () => {
    const res = await ctx.request('GET', '/api/v1/nope', { token });
    assert.equal(res.status, 404);
    assert.equal(res.body.error.code, 'NOT_FOUND');
    assert.equal(typeof res.body.error.message, 'string');
  });

  await t.test('malformed JSON is reported, not swallowed', async () => {
    const res = await fetch(`${ctx.base}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, 'MALFORMED_JSON');
  });

  await t.test('rejects invalid gateway hosts and ports', async () => {
    const cases = [
      { host: 'http://edge.example.net', port: 443 },
      { host: 'edge.example.net', port: 70000 },
      { host: 'edge.example.net', port: 0 },
      { host: '999.1.1.1', port: 443 },
      { host: '', port: 443 },
    ];
    for (const bad of cases) {
      const res = await ctx.request('POST', '/api/v1/gateways', {
        token, body: { name: 'Bad', region: 'lab', ...bad },
      });
      assert.equal(res.status, 422, `expected rejection for ${JSON.stringify(bad)}`);
    }
  });

  await t.test('rejects a websocket path that is not a path', async () => {
    const res = await ctx.request('POST', '/api/v1/gateways', {
      token, body: { name: 'Bad path', region: 'lab', host: 'edge.example.net', port: 443, wsPath: 'ws2' },
    });
    assert.equal(res.status, 422);
  });

  await t.test('refuses TLS settings a gateway cannot actually serve', async () => {
    const xrayTls = await ctx.request('POST', '/api/v1/gateways', {
      token, body: { name: 'Fake TLS', region: 'lab', host: 'edge.example.net', port: 443, tlsMode: 'xray' },
    });
    assert.equal(xrayTls.status, 422);
    assert.match(JSON.stringify(xrayTls.body.error.details), /actually serve TLS/);

    const proxied = await ctx.request('POST', '/api/v1/gateways', {
      token, body: { name: 'Proxy TLS', region: 'lab', host: 'edge.example.net', port: 443, tlsMode: 'reverse-proxy' },
    });
    assert.equal(proxied.status, 422);
    assert.match(JSON.stringify(proxied.body.error.details), /listenPort/);
  });

  await t.test('a patch changes what it names and nothing else', async () => {
    // Zod's .partial() does not strip a .default(), so a shape written for
    // creation will fill a PATCH in with defaults the caller never sent. That
    // is how changing a port used to reset a gateway's TLS mode to "none" and
    // take the reverse proxy in front of it out of the configuration.
    const made = await ctx.request('POST', '/api/v1/gateways', {
      token,
      body: {
        name: 'Behind a proxy', region: 'de', host: 'proxied.example.net', port: 443,
        tlsMode: 'reverse-proxy', listenPort: 10441, wsPath: '/tunnel', priority: 30,
        blockPrivateRanges: false,
      },
    });
    assert.equal(made.status, 201);
    const res = await ctx.request('PATCH', `/api/v1/gateways/${made.body.data.id}`, {
      token, body: { port: 8443 },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.port, 8443);
    assert.equal(res.body.data.tlsMode, 'reverse-proxy');
    assert.equal(res.body.data.wsPath, '/tunnel');
    assert.equal(res.body.data.priority, 30);
    assert.equal(res.body.data.blockPrivateRanges, false);
    assert.equal(res.body.data.transport, 'ws');
  });

  await t.test('rejects an egress that is missing its endpoint', async () => {
    const res = await ctx.request('POST', '/api/v1/egresses', {
      token, body: { name: 'Broken', region: 'eu', kind: 'socks' },
    });
    assert.equal(res.status, 422);
    assert.match(JSON.stringify(res.body.error.details), /requires host and port/);
  });

  await t.test('never returns an egress credential to an operator', async () => {
    const egress = await seedEgress(ctx, token, {
      kind: 'socks', host: '10.0.0.9', port: 1080, username: 'u', secret: 'super-secret-value',
    });
    assert.equal(egress.hasSecret, true);
    assert.ok(!JSON.stringify(egress).includes('super-secret-value'));

    const list = await ctx.request('GET', '/api/v1/egresses', { token });
    assert.ok(!JSON.stringify(list.body).includes('super-secret-value'));

    // Stored encrypted, not in plaintext.
    const row = ctx.db.prepare('SELECT secret FROM egresses WHERE id=?').get(egress.id);
    assert.match(row.secret, /^v1\./);
    assert.ok(!row.secret.includes('super-secret-value'));
  });

  await t.test('hands the egress credential to an authenticated agent only', async () => {
    const gateway = await seedGateway(ctx, token, { name: 'Cred', port: 18500 });
    const egress = await seedEgress(ctx, token, {
      name: 'Cred egress', kind: 'socks', host: '10.0.0.9', port: 1080, username: 'u', secret: 'agent-only-secret',
    });
    await ctx.request('POST', `/api/v1/gateways/${gateway.id}/egresses`, {
      token, body: { egressId: egress.id, priority: 10 },
    });
    const res = await ctx.agentRequest('GET', '/api/v1/agent/config', {
      key: gateway.agentKey, gatewayId: gateway.id,
    });
    assert.equal(res.status, 200);
    const outbound = res.body.data.config.outbounds.find((o) => o.tag === `egress-${egress.id}`);
    assert.equal(outbound.settings.servers[0].users[0].pass, 'agent-only-secret');
  });

  await t.test('paginates and bounds observability queries', async () => {
    const res = await ctx.request('GET', '/api/v1/events?limit=500', { token });
    assert.equal(res.status, 422);
    const ok = await ctx.request('GET', '/api/v1/events?limit=5', { token });
    assert.equal(ok.status, 200);
    assert.ok(ok.body.data.length <= 5);
  });

  await t.test('overview reports honestly with no infrastructure', async () => {
    const fresh = await startTestServer();
    const freshToken = await fresh.login();
    const res = await fresh.request('GET', '/api/v1/overview', { token: freshToken });
    assert.equal(res.body.data.state, 'unconfigured');
    assert.equal(res.body.data.gateways.total, 0);
    assert.equal(res.body.data.usage.measured, false);
    assert.equal(res.body.data.activeRoute, null);
    await fresh.close();
  });

  await t.test('rejects an oversized request body', async () => {
    const res = await fetch(`${ctx.base}/api/v1/subscribers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ name: 'x'.repeat(400_000) }),
    });
    assert.equal(res.status, 413);
  });
});
