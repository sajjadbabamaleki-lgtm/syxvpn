import crypto from 'node:crypto';

/**
 * REALITY key material.
 *
 * REALITY is the reason this exists at all. A VLESS-over-WebSocket gateway
 * behind Caddy looks, to a censor, like a TLS connection to a site that only
 * ever serves one WebSocket path — and the certificate names a domain the
 * operator owns, which is a list a censor can build. REALITY borrows a real
 * site's handshake instead: the TLS a censor sees is *actually* the one
 * www.microsoft.com would send, because the gateway forwards the handshake
 * there for anyone who is not a subscriber. There is no certificate to buy and
 * no domain to burn.
 *
 * Its key exchange is X25519, and the values Xray reads from a configuration
 * are the raw 32-byte keys in unpadded base64url — the same encoding
 * `xray x25519` prints. Node has X25519, so the control plane can issue the
 * pair itself and the operator never has to run a command on the gateway to
 * bring one up.
 */

/** The 32 raw bytes at the end of a DER key, which is where X25519 keeps them. */
const rawFromDer = (der) => Buffer.from(der.subarray(der.length - 32));

const b64url = (buffer) => buffer.toString('base64url');

/** Wraps 32 raw private bytes in the PKCS#8 DER that `createPrivateKey` reads. */
function privateKeyFromRaw(raw) {
  const prefix = Buffer.from('302e020100300506032b656e04220420', 'hex');
  return crypto.createPrivateKey({
    key: Buffer.concat([prefix, raw]),
    format: 'der',
    type: 'pkcs8',
  });
}

/** The public key belonging to a private one, as the client profile carries it. */
export function realityPublicKey(privateKeyBase64Url) {
  const raw = Buffer.from(privateKeyBase64Url, 'base64url');
  if (raw.length !== 32) throw new Error('a REALITY private key is 32 bytes');
  const der = crypto.createPublicKey(privateKeyFromRaw(raw)).export({ format: 'der', type: 'spki' });
  return b64url(rawFromDer(der));
}

/** A fresh pair. The private half stays here and on the gateway; the public half ships. */
export function realityKeyPair() {
  const { privateKey } = crypto.generateKeyPairSync('x25519');
  const raw = rawFromDer(privateKey.export({ format: 'der', type: 'pkcs8' }));
  const secret = b64url(raw);
  return { privateKey: secret, publicKey: realityPublicKey(secret) };
}

/**
 * Short IDs: what tells the gateway a client is a subscriber rather than
 * someone to forward to the borrowed site. An even number of hex characters,
 * up to sixteen, and the empty string is allowed — which accepts any client
 * that knows the public key, so it is not what gets generated here.
 */
export const SHORT_ID_SHAPE = /^([0-9a-f]{2}){1,8}$/;

export function generateShortIds(count = 2) {
  return Array.from({ length: count }, () => crypto.randomBytes(4).toString('hex'));
}

/**
 * Is [dest] a plausible borrowed site? `host:port`, with a port, because Xray
 * dials it — a bare hostname is the most common way to get REALITY wrong.
 *
 * The site itself has to be one that supports TLS 1.3 and HTTP/2, is not
 * blocked where the subscribers are, and is not the operator's own: the whole
 * disguise is that the handshake belongs to somebody real.
 */
export function parseDest(value) {
  const text = String(value || '').trim();
  const match = /^([a-z0-9.-]+):(\d{1,5})$/i.exec(text);
  if (!match) return null;
  const port = Number(match[2]);
  if (port < 1 || port > 65535) return null;
  return { host: match[1], port, value: `${match[1]}:${port}` };
}

/** `a.com, b.com` → `['a.com','b.com']`, which is how the columns store lists. */
export const splitList = (value) => String(value || '')
  .split(',')
  .map((item) => item.trim())
  .filter(Boolean);
