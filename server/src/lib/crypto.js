import crypto from 'node:crypto';

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };

/** URL-safe random token. 32 bytes = 256 bits of entropy. */
export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');

/** Prefixed, collision-resistant public identifier. */
export const newId = (prefix) => `${prefix}_${crypto.randomBytes(9).toString('base64url')}`;

/** SHA-256 in hex — used to store bearer/subscription tokens at rest. */
export const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

/** Timing-safe comparison of two strings of any length. */
export function safeEqual(a, b) {
  const ba = Buffer.from(String(a ?? ''), 'utf8');
  const bb = Buffer.from(String(b ?? ''), 'utf8');
  // Hash first so lengths always match; prevents length leakage.
  const ha = crypto.createHash('sha256').update(ba).digest();
  const hb = crypto.createHash('sha256').update(bb).digest();
  return crypto.timingSafeEqual(ha, hb);
}

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(password, stored) {
  try {
    const [scheme, N, r, p, salt, hash] = String(stored).split('$');
    if (scheme !== 'scrypt') return false;
    const expected = Buffer.from(hash, 'base64');
    const actual = crypto.scryptSync(password, Buffer.from(salt, 'base64'), expected.length, {
      N: Number(N), r: Number(r), p: Number(p), maxmem: 128 * Number(N) * Number(r) * 4,
    });
    return crypto.timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

/** HMAC-SHA256 hex, used for gateway-agent request signing. */
export const hmac = (key, payload) => crypto.createHmac('sha256', key).update(payload).digest('hex');

/** Shows only enough of a token to identify it in a UI/log. */
export const tokenHint = (token) => (token ? `${String(token).slice(0, 6)}…` : '');
