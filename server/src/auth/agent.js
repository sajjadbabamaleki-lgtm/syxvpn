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

/**
 * Not renamed with the product, on purpose.
 *
 * These names are a wire protocol between the control plane and every agent in
 * the fleet, not a brand. Renaming them costs a release where both are accepted
 * and an agent rollout across every gateway, buys nothing a customer can see,
 * and has already been paid for once (see LEGACY_HEADERS below).
 */
export const HEADERS = {
  gateway: 'x-cvpn-gateway',
  timestamp: 'x-cvpn-timestamp',
  nonce: 'x-cvpn-nonce',
  signature: 'x-cvpn-signature',
};

/**
 * What these headers used to be called.
 *
 * The control plane is upgraded before the agents on the gateways are — that is
 * the order deploying anything takes — so for one release it answers to both.
 * Without this, renaming the headers would take every gateway offline the
 * moment the control plane restarted, and the fix would have to be applied by
 * hand on machines that had just stopped being reachable through the console.
 *
 * Remove once no gateway is running an agent older than this change.
 */
const LEGACY_HEADERS = {
  gateway: 'x-jordan-gateway',
  timestamp: 'x-jordan-timestamp',
  nonce: 'x-jordan-nonce',
  signature: 'x-jordan-signature',
};

export const agentHeader = (req, name) => req.get(HEADERS[name]) || req.get(LEGACY_HEADERS[name]);

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
    const gatewayId = agentHeader(req, 'gateway');
    const timestamp = Number(agentHeader(req, 'timestamp'));
    const nonce = agentHeader(req, 'nonce');
    const signature = agentHeader(req, 'signature');
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
