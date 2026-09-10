import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, seedGateway } from './helpers.js';
import { signRequest, canonicalString } from '../src/auth/agent.js';
import { hmac } from '../src/lib/crypto.js';

test('gateway agent authentication', async (t) => {
  const ctx = await startTestServer();
  t.after(() => ctx.close());
  const token = await ctx.login();
  const gateway = await seedGateway(ctx, token);
  const key = gateway.agentKey;

  await t.test('registration returns an agent key exactly once', async () => {
    assert.match(key, /^jga_/);
    const fetched = await ctx.request('GET', `/api/v1/gateways/${gateway.id}`, { token });
    assert.equal(fetched.body.data.agent.keyIssued, true);
    assert.ok(!('agentKey' in fetched.body.data));
  });

  await t.test('stores the agent key encrypted, not in plaintext', () => {
    const row = ctx.db.prepare('SELECT agent_key_enc FROM gateways WHERE id=?').get(gateway.id);
    assert.match(row.agent_key_enc, /^v1\./);
    assert.ok(!row.agent_key_enc.includes(key));
  });

  await t.test('rejects an unsigned request', async () => {
    const res = await ctx.request('GET', '/api/v1/agent/config');
    assert.equal(res.status, 401);
  });

  await t.test('rejects an admin bearer token on agent endpoints', async () => {
    const res = await ctx.request('GET', '/api/v1/agent/config', { token });
    assert.equal(res.status, 401);
  });

  await t.test('accepts a correctly signed request', async () => {
    const res = await ctx.agentRequest('GET', '/api/v1/agent/config', { key, gatewayId: gateway.id });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.gatewayId, gateway.id);
  });

  await t.test('rejects a wrong key', async () => {
    const res = await ctx.agentRequest('GET', '/api/v1/agent/config', { key: 'jga_wrong', gatewayId: gateway.id });
    assert.equal(res.status, 401);
  });

  await t.test('rejects a request for another gateway', async () => {
    const other = await seedGateway(ctx, token, { name: 'Edge B', port: 18444 });
    const res = await ctx.agentRequest('GET', '/api/v1/agent/config', { key, gatewayId: other.id });
    assert.equal(res.status, 401);
  });

  await t.test('rejects a replayed request', async () => {
    const signed = signRequest({ key, method: 'GET', path: '/api/v1/agent/config', body: '' });
    const headers = {
      'x-cvpn-gateway': gateway.id,
      'x-cvpn-timestamp': String(signed.timestamp),
      'x-cvpn-nonce': signed.nonce,
      'x-cvpn-signature': signed.signature,
    };
    const first = await fetch(`${ctx.base}/api/v1/agent/config`, { headers });
    assert.equal(first.status, 200);
    const replay = await fetch(`${ctx.base}/api/v1/agent/config`, { headers });
    assert.equal(replay.status, 401);
  });

  await t.test('rejects a stale timestamp', async () => {
    const timestamp = Date.now() - 3600_000;
    const nonce = 'stale-nonce-1234';
    const signature = hmac(key, canonicalString({
      method: 'GET', path: '/api/v1/agent/config', timestamp, nonce, body: '',
    }));
    const res = await fetch(`${ctx.base}/api/v1/agent/config`, {
      headers: {
        'x-cvpn-gateway': gateway.id,
        'x-cvpn-timestamp': String(timestamp),
        'x-cvpn-nonce': nonce,
        'x-cvpn-signature': signature,
      },
    });
    assert.equal(res.status, 401);
  });

  await t.test('rejects a body that does not match the signature', async () => {
    const signed = signRequest({
      key, method: 'POST', path: '/api/v1/agent/heartbeat', body: JSON.stringify({ status: 'ok' }),
    });
    const res = await fetch(`${ctx.base}/api/v1/agent/heartbeat`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-cvpn-gateway': gateway.id,
        'x-cvpn-timestamp': String(signed.timestamp),
        'x-cvpn-nonce': signed.nonce,
        'x-cvpn-signature': signed.signature,
      },
      body: JSON.stringify({ status: 'error', detail: 'tampered' }),
    });
    assert.equal(res.status, 401);
  });

  await t.test('rotating the agent key invalidates the previous one', async () => {
    const rotated = await ctx.request('POST', `/api/v1/gateways/${gateway.id}/agent-key`, { token });
    assert.equal(rotated.status, 200);
    const newKey = rotated.body.data.agentKey;
    assert.notEqual(newKey, key);
    const old = await ctx.agentRequest('GET', '/api/v1/agent/config', { key, gatewayId: gateway.id });
    assert.equal(old.status, 401);
    const fresh = await ctx.agentRequest('GET', '/api/v1/agent/config', { key: newKey, gatewayId: gateway.id });
    assert.equal(fresh.status, 200);
  });

  await t.test('rejects malformed agent payloads', async () => {
    const rotated = await ctx.request('POST', `/api/v1/gateways/${gateway.id}/agent-key`, { token });
    const res = await ctx.agentRequest('POST', '/api/v1/agent/health', {
      key: rotated.body.data.agentKey,
      gatewayId: gateway.id,
      body: { egress: [{ egressId: 'x', status: 'exploded' }] },
    });
    assert.equal(res.status, 422);
    assert.equal(res.body.error.code, 'INVALID_INPUT');
  });
});

/**
 * The control plane is upgraded before the agents on the gateways are — that is
 * the order deploying anything takes. Renaming the signature headers without
 * this would take every gateway offline the moment the control plane restarted,
 * and the fix would need applying by hand on machines that had just stopped
 * being reachable through the console.
 */
test('an agent that has not been upgraded yet still gets in', async (t) => {
  const ctx = await startTestServer();
  t.after(() => ctx.close());
  const token = await ctx.login();
  const gateway = await seedGateway(ctx, token, { name: 'Legacy agent', port: 19100 });

  const legacy = async (body) => {
    const payload = JSON.stringify(body);
    const path = '/api/v1/agent/heartbeat';
    const signed = signRequest({ key: gateway.agentKey, method: 'POST', path, body: payload });
    return ctx.request('POST', path, {
      body,
      headers: {
        // The names these carried before the rename.
        'x-jordan-gateway': gateway.id,
        'x-jordan-timestamp': String(signed.timestamp),
        'x-jordan-nonce': signed.nonce,
        'x-jordan-signature': signed.signature,
      },
    });
  };

  await t.test('the old header names are still accepted', async () => {
    const res = await legacy({ agentVersion: '0.2.0', xrayVersion: '1.8.0' });
    assert.equal(res.status, 200, res.text);
  });

  await t.test('and they are still only as good as the signature', async () => {
    const res = await ctx.request('POST', '/api/v1/agent/heartbeat', {
      body: { agentVersion: '0.2.0' },
      headers: {
        'x-jordan-gateway': gateway.id,
        'x-jordan-timestamp': String(Date.now()),
        'x-jordan-nonce': 'nonce-that-is-long-enough',
        'x-jordan-signature': 'not-a-signature',
      },
    });
    assert.equal(res.status, 401);
  });
});
