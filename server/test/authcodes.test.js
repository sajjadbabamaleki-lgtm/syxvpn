import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';
import { issueEmailCode, verifyEmailCode, CODE_RESEND_MS, CODE_TTL_MS } from '../src/domain/authcodes.js';
import { buildMessage } from '../src/lib/smtp.js';

test('email sign-in codes', async (t) => {
  const ctx = await startTestServer();
  t.after(() => ctx.close());

  await t.test('is six digits, and only its hash is stored', () => {
    const issued = issueEmailCode(ctx.db, 'Someone@Example.com');
    assert.match(issued.code, /^\d{6}$/);
    const row = ctx.db.prepare('SELECT * FROM email_codes WHERE email = ?').get('someone@example.com');
    assert.ok(row, 'the address is stored folded to lower case');
    assert.notEqual(row.code_hash, issued.code);
    assert.ok(!JSON.stringify(row).includes(issued.code));
  });

  await t.test('works once', () => {
    const { code } = issueEmailCode(ctx.db, 'once@example.com');
    assert.equal(verifyEmailCode(ctx.db, 'once@example.com', code), true);
    assert.equal(verifyEmailCode(ctx.db, 'once@example.com', code), false);
  });

  await t.test('is spent by five wrong guesses', () => {
    const { code } = issueEmailCode(ctx.db, 'guess@example.com');
    const wrong = String((Number(code) + 1) % 1000000).padStart(6, '0');
    for (let i = 0; i < 5; i += 1) {
      assert.equal(verifyEmailCode(ctx.db, 'guess@example.com', wrong), false);
    }
    assert.equal(verifyEmailCode(ctx.db, 'guess@example.com', code), false, 'the real code no longer opens it');
  });

  await t.test('expires', () => {
    const now = Date.now();
    const { code } = issueEmailCode(ctx.db, 'stale@example.com', now);
    assert.equal(verifyEmailCode(ctx.db, 'stale@example.com', code, now + CODE_TTL_MS + 1), false);
  });

  await t.test('refuses a resend inside the cooldown, and replaces the code after it', () => {
    const now = Date.now();
    const first = issueEmailCode(ctx.db, 'again@example.com', now);
    const tooSoon = issueEmailCode(ctx.db, 'again@example.com', now + 1000);
    assert.ok(tooSoon.retryAfterSeconds > 0);
    assert.equal(tooSoon.code, undefined);

    const second = issueEmailCode(ctx.db, 'again@example.com', now + CODE_RESEND_MS + 1);
    assert.match(second.code, /^\d{6}$/);
    assert.equal(
      verifyEmailCode(ctx.db, 'again@example.com', first.code, now + CODE_RESEND_MS + 2),
      false,
      'the code it replaced is dead',
    );
  });
});

test('one way in', async (t) => {
  const ctx = await startTestServer();
  t.after(() => ctx.close());
  const session = (email, password, code) =>
    ctx.request('POST', '/api/v1/shop/auth/session', { body: { email, password, ...(code ? { code } : {}) } });

  await t.test('registers an address nobody has used', async () => {
    const res = await session('new@example.com', 'a-long-enough-password');
    assert.equal(res.status, 200);
    assert.equal(res.body.data.created, true);
    assert.ok(res.body.data.token);
  });

  await t.test('signs the same address in again without creating a second account', async () => {
    const res = await session('new@example.com', 'a-long-enough-password');
    assert.equal(res.status, 200);
    assert.equal(res.body.data.created, false);
    const count = ctx.db.prepare('SELECT COUNT(*) n FROM customers WHERE email = ?').get('new@example.com');
    assert.equal(count.n, 1);
  });

  await t.test('refuses the wrong password on a known address', async () => {
    const res = await session('new@example.com', 'not-that-password');
    assert.equal(res.status, 401);
  });

  await t.test('checks a code whenever one is given, even where none is required', async () => {
    const { code } = issueEmailCode(ctx.db, 'coded@example.com');
    const wrong = await ctx.request('POST', '/api/v1/shop/register', {
      body: { email: 'coded@example.com', password: 'a-long-enough-password', code: '000000' },
    });
    assert.equal(wrong.status, 401);
    assert.equal(
      ctx.db.prepare('SELECT COUNT(*) n FROM customers WHERE email = ?').get('coded@example.com').n,
      0,
      'nothing was created behind the failed check',
    );

    const right = await ctx.request('POST', '/api/v1/shop/register', {
      body: { email: 'coded@example.com', password: 'a-long-enough-password', code },
    });
    assert.equal(right.status, 201);
  });

  await t.test('says nothing can be sent when no relay is configured', async () => {
    const res = await ctx.request('POST', '/api/v1/shop/auth/code', { body: { email: 'new@example.com' } });
    assert.equal(res.status, 400);
  });
});

test('the message a code travels in', async (t) => {
  await t.test('escapes a leading dot and announces a non-ASCII subject', () => {
    const message = buildMessage({
      from: 'SYX VPN <no-reply@syxvpn.pro>',
      to: 'someone@example.com',
      subject: 'کد',
      text: '.first\nsecond',
    });
    assert.match(message, /^From: SYX VPN <no-reply@syxvpn\.pro>\r\n/);
    assert.match(message, /Subject: =\?UTF-8\?B\?/);
    assert.ok(message.endsWith('..first\r\nsecond'), 'a body line that is only a dot would end the message');
  });
});
