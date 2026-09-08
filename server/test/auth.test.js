import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, ADMIN_PASSWORD } from './helpers.js';

test('admin authentication', async (t) => {
  const ctx = await startTestServer();
  t.after(() => ctx.close());

  await t.test('rejects an unauthenticated management request', async () => {
    const res = await ctx.request('GET', '/api/v1/gateways');
    assert.equal(res.status, 401);
    assert.equal(res.body.error.code, 'UNAUTHORIZED');
  });

  await t.test('rejects a wrong password without revealing the account', async () => {
    const res = await ctx.request('POST', '/api/v1/auth/login', {
      body: { username: 'admin', password: 'wrong-password' },
    });
    assert.equal(res.status, 401);
    const unknown = await ctx.request('POST', '/api/v1/auth/login', {
      body: { username: 'nobody', password: 'wrong-password' },
    });
    assert.equal(unknown.status, 401);
    assert.deepEqual(res.body.error, unknown.body.error);
  });

  await t.test('issues a session token that authorises management calls', async () => {
    const token = await ctx.login();
    assert.ok(token && token.length >= 32);
    const res = await ctx.request('GET', '/api/v1/gateways', { token });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.data, []);
  });

  await t.test('stores only the hash of a session token', async () => {
    const token = await ctx.login();
    const stored = ctx.db.prepare('SELECT token_hash FROM admin_sessions').all().map((r) => r.token_hash);
    assert.ok(!stored.includes(token));
    assert.ok(stored.includes(ctx.sha256(token)));
  });

  await t.test('rejects a forged bearer token', async () => {
    const res = await ctx.request('GET', '/api/v1/gateways', { token: 'not-a-real-session-token' });
    assert.equal(res.status, 401);
  });

  await t.test('rejects an expired session', async () => {
    const token = await ctx.login();
    ctx.db.prepare('UPDATE admin_sessions SET expires_at = ? WHERE token_hash = ?')
      .run(Date.now() - 1000, ctx.sha256(token));
    const res = await ctx.request('GET', '/api/v1/gateways', { token });
    assert.equal(res.status, 401);
    assert.match(res.body.error.message, /expired/i);
  });

  await t.test('changing the password revokes every existing session', async () => {
    const token = await ctx.login();
    const res = await ctx.request('POST', '/api/v1/auth/password', {
      token,
      body: { currentPassword: ADMIN_PASSWORD, newPassword: 'a-much-longer-password' },
    });
    assert.equal(res.status, 200);
    const after = await ctx.request('GET', '/api/v1/gateways', { token });
    assert.equal(after.status, 401);
    assert.ok(await ctx.login('a-much-longer-password'));
  });

  await t.test('rate limits repeated login attempts', async () => {
    const attempts = [];
    for (let i = 0; i < 14; i += 1) {
      attempts.push(await ctx.request('POST', '/api/v1/auth/login', {
        body: { username: 'ratelimited', password: 'nope' },
      }));
    }
    const limited = attempts.filter((r) => r.status === 429);
    assert.ok(limited.length > 0, 'expected some attempts to be rate limited');
    assert.equal(limited[0].body.error.code, 'RATE_LIMITED');
  });
});
