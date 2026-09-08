import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, seedGateway, seedEgress } from './helpers.js';

/** Puts a gateway into a state where it can actually serve profiles. */
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
  return { gateway, egress };
}

test('subscriber lifecycle and subscription delivery', async (t) => {
  const ctx = await startTestServer();
  t.after(() => ctx.close());
  const token = await ctx.login();
  const { gateway } = await usableGateway(ctx, token);

  await t.test('creates a subscriber with a high-entropy, unique token', async () => {
    const tokens = new Set();
    for (let i = 0; i < 5; i += 1) {
      const res = await ctx.request('POST', '/api/v1/subscribers', {
        token, body: { name: `User ${i}`, quotaGb: 1, days: 7 },
      });
      assert.equal(res.status, 201);
      const subToken = res.body.data.subscriptionToken;
      // 32 random bytes, base64url encoded.
      assert.ok(subToken.length >= 43, `token too short: ${subToken.length}`);
      assert.ok(!tokens.has(subToken), 'tokens must be unique');
      tokens.add(subToken);
    }
  });

  await t.test('stores only the hash of a subscription token', async () => {
    const res = await ctx.request('POST', '/api/v1/subscribers', {
      token, body: { name: 'Hashed', quotaGb: 1, days: 7 },
    });
    const raw = res.body.data.subscriptionToken;
    const row = ctx.db.prepare('SELECT token_hash, token_prefix FROM subscribers WHERE id=?').get(res.body.data.id);
    assert.equal(row.token_hash, ctx.sha256(raw));
    assert.notEqual(row.token_hash, raw);
    assert.equal(row.token_prefix, raw.slice(0, 6));
  });

  await t.test('serves profiles for a valid subscriber', async () => {
    const created = await ctx.request('POST', '/api/v1/subscribers', {
      token, body: { name: 'Valid', quotaGb: 5, days: 30 },
    });
    const subToken = created.body.data.subscriptionToken;

    const json = await ctx.request('GET', `/sub/${subToken}?format=json`);
    assert.equal(json.status, 200);
    assert.equal(json.body.data.profiles.length, 1);
    assert.equal(json.body.data.profiles[0].gatewayId, gateway.id);
    assert.match(json.body.data.profiles[0].uri, /^vless:\/\/[0-9a-f-]{36}@127\.0\.0\.1:18443\?/);

    const base64 = await ctx.request('GET', `/sub/${subToken}`);
    assert.equal(base64.status, 200);
    const decoded = Buffer.from(base64.text, 'base64').toString('utf8');
    assert.equal(decoded, json.body.data.profiles[0].uri);
    assert.match(base64.headers.get('subscription-userinfo'), /download=0; total=5368709120/);
  });

  await t.test('refuses a disabled subscriber', async () => {
    const created = await ctx.request('POST', '/api/v1/subscribers', {
      token, body: { name: 'Disabled', quotaGb: 1, days: 7 },
    });
    await ctx.request('PATCH', `/api/v1/subscribers/${created.body.data.id}`, {
      token, body: { status: 'disabled' },
    });
    const res = await ctx.request('GET', `/sub/${created.body.data.subscriptionToken}`);
    assert.equal(res.status, 404);
    assert.equal(res.text.trim(), 'subscription unavailable');
  });

  await t.test('refuses an expired subscriber', async () => {
    const created = await ctx.request('POST', '/api/v1/subscribers', {
      token, body: { name: 'Expired', quotaGb: 1, days: 7 },
    });
    ctx.db.prepare('UPDATE subscribers SET expires_at = ? WHERE id = ?')
      .run(Date.now() - 1000, created.body.data.id);
    const res = await ctx.request('GET', `/sub/${created.body.data.subscriptionToken}`);
    assert.equal(res.status, 404);
  });

  await t.test('refuses a subscriber that exhausted its quota', async () => {
    const created = await ctx.request('POST', '/api/v1/subscribers', {
      token, body: { name: 'Exhausted', quotaBytes: 1000, days: 7 },
    });
    ctx.db.prepare('UPDATE subscribers SET used_bytes = 1000 WHERE id = ?').run(created.body.data.id);
    const res = await ctx.request('GET', `/sub/${created.body.data.subscriptionToken}`);
    assert.equal(res.status, 404);
  });

  await t.test('every rejection looks identical from outside', async () => {
    const random = await ctx.request('GET', '/sub/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    assert.equal(random.status, 404);
    assert.equal(random.text.trim(), 'subscription unavailable');
  });

  await t.test('rotating the subscription token invalidates the old URL', async () => {
    const created = await ctx.request('POST', '/api/v1/subscribers', {
      token, body: { name: 'Rotate', quotaGb: 1, days: 7 },
    });
    const oldToken = created.body.data.subscriptionToken;
    assert.equal((await ctx.request('GET', `/sub/${oldToken}`)).status, 200);

    const rotated = await ctx.request('POST', `/api/v1/subscribers/${created.body.data.id}/rotate-token`, { token });
    assert.equal(rotated.status, 200);
    const newToken = rotated.body.data.subscriptionToken;
    assert.notEqual(newToken, oldToken);
    assert.equal((await ctx.request('GET', `/sub/${oldToken}`)).status, 404);
    assert.equal((await ctx.request('GET', `/sub/${newToken}`)).status, 200);
  });

  await t.test('credential rotation without grace revokes the old credential immediately', async () => {
    const created = await ctx.request('POST', '/api/v1/subscribers', {
      token, body: { name: 'CredNoGrace', quotaGb: 1, days: 7 },
    });
    const id = created.body.data.id;
    const before = ctx.db.prepare("SELECT uuid FROM credentials WHERE subscriber_id=? AND state='active'").get(id);

    await ctx.request('POST', `/api/v1/subscribers/${id}/rotate-credential`, { token, body: { graceMinutes: 0 } });
    const after = ctx.db.prepare("SELECT uuid FROM credentials WHERE subscriber_id=? AND state='active'").get(id);
    assert.notEqual(after.uuid, before.uuid);
    const old = ctx.db.prepare('SELECT state FROM credentials WHERE uuid=?').get(before.uuid);
    assert.equal(old.state, 'revoked');

    // The revoked credential must be gone from the deployed data plane.
    const config = await ctx.request('GET', `/api/v1/gateways/${gateway.id}/xray-config`, { token });
    const ids = config.body.data.config.inbounds[0].settings.clients.map((c) => c.id);
    assert.ok(!ids.includes(before.uuid));
    assert.ok(ids.includes(after.uuid));
  });

  await t.test('credential rotation with grace keeps the old credential deployed but unadvertised', async () => {
    const created = await ctx.request('POST', '/api/v1/subscribers', {
      token, body: { name: 'CredGrace', quotaGb: 1, days: 7 },
    });
    const id = created.body.data.id;
    const subToken = created.body.data.subscriptionToken;
    const before = ctx.db.prepare("SELECT uuid FROM credentials WHERE subscriber_id=? AND state='active'").get(id);

    await ctx.request('POST', `/api/v1/subscribers/${id}/rotate-credential`, { token, body: { graceMinutes: 30 } });
    const old = ctx.db.prepare('SELECT state FROM credentials WHERE uuid=?').get(before.uuid);
    assert.equal(old.state, 'retiring');

    const config = await ctx.request('GET', `/api/v1/gateways/${gateway.id}/xray-config`, { token });
    const ids = config.body.data.config.inbounds[0].settings.clients.map((c) => c.id);
    assert.ok(ids.includes(before.uuid), 'retiring credential stays deployed during the grace period');

    const sub = await ctx.request('GET', `/sub/${subToken}?format=json`);
    const advertised = sub.body.data.profiles.map((p) => p.uri);
    assert.ok(!advertised.some((uri) => uri.includes(before.uuid)), 'retiring credential is not handed out again');
  });

  await t.test('extends expiry and changes quota', async () => {
    const created = await ctx.request('POST', '/api/v1/subscribers', {
      token, body: { name: 'Extend', quotaGb: 1, days: 1 },
    });
    const before = new Date(created.body.data.expiresAt).getTime();
    const patched = await ctx.request('PATCH', `/api/v1/subscribers/${created.body.data.id}`, {
      token, body: { extendDays: 30, quotaGb: 50 },
    });
    assert.equal(patched.status, 200);
    assert.ok(new Date(patched.body.data.expiresAt).getTime() - before > 29 * 86400000);
    assert.equal(patched.body.data.quotaBytes, 50 * 1024 ** 3);
  });

  await t.test('rejects malformed subscriber input', async () => {
    const res = await ctx.request('POST', '/api/v1/subscribers', {
      token, body: { name: '', quotaGb: -5, days: 99999 },
    });
    assert.equal(res.status, 422);
    assert.equal(res.body.error.code, 'INVALID_INPUT');
    assert.ok(res.body.error.details.length >= 2);
  });

  await t.test('never returns the subscription token in the listing', async () => {
    const res = await ctx.request('GET', '/api/v1/subscribers', { token });
    assert.equal(res.status, 200);
    for (const sub of res.body.data) {
      assert.ok(!('subscriptionToken' in sub));
      assert.ok(!('tokenHash' in sub));
      assert.equal(typeof sub.tokenPrefix, 'string');
    }
  });
});
