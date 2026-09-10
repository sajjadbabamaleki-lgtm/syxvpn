import test from 'node:test';
import assert from 'node:assert/strict';
import {
  base32Decode,
  base32Encode,
  codeFor,
  counterAt,
  generateRecoveryCodes,
  generateSecret,
  provisioningUri,
  verify,
  RECOVERY_CODE_SHAPE,
} from '../src/lib/totp.js';

test('one-time passwords', async (t) => {
  // RFC 4226 Appendix D: the published vectors for the secret "12345678901234567890",
  // which is what every implementation is checked against.
  const RFC_SECRET = base32Encode(Buffer.from('12345678901234567890', 'ascii'));
  const RFC_VECTORS = [
    '755224', '287082', '359152', '969429', '338314',
    '254676', '287922', '162583', '399871', '520489',
  ];

  await t.test('matches the RFC 4226 test vectors', () => {
    RFC_VECTORS.forEach((expected, counter) => {
      assert.equal(codeFor(RFC_SECRET, counter), expected, `counter ${counter}`);
    });
  });

  await t.test('base32 round-trips, including lengths that need padding', () => {
    for (const sample of ['a', 'ab', 'abc', 'abcd', 'abcde', 'hello world', '12345678901234567890']) {
      const encoded = base32Encode(Buffer.from(sample, 'ascii'));
      assert.equal(base32Decode(encoded).toString('ascii'), sample, sample);
    }
  });

  await t.test('base32 accepts what a person types: spaces, lower case, padding', () => {
    const secret = base32Encode(Buffer.from('1234567890', 'ascii'));
    const typed = `${secret.toLowerCase().slice(0, 4)} ${secret.toLowerCase().slice(4)}==`;
    assert.deepEqual(base32Decode(typed), base32Decode(secret));
  });

  await t.test('rejects characters base32 has no place for', () => {
    assert.throws(() => base32Decode('ABC1'), /not base32/);
  });

  await t.test('a generated secret is 32 base32 characters of real randomness', () => {
    const a = generateSecret();
    const b = generateSecret();
    assert.match(a, /^[A-Z2-7]{32}$/);
    assert.notEqual(a, b);
  });

  await t.test('the current code verifies and returns its counter', () => {
    const secret = generateSecret();
    const at = 1_800_000_000_000;
    const code = codeFor(secret, counterAt(at));
    assert.equal(verify(secret, code, { at }), counterAt(at));
  });

  await t.test('a phone one step out of step is still accepted', () => {
    const secret = generateSecret();
    const at = 1_800_000_000_000;
    const early = codeFor(secret, counterAt(at) - 1);
    const late = codeFor(secret, counterAt(at) + 1);
    assert.equal(verify(secret, early, { at }), counterAt(at) - 1);
    assert.equal(verify(secret, late, { at }), counterAt(at) + 1);
  });

  await t.test('two steps out is not', () => {
    const secret = generateSecret();
    const at = 1_800_000_000_000;
    assert.equal(verify(secret, codeFor(secret, counterAt(at) - 2), { at }), null);
  });

  await t.test('the wrong code, a wrong length, and nothing at all are all refused', () => {
    const secret = generateSecret();
    const at = 1_800_000_000_000;
    const right = codeFor(secret, counterAt(at));
    const wrong = String((Number(right) + 1) % 1_000_000).padStart(6, '0');
    assert.equal(verify(secret, wrong, { at }), null);
    assert.equal(verify(secret, '12345', { at }), null);
    assert.equal(verify(secret, '1234567', { at }), null);
    assert.equal(verify(secret, '', { at }), null);
    assert.equal(verify(secret, null, { at }), null);
    assert.equal(verify(secret, 'abcdef', { at }), null);
  });

  await t.test("another account's code does not open this one", () => {
    const at = 1_800_000_000_000;
    const mine = generateSecret();
    const theirs = generateSecret();
    assert.equal(verify(mine, codeFor(theirs, counterAt(at)), { at }), null);
  });

  await t.test('a code is the same for the whole step and changes at the boundary', () => {
    const secret = generateSecret();
    const step = 30_000;
    const start = Math.floor(1_800_000_000_000 / step) * step;
    assert.equal(codeFor(secret, counterAt(start)), codeFor(secret, counterAt(start + step - 1)));
    assert.notEqual(codeFor(secret, counterAt(start)), codeFor(secret, counterAt(start + step)));
  });

  await t.test('the counter keeps its high bits, which a 32-bit write would lose', () => {
    const secret = generateSecret();
    // Beyond 2^32 steps: about the year 6000, but wrong is wrong.
    const big = 2 ** 32 + 7;
    assert.notEqual(codeFor(secret, big), codeFor(secret, 7));
  });

  await t.test('the provisioning URI carries what an authenticator needs', () => {
    const secret = generateSecret();
    const uri = provisioningUri({ secret, account: 'admin', issuer: 'cVPN' });
    const parsed = new URL(uri);
    assert.equal(parsed.protocol, 'otpauth:');
    // The type sits where a host would, so the label is the whole path.
    assert.equal(parsed.host, 'totp');
    assert.equal(decodeURIComponent(parsed.pathname), '/cVPN:admin');
    assert.equal(parsed.searchParams.get('secret'), secret);
    assert.equal(parsed.searchParams.get('issuer'), 'cVPN');
    assert.equal(parsed.searchParams.get('digits'), '6');
    assert.equal(parsed.searchParams.get('period'), '30');
  });

  await t.test('recovery codes are unique, shaped, and there are enough of them', () => {
    const codes = generateRecoveryCodes();
    assert.equal(codes.length, 8);
    assert.equal(new Set(codes).size, 8);
    codes.forEach((code) => assert.match(code, RECOVERY_CODE_SHAPE, code));
  });
});
