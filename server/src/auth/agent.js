import crypto from 'node:crypto';
import { config } from '../config.js';
import { hmac, randomToken, safeEqual } from '../lib/crypto.js';
import { open as openSecret, seal } from '../lib/secretbox.js';
import { unauthorized } from '../lib/errors.js';

/**
 * Gateway agents authenticate with a per-gateway HMAC-SHA256 request signature
 * rather than a bearer token, so a captured request cannot be replayed and the
 * body cannot be altered in transit even where TLS terminates upstream.
 *
 * Canonical string:
 *   METHOD \n PATH(with query) \n TIMESTAMP_MS \n NONCE \n sha256hex(body)
 */
export function canonicalString({ method, path, timestamp, nonce, body }) {
  const bodyHash = crypto.createHash('sha256').update(body ?? '').digest('hex');
  return [String(method).toUpperCase(), path, String(timestamp), nonce, bodyHash].join('\n');
}

export function signRequest({ key, method, path, body }) {
  const timestamp = Date.now();
  const nonce = randomToken(12);
  const signature = hmac(key, canonicalString({ method, path, timestamp, nonce, body }));
  return { timestamp, nonce, signature };
}

export const HEADERS = {
  gateway: 'x-jordan-gateway',
  timestamp: 'x-jordan-timestamp',
  nonce: 'x-jordan-nonce',
  signature: 'x-jordan-signature',
};

export function issueAgentKey(db, gatewayId) {
  const key = `jga_${randomToken(24)}`;
  db.prepare('UPDATE gateways SET agent_key_enc = ?, agent_key_hint = ?, agent_key_created_at = ?, updated_at = ? WHERE id = ?')
    .run(seal(key), key.slice(0, 8), Date.now(), Date.now(), gatewayId);
  return key;
}

function sweepNonces(db, now) {
  db.prepare('DELETE FROM agent_nonces WHERE expires_at <= ?').run(now);
}

/** Express middleware: verifies a signed gateway-agent request. */
export function requireAgent(db, cfg = config) {
  return (req, _res, next) => {
    const gatewayId = req.get(HEADERS.gateway);
    const timestamp = Number(req.get(HEADERS.timestamp));
    const nonce = req.get(HEADERS.nonce);
    const signature = req.get(HEADERS.signature);
    if (!gatewayId || !nonce || !signature || !Number.isFinite(timestamp)) {
      return next(unauthorized('Signed agent request required'));
    }

    const now = Date.now();
    const skewMs = cfg.agent.maxSkewSeconds * 1000;
    if (Math.abs(now - timestamp) > skewMs) return next(unauthorized('Agent request timestamp outside accepted window'));
    if (nonce.length < 8 || nonce.length > 128) return next(unauthorized('Invalid nonce'));

    const gateway = db.prepare('SELECT * FROM gateways WHERE id = ?').get(gatewayId);
    if (!gateway || !gateway.agent_key_enc) return next(unauthorized('Unknown gateway or no agent key issued'));
    const key = openSecret(gateway.agent_key_enc);
    if (!key) return next(unauthorized('Agent key unavailable'));

    const expected = hmac(key, canonicalString({
      method: req.method,
      path: req.originalUrl,
      timestamp,
      nonce,
      body: req.rawBody ?? '',
    }));
    if (!safeEqual(expected, signature)) return next(unauthorized('Invalid agent signature'));

    sweepNonces(db, now);
    try {
      db.prepare('INSERT INTO agent_nonces (nonce, gateway_id, expires_at) VALUES (?,?,?)')
        .run(`${gatewayId}:${nonce}`, gatewayId, now + skewMs * 2);
    } catch {
      return next(unauthorized('Replayed agent request'));
    }

    req.gateway = gateway;
    return next();
  };
}
