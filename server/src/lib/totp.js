import crypto from 'node:crypto';

/**
 * Time-based one-time passwords (RFC 6238 over RFC 4226).
 *
 * Written here rather than pulled in: the whole algorithm is an HMAC, a
 * truncation and a modulo, and node's crypto already has the only hard part.
 * A dependency for thirty lines is a dependency that can be taken over, and
 * this one would sit on the path that guards every gateway in the fleet.
 *
 * Defaults are what authenticator apps assume when a QR code omits them —
 * SHA-1, six digits, thirty seconds. They are not modern choices; they are the
 * ones every app can read, and an operator locked out by an exotic parameter is
 * worse off than one with SHA-1.
 */

const DIGITS = 6;
const STEP_SECONDS = 30;
const ALGORITHM = 'sha1';

/** RFC 4648 base32, which is what authenticator apps take. */
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buffer) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text) {
  const cleaned = String(text).toUpperCase().replace(/=+$/, '').replace(/\s+/g, '');
  let bits = 0;
  let value = 0;
  const out = [];
  for (const char of cleaned) {
    const index = ALPHABET.indexOf(char);
    if (index === -1) throw new Error(`not base32: ${char}`);
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** A fresh secret. 20 bytes is the RFC 4226 recommendation for SHA-1. */
export const generateSecret = () => base32Encode(crypto.randomBytes(20));

/** Which time step [when] falls in. Exported because replay defence stores it. */
export const counterAt = (when = Date.now(), stepSeconds = STEP_SECONDS) =>
  Math.floor(when / 1000 / stepSeconds);

/** The code for one counter value. */
export function codeFor(secret, counter, { digits = DIGITS, algorithm = ALGORITHM } = {}) {
  const key = base32Decode(secret);
  const message = Buffer.alloc(8);
  // A JS number cannot hold the whole counter as one 64-bit integer, and will
  // not need to until the year 5000 — but the high half must still be written.
  message.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  message.writeUInt32BE(counter >>> 0, 4);
  const digest = crypto.createHmac(algorithm, key).update(message).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary = ((digest[offset] & 0x7f) << 24)
    | ((digest[offset + 1] & 0xff) << 16)
    | ((digest[offset + 2] & 0xff) << 8)
    | (digest[offset + 3] & 0xff);
  return String(binary % 10 ** digits).padStart(digits, '0');
}

/**
 * Checks [code] against the secret and returns the counter it matched, or null.
 *
 * The counter is returned rather than a boolean because the caller has to store
 * it: a code stays valid for its whole step, so without recording the last one
 * accepted, a code read over someone's shoulder — or replayed from a log — can
 * be used again seconds later.
 *
 * [window] steps either side are accepted, for the clock drift that every
 * phone has. One step is the usual compromise: thirty seconds of tolerance,
 * against three codes being live at once instead of one.
 */
export function verify(secret, code, { at = Date.now(), window = 1, digits = DIGITS } = {}) {
  const cleaned = String(code || '').replace(/\s+/g, '');
  if (!new RegExp(`^\\d{${digits}}$`).test(cleaned)) return null;
  const centre = counterAt(at);
  for (let drift = -window; drift <= window; drift += 1) {
    const counter = centre + drift;
    if (counter < 0) continue;
    const expected = codeFor(secret, counter, { digits });
    // Constant time: a comparison that returns early on the first wrong digit
    // tells an attacker how much of a guess was right.
    if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(cleaned))) return counter;
  }
  return null;
}

/**
 * The `otpauth://` URI an authenticator app reads from a QR code.
 *
 * The issuer appears twice — once in the label, once as a parameter — because
 * that is what the de-facto spec does and apps disagree about which they read.
 */
export function provisioningUri({ secret, account, issuer }) {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: ALGORITHM.toUpperCase(),
    digits: String(DIGITS),
    period: String(STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

/**
 * Recovery codes, for the phone that is lost or wiped.
 *
 * Without these, two-factor on the only account that can reach the fleet is a
 * way to lose the fleet. They are shown once and stored only as hashes, like
 * any other credential.
 */
export function generateRecoveryCodes(count = 8) {
  return Array.from({ length: count }, () =>
    crypto.randomBytes(5).toString('hex').replace(/(.{4})/g, '$1-').replace(/-$/, ''));
}

export const RECOVERY_CODE_SHAPE = /^[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{2}$/;

export const defaults = { DIGITS, STEP_SECONDS, ALGORITHM };
