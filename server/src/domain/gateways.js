import { newId } from '../lib/crypto.js';
import { EVENT, recordEvent } from './events.js';
import { gatewayServerConfig, stableStringify, structuralConfig, probePort } from './xray.js';
import { sha256 } from '../lib/crypto.js';
import { realityKeyPair, generateShortIds, parseDest } from '../lib/reality.js';
import { activeInbounds, inboundConfig } from './inbounds.js';

export function listGateways(db) {
  return db.prepare('SELECT * FROM gateways ORDER BY priority, name').all();
}

export function getGateway(db, id) {
  return db.prepare('SELECT * FROM gateways WHERE id = ?').get(id) || null;
}

/**
 * Fills in the REALITY material an operator should not have to produce by hand.
 *
 * A key pair and short IDs are generated here rather than asked for: running
 * `xray x25519` on the box is a step that gets skipped, mistyped, or done once
 * and reused across every gateway — and a shared key means one seized gateway
 * exposes the rest. [current] is the existing row when a gateway is being
 * changed, so switching a REALITY gateway's port does not silently reissue its
 * keys and break every profile already handed out.
 */
function realityFields(input, current = null) {
  if (input.transport !== 'reality') {
    return { realityDest: null, realityServerNames: null, realityPrivateKey: null,
      realityPublicKey: null, realityShortIds: null, realityFingerprint: 'chrome' };
  }
  const dest = parseDest(input.realityDest ?? current?.reality_dest);
  const keepKey = current?.reality_private_key && input.realityPrivateKey === undefined;
  const pair = keepKey
    ? { privateKey: current.reality_private_key, publicKey: current.reality_public_key }
    : realityKeyPair();
  const names = input.realityServerNames?.length
    ? input.realityServerNames
    : (current?.reality_server_names ? current.reality_server_names.split(',') : [dest?.host].filter(Boolean));
  const shortIds = input.realityShortIds?.length
    ? input.realityShortIds
    : (current?.reality_short_ids ? current.reality_short_ids.split(',') : generateShortIds());
  return {
    realityDest: dest?.value ?? null,
    realityServerNames: names.join(','),
    realityPrivateKey: pair.privateKey,
    realityPublicKey: pair.publicKey,
    realityShortIds: shortIds.join(','),
    realityFingerprint: input.realityFingerprint ?? current?.reality_fingerprint ?? 'chrome',
  };
}

export function createGateway(db, input) {
  const now = Date.now();
  const id = newId('gw');
  const reality = realityFields(input);
  db.prepare(`INSERT INTO gateways
      (id,name,region,host,port,transport,tls_mode,sni,ws_path,ws_host,listen_address,listen_port,
       tls_cert_path,tls_key_path,reality_dest,reality_server_names,reality_private_key,
       reality_public_key,reality_short_ids,reality_fingerprint,
       priority,enabled,block_private_ranges,created_at,updated_at)
      VALUES (@id,@name,@region,@host,@port,@transport,@tlsMode,@sni,@wsPath,@wsHost,@listenAddress,@listenPort,
              @tlsCertPath,@tlsKeyPath,@realityDest,@realityServerNames,@realityPrivateKey,
              @realityPublicKey,@realityShortIds,@realityFingerprint,
              @priority,@enabled,@blockPrivateRanges,@now,@now)`)
    .run({
      id,
      ...reality,
      name: input.name,
      region: input.region,
      host: input.host,
      port: input.port,
      transport: input.transport ?? 'ws',
      tlsMode: input.tlsMode ?? 'none',
      sni: input.sni ?? null,
      wsPath: input.wsPath ?? '/ws',
      wsHost: input.wsHost ?? null,
      listenAddress: input.listenAddress ?? (input.tlsMode === 'reverse-proxy' ? '127.0.0.1' : '0.0.0.0'),
      listenPort: input.listenPort ?? null,
      tlsCertPath: input.tlsCertPath ?? null,
      tlsKeyPath: input.tlsKeyPath ?? null,
      priority: input.priority ?? 100,
      enabled: input.enabled === false ? 0 : 1,
      blockPrivateRanges: input.blockPrivateRanges === false ? 0 : 1,
      now,
    });
  recordEvent(db, {
    type: EVENT.GATEWAY_CREATED, targetType: 'gateway', targetId: id,
    message: `Gateway ${input.name} registered (${input.host}:${input.port})`,
  });
  return getGateway(db, id);
}

const PATCH_COLUMNS = {
  name: 'name', region: 'region', host: 'host', port: 'port', tlsMode: 'tls_mode',
  transport: 'transport',
  sni: 'sni', wsPath: 'ws_path', wsHost: 'ws_host', listenAddress: 'listen_address',
  listenPort: 'listen_port', tlsCertPath: 'tls_cert_path', tlsKeyPath: 'tls_key_path',
  realityDest: 'reality_dest', realityServerNames: 'reality_server_names',
  realityPrivateKey: 'reality_private_key', realityPublicKey: 'reality_public_key',
  realityShortIds: 'reality_short_ids', realityFingerprint: 'reality_fingerprint',
  priority: 'priority', enabled: 'enabled', blockPrivateRanges: 'block_private_ranges',
};

export function updateGateway(db, id, patch) {
  const current = getGateway(db, id);
  if (!current) return null;
  // Anything that touches REALITY is recomputed as a set: a transport switched
  // on needs keys it does not have yet, and one switched off must not leave a
  // private key sitting in a row that no longer uses it.
  const touchesReality = ['transport', 'realityDest', 'realityServerNames', 'realityShortIds',
    'realityFingerprint'].some((key) => patch[key] !== undefined);
  const effective = touchesReality
    ? { ...patch, ...realityFields({ transport: current.transport, ...patch }, current) }
    : patch;
  const fields = [];
  const params = [];
  for (const [key, column] of Object.entries(PATCH_COLUMNS)) {
    if (effective[key] === undefined) continue;
    let value = effective[key];
    if (typeof value === 'boolean') value = value ? 1 : 0;
    fields.push(`${column} = ?`);
    params.push(value);
  }
  if (!fields.length) return current;
  params.push(Date.now(), id);
  db.prepare(`UPDATE gateways SET ${fields.join(', ')}, config_version = config_version + 1, updated_at = ? WHERE id = ?`)
    .run(...params);
  return getGateway(db, id);
}

export function deleteGateway(db, id) {
  const gateway = getGateway(db, id);
  if (!gateway) return false;
  db.prepare('DELETE FROM gateways WHERE id = ?').run(id);
  recordEvent(db, {
    type: EVENT.GATEWAY_DELETED, severity: 'warning', targetType: 'gateway', targetId: id,
    message: `Gateway ${gateway.name} removed`,
  });
  return true;
}

/** Bumps every gateway's config version — used when the entitled client set changes. */
export function bumpAllConfigVersions(db, reason) {
  db.prepare('UPDATE gateways SET config_version = config_version + 1, updated_at = ? WHERE enabled = 1')
    .run(Date.now());
  return reason;
}

export function bumpConfigVersion(db, gatewayId) {
  db.prepare('UPDATE gateways SET config_version = config_version + 1, updated_at = ? WHERE id = ?')
    .run(Date.now(), gatewayId);
}

/** Credentials that are currently entitled to traffic, across all subscribers. */
export function entitledCredentials(db, now = Date.now()) {
  return db.prepare(`
    SELECT c.id AS credentialId, c.uuid AS uuid, s.id AS subscriberId
    FROM credentials c
    JOIN subscribers s ON s.id = c.subscriber_id
    WHERE c.state IN ('active','retiring')
      AND s.status = 'active'
      AND s.expires_at > ?
      AND (s.quota_bytes <= 0 OR s.used_bytes < s.quota_bytes)
    ORDER BY c.created_at
  `).all(now);
}

export function assignedEgresses(db, gatewayId) {
  return db.prepare(`
    SELECT e.*, ge.priority AS assign_priority, ge.status AS pair_status,
           ge.latency_ms AS pair_latency_ms, ge.checked_at AS pair_checked_at, ge.detail AS pair_detail
    FROM gateway_egress ge JOIN egresses e ON e.id = ge.egress_id
    WHERE ge.gateway_id = ? ORDER BY ge.priority, e.priority
  `).all(gatewayId);
}

/**
 * The exact Xray configuration a gateway agent should be running right now,
 * plus the version and content hash the agent uses for change detection.
 */
export function buildGatewayConfig(db, gatewayId, now = Date.now()) {
  const gateway = getGateway(db, gatewayId);
  if (!gateway) return null;
  const clients = entitledCredentials(db, now);
  const egresses = assignedEgresses(db, gatewayId);
  // An additional inbound that cannot be rendered — trojan on a gateway whose
  // certificate paths were removed, say — is left out and said out loud. The
  // gateway keeps its own door and every other one that works: a config that
  // throws would leave the agent running yesterday's until somebody noticed.
  const extras = [];
  for (const inbound of activeInbounds(db, gatewayId)) {
    try {
      inboundConfig(gateway, inbound, clients);
      extras.push(inbound);
    } catch (error) {
      recordEvent(db, {
        type: EVENT.GATEWAY_DEGRADED,
        severity: 'warning',
        targetType: 'gateway',
        targetId: gatewayId,
        message: `${gateway.name}: ${inbound.kind} inbound on ${inbound.port} left out — ${error.message}`,
        data: { inboundId: inbound.id, kind: inbound.kind },
      });
    }
  }
  const config = gatewayServerConfig(gateway, clients, egresses, gateway.active_egress_id, extras);
  return {
    gatewayId,
    version: gateway.config_version,
    hash: sha256(stableStringify(config)).slice(0, 16),
    // When only this differs, the agent can apply the change live.
    structureHash: sha256(stableStringify(structuralConfig(config))).slice(0, 16),
    activeEgressId: gateway.active_egress_id,
    clientCount: clients.length,
    egressCount: egresses.length,
    config,
  };
}

/**
 * Egress probe instructions for the agent.
 *
 * Each assigned egress has a dedicated loopback SOCKS inbound in the generated
 * Xray config, pinned by a routing rule to that egress alone. The agent fetches
 * `probeUrl` through that port, which exercises the real data-plane path rather
 * than merely checking that a port is open.
 */
export function egressProbePlan(db, gatewayId) {
  const gateway = getGateway(db, gatewayId);
  const assigned = assignedEgresses(db, gatewayId).filter((e) => e.enabled === 1);
  // Must match the ordering used when the config was generated.
  const active = assigned.find((e) => e.id === gateway?.active_egress_id) || null;
  const ordered = active ? [active, ...assigned.filter((e) => e.id !== active.id)] : assigned;
  return ordered.map((e, index) => ({
    egressId: e.id,
    name: e.name,
    kind: e.kind,
    // Direct dial check for outbound-proxy style egresses.
    host: e.kind === 'direct' ? null : e.host,
    port: e.kind === 'direct' ? null : e.port,
    bindAddress: e.bind_address || null,
    probePort: probePort(index),
    probeUrl: e.probe_url || null,
  }));
}

export function recordDeployment(db, gatewayId, { version, ok, error, agentVersion, xrayVersion, mode }) {
  const now = Date.now();
  const gateway = getGateway(db, gatewayId);
  if (ok) {
    db.prepare(`UPDATE gateways SET deployed_config_version = ?, deployed_at = ?, deploy_error = NULL,
        agent_version = COALESCE(?, agent_version), xray_version = COALESCE(?, xray_version), updated_at = ?
        WHERE id = ?`).run(version, now, agentVersion ?? null, xrayVersion ?? null, now, gatewayId);
    recordEvent(db, {
      type: EVENT.CONFIG_DEPLOYED, targetType: 'gateway', targetId: gatewayId,
      message: `${gateway.name}: config v${version} deployed${mode === 'hot' ? ' (users applied live, no restart)' : ''}`,
      data: { version, mode: mode || 'restart' },
    });
  } else {
    db.prepare('UPDATE gateways SET deploy_error = ?, updated_at = ? WHERE id = ?')
      .run(String(error).slice(0, 500), now, gatewayId);
    recordEvent(db, {
      type: EVENT.CONFIG_REJECTED, severity: 'critical', targetType: 'gateway', targetId: gatewayId,
      message: `${gateway.name}: config v${version} rejected — gateway kept its last known good configuration`,
      data: { version, error: String(error).slice(0, 500) },
    });
  }
}
