import { newId } from '../lib/crypto.js';
import { EVENT, recordEvent } from './events.js';
import { gatewayServerConfig, stableStringify, probePort } from './xray.js';
import { sha256 } from '../lib/crypto.js';

export function listGateways(db) {
  return db.prepare('SELECT * FROM gateways ORDER BY priority, name').all();
}

export function getGateway(db, id) {
  return db.prepare('SELECT * FROM gateways WHERE id = ?').get(id) || null;
}

export function createGateway(db, input) {
  const now = Date.now();
  const id = newId('gw');
  db.prepare(`INSERT INTO gateways
      (id,name,region,host,port,tls_mode,sni,ws_path,ws_host,listen_address,listen_port,
       tls_cert_path,tls_key_path,priority,enabled,block_private_ranges,created_at,updated_at)
      VALUES (@id,@name,@region,@host,@port,@tlsMode,@sni,@wsPath,@wsHost,@listenAddress,@listenPort,
              @tlsCertPath,@tlsKeyPath,@priority,@enabled,@blockPrivateRanges,@now,@now)`)
    .run({
      id,
      name: input.name,
      region: input.region,
      host: input.host,
      port: input.port,
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
  sni: 'sni', wsPath: 'ws_path', wsHost: 'ws_host', listenAddress: 'listen_address',
  listenPort: 'listen_port', tlsCertPath: 'tls_cert_path', tlsKeyPath: 'tls_key_path',
  priority: 'priority', enabled: 'enabled', blockPrivateRanges: 'block_private_ranges',
};

export function updateGateway(db, id, patch) {
  const current = getGateway(db, id);
  if (!current) return null;
  const fields = [];
  const params = [];
  for (const [key, column] of Object.entries(PATCH_COLUMNS)) {
    if (patch[key] === undefined) continue;
    let value = patch[key];
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
  const config = gatewayServerConfig(gateway, clients, egresses, gateway.active_egress_id);
  return {
    gatewayId,
    version: gateway.config_version,
    hash: sha256(stableStringify(config)).slice(0, 16),
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

export function recordDeployment(db, gatewayId, { version, ok, error, agentVersion, xrayVersion }) {
  const now = Date.now();
  const gateway = getGateway(db, gatewayId);
  if (ok) {
    db.prepare(`UPDATE gateways SET deployed_config_version = ?, deployed_at = ?, deploy_error = NULL,
        agent_version = COALESCE(?, agent_version), xray_version = COALESCE(?, xray_version), updated_at = ?
        WHERE id = ?`).run(version, now, agentVersion ?? null, xrayVersion ?? null, now, gatewayId);
    recordEvent(db, {
      type: EVENT.CONFIG_DEPLOYED, targetType: 'gateway', targetId: gatewayId,
      message: `${gateway.name}: config v${version} deployed`,
      data: { version },
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
