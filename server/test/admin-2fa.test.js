import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, ADMIN_PASSWORD } from './helpers.js';
import { codeFor, counterAt } from '../src/lib/totp.js';

/**
 * The admin password is the only thing between the internet and every gateway,
 * subscriber and credential in the fleet. These tests are about the second
 * thing: that it can be switched on without locking the account out, that a
 * code cannot be used twice, and that losing a phone is not losing the fleet.
 */
test('admin two-factor', async (t) => {
  const ctx = await startTestServer();
  t.after(() => ctx.close());

  const codeNow = (secret) => codeFor(secret, counterAt(Date.now()));
  let token = await ctx.login();
  let secret = null;
  let recoveryCodes = [];

  await t.test('is off until it is switched on', async () => {
    const state = await ctx.request('GET', '/api/v1/auth/totp', { token });
    assert.equal(state.body.data.enabled, false);
    assert.equal(state.body.data.enrolmentStarted, false);
  });

  await t.test('setup hands back a secret and something an app can scan', async () => {
    const res = await ctx.request('POST', '/api/v1/auth/totp/setup', { token });
    assert.equal(res.status, 200);
    secret = res.body.data.secret;
    assert.match(secret, /^[A-Z2-7]{32}$/);
    assert.ok(res.body.data.uri.startsWith('otpauth://totp/'));
    assert.ok(res.body.data.uri.includes(secret));
  });

  await t.test('a secret alone does not turn it on', async () => {
    const state = await ctx.request('GET', '/api/v1/auth/totp', { token });
    assert.equal(state.body.data.enabled, false, 'a mistyped secret must not lock the account out');
    assert.equal(state.body.data.enrolmentStarted, true);
    // And the password alone still signs in while enrolment is unconfirmed.
    const login = await ctx.request('POST', '/api/v1/auth/login', {
      body: { username: 'admin', password: ADMIN_PASSWORD },
    });
    assert.equal(login.status, 200);
  });

  await t.test('a wrong code does not confirm it', async () => {
    const res = await ctx.request('POST', '/api/v1/auth/totp/confirm', {
      token,
      body: { code: '000000' },
    });
    assert.equal(res.status, 400);
  });

  await t.test('a real code confirms it and returns recovery codes once', async () => {
    const res = await ctx.request('POST', '/api/v1/auth/totp/confirm', {
      token,
      body: { code: codeNow(secret) },
    });
    assert.equal(res.status, 200);
    recoveryCodes = res.body.data.recoveryCodes;
    assert.equal(recoveryCodes.length, 8);

    const state = await ctx.request('GET', '/api/v1/auth/totp', { token });
    assert.equal(state.body.data.enabled, true);
    assert.equal(state.body.data.recoveryCodesLeft, 8);
    assert.ok(!JSON.stringify(state.body).includes(recoveryCodes[0]), 'never readable again');
  });

  await t.test('recovery codes are stored hashed, not in the clear', () => {
    const rows = ctx.db.prepare('SELECT code_hash FROM admin_recovery_codes').all();
    assert.equal(rows.length, 8);
    rows.forEach((row) => {
      assert.match(row.code_hash, /^[0-9a-f]{64}$/);
      assert.ok(!recoveryCodes.includes(row.code_hash));
    });
  });

  await t.test('the password alone no longer signs in, and says why', async () => {
    const res = await ctx.request('POST', '/api/v1/auth/login', {
      body: { username: 'admin', password: ADMIN_PASSWORD },
    });
    assert.equal(res.status, 401);
    assert.equal(res.body.error.code, 'TOTP_REQUIRED');
  });

  await t.test('a wrong password with a right code is still refused', async () => {
    const res = await ctx.request('POST', '/api/v1/auth/login', {
      body: { username: 'admin', password: 'not-the-password', code: codeNow(secret) },
    });
    assert.equal(res.status, 401);
    assert.notEqual(res.body.error.code, 'TOTP_REQUIRED', 'a wrong password must not leak that far');
  });

  await t.test('password and code together sign in, and that code is then spent', async () => {
    // The code that confirmed enrolment is already recorded as used, so this
    // is the next step's — which is the same thing a person does, thirty
    // seconds later, with the next number their app shows.
    const code = codeFor(secret, counterAt(Date.now()) + 1);
    const res = await ctx.request('POST', '/api/v1/auth/login', {
      body: { username: 'admin', password: ADMIN_PASSWORD, code },
    });
    assert.equal(res.status, 200);
    token = res.body.data.token;

    const replay = await ctx.request('POST', '/api/v1/auth/login', {
      body: { username: 'admin', password: ADMIN_PASSWORD, code },
    });
    assert.equal(replay.status, 401, 'a code read over a shoulder is spent');
  });

  await t.test('the code that confirmed enrolment is spent too', async () => {
    const res = await ctx.request('POST', '/api/v1/auth/login', {
      body: { username: 'admin', password: ADMIN_PASSWORD, code: codeNow(secret) },
    });
    assert.equal(res.status, 401, 'confirming enrolment uses the code up like any other login');
  });

  await t.test('a recovery code works, and only once', async () => {
    const code = recoveryCodes[0];
    const first = await ctx.request('POST', '/api/v1/auth/login', {
      body: { username: 'admin', password: ADMIN_PASSWORD, code },
    });
    assert.equal(first.status, 200, 'losing the phone is not losing the fleet');
    const again = await ctx.request('POST', '/api/v1/auth/login', {
      body: { username: 'admin', password: ADMIN_PASSWORD, code },
    });
    assert.equal(again.status, 401);

    const left = await ctx.request('GET', '/api/v1/auth/totp', { token: first.body.data.token });
    assert.equal(left.body.data.recoveryCodesLeft, 7);
    token = first.body.data.token;
  });

  await t.test('switching it off needs the password as well as a code', async () => {
    const noPassword = await ctx.request('POST', '/api/v1/auth/totp/disable', {
      token,
      body: { password: 'wrong', code: recoveryCodes[1] },
    });
    assert.equal(noPassword.status, 401, 'a borrowed session must not remove the second factor');

    assert.equal(noPassword.body.error.code, 'REAUTH_FAILED', 'a typo here is not an expired session');

    const noCode = await ctx.request('POST', '/api/v1/auth/totp/disable', {
      token,
      body: { password: ADMIN_PASSWORD },
    });
    assert.equal(noCode.status, 401);

    // And the session that asked is still good, so the console can ask again.
    const state = await ctx.request('GET', '/api/v1/auth/totp', { token });
    assert.equal(state.status, 200);
    assert.equal(state.body.data.enabled, true);
  });

  await t.test('with both, it comes off and the recovery codes go with it', async () => {
    // A recovery code, because this is the shape the request takes when the
    // phone is the thing that was lost — and every live one-time code from
    // this window has already been used above.
    const res = await ctx.request('POST', '/api/v1/auth/totp/disable', {
      token,
      body: { password: ADMIN_PASSWORD, code: recoveryCodes[2] },
    });
    assert.equal(res.status, 200);

    const state = await ctx.request('GET', '/api/v1/auth/totp', { token });
    assert.equal(state.body.data.enabled, false);
    assert.equal(state.body.data.recoveryCodesLeft, 0);
    assert.equal(ctx.db.prepare('SELECT count(*) AS n FROM admin_recovery_codes').get().n, 0);

    const login = await ctx.request('POST', '/api/v1/auth/login', {
      body: { username: 'admin', password: ADMIN_PASSWORD },
    });
    assert.equal(login.status, 200, 'the password alone signs in again');
  });
});
