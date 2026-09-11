/**
 * Additional ways into a gateway.
 *
 * A gateway's own columns describe one inbound, and until now that was all
 * there was: every subscriber reached every gateway the same way, over the same
 * protocol, on the same port. That is one thing for a censor to learn and one
 * thing to block, and a client that is blocked on it has nothing else to try.
 *
 * An inbound here is a second (or third) door into the *same* gateway host,
 * carrying the *same* credentials to the *same* egress. Nothing about it is a
 * different service: the per-user counters still name the credential, so a
 * subscriber's quota is spent whichever door they came through.
 *
 * Three kinds, all native to the Xray already running there — no second
 * data-plane binary, no second config generator, no second thing to keep alive:
 *
 *   shadowsocks  2022-blake3-aes-256-gcm. No certificate, so it costs nothing
 *                to stand up and there is no domain to burn.
 *   trojan       Real TLS, so it is offered only on a gateway that already
 *                holds certificate material; asking for it anywhere else is
 *                refused rather than generated half-configured.
 *   reality      A second borrowed handshake. Its own site and its own key
 *                pair on purpose: borrowing the same site twice on two ports is
 *                one fingerprint, not two.
 *
 * Secrets are derived, not stored. A subscriber's key for an inbound is
 * HKDF over their credential UUID and the inbound's id, so:
 *   - no new secret material is written anywhere,
 *   - rotating a credential rotates every derived key with it,
 *   - the gateway config and the client profile compute the same value without
 *     either of them being told it.
 */

import crypto from 'node:crypto';
import net from 'node:net';
import tls from 'node:tls';
import { config } from '../config.js';
import { EVENT, recordEvent } from './events.js';
import { realityKeyPair, splitList, parseDest } from '../lib/reality.js';

/** Shadowsocks 2022 with a 32-byte key; the method every current client has. */
export const SS_METHOD = '2022-blake3-aes-256-gcm';

export const KINDS = ['shadowsocks', 'trojan', 'reality'];

/**
 * The protocol names a client may ask for, and what they mean.
 *
 * A client that asks for nothing is a client that was built before any of this
 * existed, and it gets what it has always got: `vless` and nothing else. That
 * is the whole of the backward-compatibility contract, and it is one line.
 */
export const DEFAULT_PROTOCOLS = ['vless'];

export function requestedProtocols(value) {
  if (value === undefined || value === null || value === '') return DEFAULT_PROTOCOLS;
  const asked = String(value).split(',').map((p) => p.trim().toLowerCase()).filter(Boolean);
  const known = new Set(['vless', ...KINDS]);
  // vless is not optional: it is the gateway's own inbound, and a client that
  // drops it is asking to be handed nothing at all.
  return ['vless', ...asked.filter((p) => known.has(p) && p !== 'vless')];
}

/**
 * Whether this subscriber is in the rollout cohort.
 *
 * Deterministic in the subscriber id, so a subscriber is stably in or out
 * rather than flipping between fetches — a client that is told about an inbound
 * once and not the next time would measure it, lose it, and measure it again
 * forever. Raising the percentage only ever adds subscribers.
 */
export function inCohort(subscriberId, percent = config.adaptiveInbounds.rolloutPercent) {
  if (percent >= 100) return true;
  if (percent <= 0) return false;
  const digest = crypto.createHash('sha256').update(`inbound-cohort:${subscriberId}`).digest();
  return digest.readUInt32BE(0) % 100 < percent;
}

/**
 * One subscriber's key for one inbound.
 *
 * HKDF-SHA256 over the credential UUID, salted with the inbound id: two
 * inbounds never share a key, and no key outlives the credential it came from.
 */
export function derivedKey(credentialUuid, inboundId, bytes = 32) {
  // The context string is deliberately not renamed with the product. It is an
  // input to every subscriber's key on every additional door: changing it
  // rotates all of them at once and drops whoever is connected through one.
  const key = crypto.hkdfSync('sha256', Buffer.from(credentialUuid), Buffer.from(inboundId), Buffer.from('cvpn-inbound'), bytes);
  return Buffer.from(key);
}

const userKey = (credentialUuid, inbound) => derivedKey(credentialUuid, inbound.id).toString('base64');
const trojanPassword = (credentialUuid, inbound) => derivedKey(credentialUuid, inbound.id).toString('base64url');

export const inboundTag = (id) => `client-in-${id}`;

/** Rows for one gateway, newest last. Disabled ones are included; callers filter. */
export function listInbounds(db, gatewayId) {
  return db.prepare('SELECT * FROM gateway_inbounds WHERE gateway_id = ? ORDER BY created_at, id').all(gatewayId);
}

export function getInbound(db, id) {
  return db.prepare('SELECT * FROM gateway_inbounds WHERE id = ?').get(id) || null;
}

/**
 * The inbounds a gateway should actually be running.
 *
 * The feature flag is read here rather than at every call site: with it off the
 * fleet generates the configuration it generated before this file existed, even
 * with rows in the table. That is the rollback, and it is one environment
 * variable away at any hour of the night.
 */
export function activeInbounds(db, gatewayId) {
  if (!config.adaptiveInbounds.enabled) return [];
  return listInbounds(db, gatewayId).filter((i) => i.enabled === 1);
}

/** Inbounds a subscriber may be told about: enabled, and measured as usable. */
export function offerableInbounds(db, gatewayId) {
  return activeInbounds(db, gatewayId).filter((i) => i.status !== 'offline');
}

export function createInbound(db, gatewayId, input) {
  const now = Date.now();
  const id = `ib_${crypto.randomBytes(6).toString('hex')}`;
  const row = {
    id,
    gateway_id: gatewayId,
    kind: input.kind,
    port: input.port,
    listen_address: input.listenAddress ?? null,
    enabled: input.enabled === false ? 0 : 1,
    method: input.kind === 'shadowsocks' ? SS_METHOD : null,
    // The inbound's own half of the Shadowsocks key. The subscriber's half is
    // derived; both are needed, which is what makes one leaked profile useless
    // against another subscriber's traffic.
    server_key: input.kind === 'shadowsocks' ? crypto.randomBytes(32).toString('base64') : null,
    reality_dest: null,
    reality_server_names: null,
    reality_short_ids: null,
    reality_private_key: null,
    reality_public_key: null,
    reality_fingerprint: null,
    created_at: now,
    updated_at: now,
  };

  if (input.kind === 'reality') {
    const dest = parseDest(input.realityDest || 'www.microsoft.com:443');
    const names = (input.realityServerNames && input.realityServerNames.length)
      ? input.realityServerNames
      : [dest.host];
    const pair = realityKeyPair();
    row.reality_dest = `${dest.host}:${dest.port}`;
    row.reality_server_names = names.join(',');
    row.reality_short_ids = (input.realityShortIds && input.realityShortIds.length
      ? input.realityShortIds
      : [crypto.randomBytes(4).toString('hex')]).join(',');
    row.reality_private_key = pair.privateKey;
    row.reality_public_key = pair.publicKey;
    row.reality_fingerprint = input.realityFingerprint || 'chrome';
  }

  db.prepare(`INSERT INTO gateway_inbounds
    (id,gateway_id,kind,port,listen_address,enabled,method,server_key,
     reality_dest,reality_server_names,reality_short_ids,reality_private_key,
     reality_public_key,reality_fingerprint,status,latency_ms,checked_at,fail_count,detail,created_at,updated_at)
    VALUES (@id,@gateway_id,@kind,@port,@listen_address,@enabled,@method,@server_key,
     @reality_dest,@reality_server_names,@reality_short_ids,@reality_private_key,
     @reality_public_key,@reality_fingerprint,'unknown',NULL,NULL,0,NULL,@created_at,@updated_at)`).run(row);
  return getInbound(db, id);
}

export function updateInbound(db, id, patch) {
  const current = getInbound(db, id);
  if (!current) return null;
  const next = {
    enabled: patch.enabled === undefined ? current.enabled : (patch.enabled ? 1 : 0),
    port: patch.port === undefined ? current.port : patch.port,
    updated_at: Date.now(),
    id,
  };
  db.prepare('UPDATE gateway_inbounds SET enabled=@enabled, port=@port, updated_at=@updated_at WHERE id=@id').run(next);
  return getInbound(db, id);
}

export function deleteInbound(db, id) {
  return db.prepare('DELETE FROM gateway_inbounds WHERE id = ?').run(id).changes > 0;
}

/**
 * The Xray inbound for one of these, with every entitled client on it.
 *
 * `email` is the credential id on every kind, the same value the gateway's own
 * inbound uses. That is not cosmetic: usage accounting reads Xray's per-user
 * counters by email, so a subscriber who connects over Shadowsocks spends the
 * same quota as one who connects over VLESS. Leaving it out would have made a
 * second door a way to use the service for free.
 *
 * @throws when the kind needs material the gateway does not have — a
 *   half-configured inbound is a gateway that refuses to start.
 */
export function inboundConfig(gateway, inbound, clients) {
  const listen = inbound.listen_address || '0.0.0.0';
  const base = { tag: inboundTag(inbound.id), listen, port: inbound.port };
  const sniffing = { enabled: true, destOverride: ['http', 'tls'] };

  switch (inbound.kind) {
    case 'shadowsocks':
      return {
        ...base,
        protocol: 'shadowsocks',
        settings: {
          method: inbound.method || SS_METHOD,
          password: inbound.server_key,
          network: 'tcp,udp',
          // No `method` on a user: Shadowsocks 2022 in multi-user mode refuses
          // to start if one carries it, because the method belongs to the
          // inbound and every user on it shares the cipher. Xray says so in as
          // many words, on the gateway, after a deploy — which is not where
          // that should be found out.
          clients: clients.map((c) => ({
            password: userKey(c.uuid, inbound),
            email: c.credentialId,
            level: 0,
          })),
        },
        sniffing,
      };

    case 'trojan': {
      if (!gateway.tls_cert_path || !gateway.tls_key_path) {
        throw new Error('a trojan inbound needs the gateway to hold certificate material');
      }
      return {
        ...base,
        protocol: 'trojan',
        settings: {
          clients: clients.map((c) => ({
            password: trojanPassword(c.uuid, inbound),
            email: c.credentialId,
            level: 0,
          })),
        },
        streamSettings: {
          network: 'tcp',
          security: 'tls',
          tlsSettings: {
            serverName: gateway.sni || gateway.host,
            alpn: ['h2', 'http/1.1'],
            certificates: [{ certificateFile: gateway.tls_cert_path, keyFile: gateway.tls_key_path }],
          },
        },
        sniffing,
      };
    }

    case 'reality':
      return {
        ...base,
        protocol: 'vless',
        settings: {
          clients: clients.map((c) => ({
            id: c.uuid,
            email: c.credentialId,
            level: 0,
            flow: 'xtls-rprx-vision',
          })),
          decryption: 'none',
        },
        streamSettings: {
          network: 'tcp',
          security: 'reality',
          realitySettings: {
            show: false,
            dest: inbound.reality_dest,
            xver: 0,
            serverNames: splitList(inbound.reality_server_names),
            privateKey: inbound.reality_private_key,
            shortIds: splitList(inbound.reality_short_ids),
          },
        },
        sniffing,
      };

    default:
      throw new Error(`unsupported inbound kind: ${inbound.kind}`);
  }
}

/**
 * The client profile for one inbound, in the URI form the ordinary clients read.
 *
 * Same shape of promise as a `vless://` profile: the first hop, and nothing
 * about how the gateway reaches the internet.
 */
export function inboundProfile(gateway, inbound, credentialUuid) {
  const label = `${gateway.name} · ${gateway.region} · ${inbound.kind}`;
  const fragment = encodeURIComponent(label);

  switch (inbound.kind) {
    case 'shadowsocks': {
      // SIP002: the userinfo is base64url of "method:password", and for
      // 2022-blake3 the password is the server key and the user key joined.
      const userinfo = Buffer
        .from(`${inbound.method || SS_METHOD}:${inbound.server_key}:${userKey(credentialUuid, inbound)}`)
        .toString('base64url');
      return `ss://${userinfo}@${gateway.host}:${inbound.port}#${fragment}`;
    }
    case 'trojan': {
      const params = new URLSearchParams({
        security: 'tls',
        type: 'tcp',
        sni: gateway.sni || gateway.host,
        fp: 'chrome',
      });
      return `trojan://${trojanPassword(credentialUuid, inbound)}@${gateway.host}:${inbound.port}?${params.toString()}#${fragment}`;
    }
    case 'reality': {
      const names = splitList(inbound.reality_server_names);
      const shortIds = splitList(inbound.reality_short_ids);
      const params = new URLSearchParams({
        encryption: 'none',
        security: 'reality',
        type: 'tcp',
        flow: 'xtls-rprx-vision',
        sni: names[0] || gateway.host,
        fp: inbound.reality_fingerprint || 'chrome',
        pbk: inbound.reality_public_key || '',
      });
      if (shortIds[0]) params.set('sid', shortIds[0]);
      return `vless://${credentialUuid}@${gateway.host}:${inbound.port}?${params.toString()}#${fragment}`;
    }
    default:
      throw new Error(`unsupported inbound kind: ${inbound.kind}`);
  }
}

/** Which protocol name a client has to have asked for to be told about this. */
export const protocolOf = (inbound) => inbound.kind;

/**
 * Is the port open, and is what answers it the right thing?
 *
 * Shadowsocks answers nothing until it is spoken to correctly — by design, and
 * it is what makes the protocol hard to probe — so a TCP connection is the
 * whole of the check there. The two TLS kinds can be checked properly: REALITY
 * has to present the borrowed site's certificate and trojan its own, and either
 * one failing to verify means the port is open with the wrong thing behind it,
 * which is worse than being closed.
 */
export function probeInbound(gateway, inbound, timeoutMs = config.health.probeTimeoutMs) {
  const started = Date.now();
  if (inbound.kind === 'shadowsocks') {
    return new Promise((resolve) => {
      const socket = net.connect({ host: gateway.host, port: inbound.port, timeout: timeoutMs });
      const finish = (status, detail) => {
        socket.destroy();
        resolve({ status, latencyMs: Date.now() - started, detail, checkKind: 'tcp' });
      };
      socket.once('connect', () => finish('online', `shadowsocks: port ${inbound.port} open`));
      socket.once('timeout', () => finish('offline', `shadowsocks probe timeout after ${timeoutMs}ms`));
      socket.once('error', (err) => finish('offline', `shadowsocks probe: ${err.code || err.message}`));
    });
  }

  const serverName = inbound.kind === 'reality'
    ? (splitList(inbound.reality_server_names)[0] || gateway.host)
    : (gateway.sni || gateway.host);

  return new Promise((resolve) => {
    const socket = tls.connect({
      host: gateway.host,
      port: inbound.port,
      servername: serverName,
      rejectUnauthorized: true,
      timeout: timeoutMs,
    });
    let settled = false;
    const finish = (status, detail) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ status, latencyMs: Date.now() - started, detail, checkKind: 'tls' });
    };
    socket.once('secureConnect', () => finish('online', `${inbound.kind}: ${serverName} handshake verified`));
    socket.once('timeout', () => finish('offline', `${inbound.kind} probe timeout after ${timeoutMs}ms`));
    socket.once('error', (err) => {
      const code = err.code || err.message;
      const broken = typeof code === 'string' && (code.includes('CERT') || code.includes('ALT_NAME'));
      finish(broken ? 'degraded' : 'offline', `${inbound.kind} probe: ${code}`);
    });
  });
}

/**
 * Writes what a probe found, and raises an event when the answer changed.
 *
 * The same failure threshold the gateway's own ingress uses: one missed probe
 * is a network, several are an outage. An inbound that goes offline stops being
 * advertised to clients on the next fetch, and the clients already holding it
 * fall back on their own — which is the point of there being more than one.
 */
export function applyInboundResult(db, gateway, inbound, result) {
  const now = Date.now();
  const previous = inbound.status;
  let failCount = inbound.fail_count;
  let next = result.status;

  if (result.status === 'offline') {
    failCount += 1;
    if (failCount < config.health.failureThreshold) next = previous === 'online' ? 'degraded' : previous;
  } else {
    failCount = 0;
  }

  db.prepare(`UPDATE gateway_inbounds SET status=?, latency_ms=?, checked_at=?, fail_count=?, detail=?, updated_at=?
    WHERE id=?`).run(next, result.latencyMs ?? null, now, failCount, result.detail ?? null, now, inbound.id);

  db.prepare(`INSERT INTO health_checks
      (target_type,target_id,gateway_id,check_kind,status,latency_ms,detail,source,created_at)
      VALUES ('inbound',?,?,?,?,?,?, 'control-plane', ?)`)
    .run(inbound.id, gateway.id, result.checkKind || 'tcp', result.status,
      result.latencyMs ?? null, result.detail ?? null, now);

  if (next !== previous) {
    recordEvent(db, {
      type: next === 'online' ? EVENT.GATEWAY_ONLINE
        : next === 'offline' ? EVENT.GATEWAY_OFFLINE : EVENT.GATEWAY_DEGRADED,
      // An inbound going down is not the gateway going down: the gateway's own
      // door is still open and clients still have somewhere to be. Warning, not
      // critical, or a rollout would page somebody every time a new port on one
      // box was slow to come up.
      severity: next === 'offline' ? 'warning' : 'info',
      targetType: 'gateway',
      targetId: gateway.id,
      message: `${gateway.name} ${inbound.kind} inbound on ${inbound.port}: ${previous} → ${next}`,
      data: { inboundId: inbound.id, kind: inbound.kind, port: inbound.port, latencyMs: result.latencyMs ?? null },
    });
  }
  return { status: next, latencyMs: result.latencyMs ?? null, detail: result.detail ?? null };
}

/** Probes every enabled inbound on a gateway and records what came back. */
export async function checkGatewayInbounds(db, gateway) {
  const results = [];
  for (const inbound of activeInbounds(db, gateway.id)) {
    const result = await probeInbound(gateway, inbound);
    results.push({ inboundId: inbound.id, ...applyInboundResult(db, gateway, inbound, result) });
  }
  return results;
}
