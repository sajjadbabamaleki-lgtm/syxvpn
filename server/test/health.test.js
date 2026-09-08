import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startTestServer, seedGateway, seedEgress } from './helpers.js';
import { tcpProbe, wsProbe, sweepStaleReports } from '../src/domain/health.js';

/** A server that accepts WebSocket upgrades, like a live Xray ws inbound. */
function upgradeServer() {
  const server = http.createServer((_req, res) => { res.writeHead(400); res.end('bad request'); });
  server.on('upgrade', (_req, socket) => {
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
    // An upgraded socket is detached from the server, so close it explicitly
    // or the test process cannot exit.
    socket.end();
  });
  return server;
}

test('health probing', async (t) => {
  const ctx = await startTestServer();
  const live = upgradeServer();
  const plain = http.createServer((_req, res) => { res.writeHead(404); res.end(); });
  await new Promise((r) => live.listen(0, '127.0.0.1', r));
  await new Promise((r) => plain.listen(0, '127.0.0.1', r));
  t.after(async () => {
    await new Promise((r) => live.close(r));
    await new Promise((r) => plain.close(r));
    await ctx.close();
  });
  const token = await ctx.login();

  await t.test('tcp probe detects a closed port', async () => {
    // Port 1 is reserved and never listening in the test environment.
    const result = await tcpProbe('127.0.0.1', 1, 1000);
    assert.equal(result.status, 'offline');
    assert.match(result.detail, /tcp/);
  });

  await t.test('tcp probe measures an open port', async () => {
    const result = await tcpProbe('127.0.0.1', live.address().port, 2000);
    assert.equal(result.status, 'online');
    assert.equal(typeof result.latencyMs, 'number');
  });

  await t.test('websocket probe separates "port open" from "service works"', async () => {
    const good = await wsProbe({
      host: '127.0.0.1', port: live.address().port, tls_mode: 'none', ws_path: '/ws',
    }, 2000);
    assert.equal(good.status, 'online');
    assert.match(good.detail, /101/);

    const wrong = await wsProbe({
      host: '127.0.0.1', port: plain.address().port, tls_mode: 'none', ws_path: '/ws',
    }, 2000);
    assert.equal(wrong.status, 'degraded');
    assert.match(wrong.detail, /http 404/);
  });

  await t.test('a manual check marks a live gateway online', async () => {
    const gateway = await seedGateway(ctx, token, { port: live.address().port });
    const res = await ctx.request('POST', `/api/v1/gateways/${gateway.id}/check`, { token });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.ingress.status, 'online');

    const events = await ctx.request('GET', '/api/v1/events', { token });
    assert.ok(events.body.data.some((e) => e.type === 'gateway.online'));
  });

  await t.test('a single failure degrades before it counts as an outage', async () => {
    const gateway = await seedGateway(ctx, token, { name: 'Flaky', port: live.address().port });
    await ctx.request('POST', `/api/v1/gateways/${gateway.id}/check`, { token });
    // Point it at a dead port and check twice; the threshold is 2.
    ctx.db.prepare('UPDATE gateways SET port = 1 WHERE id = ?').run(gateway.id);

    const first = await ctx.request('POST', `/api/v1/gateways/${gateway.id}/check`, { token });
    assert.equal(first.body.data.ingress.status, 'degraded');
    const second = await ctx.request('POST', `/api/v1/gateways/${gateway.id}/check`, { token });
    assert.equal(second.body.data.ingress.status, 'offline');
  });

  await t.test('agent-reported egress health is stored per gateway/egress pair', async () => {
    const gateway = await seedGateway(ctx, token, { name: 'Pairs', port: live.address().port });
    const egress = await seedEgress(ctx, token, { name: 'Pair egress' });
    await ctx.request('POST', `/api/v1/gateways/${gateway.id}/egresses`, {
      token, body: { egressId: egress.id, priority: 10 },
    });
    const res = await ctx.agentRequest('POST', '/api/v1/agent/health', {
      key: gateway.agentKey,
      gatewayId: gateway.id,
      body: { egress: [{ egressId: egress.id, status: 'online', latencyMs: 42, detail: 'e2e ok' }] },
    });
    assert.equal(res.status, 200);
    const pair = ctx.db.prepare('SELECT * FROM gateway_egress WHERE gateway_id=? AND egress_id=?')
      .get(gateway.id, egress.id);
    assert.equal(pair.status, 'online');
    assert.equal(pair.latency_ms, 42);
    const rolled = ctx.db.prepare('SELECT status FROM egresses WHERE id=?').get(egress.id);
    assert.equal(rolled.status, 'online');
  });

  await t.test('stale agent health decays to unknown instead of staying online', async () => {
    const gateway = await seedGateway(ctx, token, { name: 'Stale', port: live.address().port });
    const egress = await seedEgress(ctx, token, { name: 'Stale egress' });
    await ctx.request('POST', `/api/v1/gateways/${gateway.id}/egresses`, {
      token, body: { egressId: egress.id, priority: 10 },
    });
    await ctx.agentRequest('POST', '/api/v1/agent/health', {
      key: gateway.agentKey,
      gatewayId: gateway.id,
      body: { egress: [{ egressId: egress.id, status: 'online', latencyMs: 10 }] },
    });

    const old = Date.now() - 3600_000;
    ctx.db.prepare('UPDATE gateway_egress SET checked_at=? WHERE gateway_id=?').run(old, gateway.id);
    ctx.db.prepare('UPDATE gateways SET agent_last_seen_at=? WHERE id=?').run(old, gateway.id);

    const swept = sweepStaleReports(ctx.db);
    assert.ok(swept.staleAgents >= 1);
    assert.ok(swept.staleEgressPairs >= 1);
    const pair = ctx.db.prepare('SELECT status FROM gateway_egress WHERE gateway_id=?').get(gateway.id);
    assert.equal(pair.status, 'unknown');
    const row = ctx.db.prepare('SELECT agent_status FROM gateways WHERE id=?').get(gateway.id);
    assert.equal(row.agent_status, 'stale');
    const events = await ctx.request('GET', '/api/v1/events', { token });
    assert.ok(events.body.data.some((e) => e.type === 'agent.heartbeat_missed'));
  });
});
