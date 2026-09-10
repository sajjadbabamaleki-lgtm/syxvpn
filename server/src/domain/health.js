import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { EVENT, recordEvent } from './events.js';
import { reevaluateGateway } from './routing.js';
import { clientEndpoint, isReality, realityServerNames } from './xray.js';

/**
 * Health is measured at two independent layers, because they fail
 * independently:
 *
 *   ingress — can a client still reach this gateway?  Measured from the
 *             control plane (TCP, then an HTTP/WebSocket upgrade probe).
 *   egress  — can this gateway still reach the internet?  Only the gateway
 *             itself can answer that, so it is reported by the agent.
 *
 * A gateway with `ingress: online` and `egress: offline` is reachable and
 * useless; the UI and the route selector treat those as different states.
 */

export function tcpProbe(host, port, timeoutMs = config.health.tcpTimeoutMs) {
  return new Promise((resolve) => {
    const started = Date.now();
    const socket = net.createConnection({ host, port });
    let settled = false;
    const finish = (status, detail) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ status, latencyMs: status === 'online' ? Date.now() - started : null, detail });
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish('online', 'tcp connect'));
    socket.once('timeout', () => finish('offline', `tcp timeout after ${timeoutMs}ms`));
    socket.once('error', (err) => finish('offline', `tcp error: ${err.code || err.message}`));
  });
}

/**
 * Sends a real WebSocket upgrade request to the gateway's configured path.
 * A live Xray ws inbound answers 101; a reverse proxy in front of a dead
 * backend answers 502/404. This distinguishes "port open" from "service works".
 */
export function wsProbe(gateway, timeoutMs = config.health.probeTimeoutMs) {
  const { host, port, tls } = clientEndpoint(gateway);
  const transport = tls ? https : http;
  const hostHeader = gateway.ws_host || gateway.sni || host;
  return new Promise((resolve) => {
    const started = Date.now();
    const req = transport.request({
      host,
      port,
      path: gateway.ws_path || '/ws',
      method: 'GET',
      servername: tls ? (gateway.sni || hostHeader) : undefined,
      // A self-signed or mismatched certificate is reported, never ignored silently.
      rejectUnauthorized: true,
      headers: {
        Host: hostHeader,
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64'),
        'User-Agent': 'jordan-control-plane/health',
      },
      timeout: timeoutMs,
    });
    let settled = false;
    const finish = (status, detail) => {
      if (settled) return;
      settled = true;
      req.destroy();
      resolve({ status, latencyMs: Date.now() - started, detail });
    };
    req.on('upgrade', () => finish('online', 'websocket upgrade accepted (101)'));
    req.on('response', (res) => finish('degraded', `http ${res.statusCode} — port open, no websocket upgrade`));
    req.on('timeout', () => finish('offline', `probe timeout after ${timeoutMs}ms`));
    req.on('error', (err) => finish('offline', `probe error: ${err.code || err.message}`));
    req.end();
  });
}

/**
 * Probes a REALITY gateway by being exactly what a censor's prober is.
 *
 * A plain TLS client has none of the REALITY authentication in its ClientHello,
 * so the gateway forwards the whole connection to the site it borrows and the
 * certificate that comes back is that site's real one. Verifying it against the
 * name the gateway advertises therefore checks the three things that matter and
 * cannot be checked apart: Xray is listening, the borrowed site is reachable
 * *from the gateway*, and what answers on this port is the gateway rather than
 * something else that moved in.
 *
 * A WebSocket upgrade probe would tell us none of that — there is no HTTP here
 * at all — and a subscriber's own handshake cannot be imitated from outside,
 * because it needs a credential this check has no business holding.
 */
export function realityProbe(gateway, timeoutMs = config.health.probeTimeoutMs) {
  const serverName = realityServerNames(gateway)[0] || gateway.sni || gateway.host;
  return new Promise((resolve) => {
    const started = Date.now();
    const socket = tls.connect({
      host: gateway.host,
      port: gateway.port,
      servername: serverName,
      // The borrowed site's certificate has to be valid for the name the
      // gateway tells clients to claim. If it is not, the disguise is broken
      // and every prober can see it.
      rejectUnauthorized: true,
      timeout: timeoutMs,
    });
    let settled = false;
    const finish = (status, detail) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ status, latencyMs: Date.now() - started, detail });
    };
    socket.once('secureConnect', () => {
      const issuer = socket.getPeerCertificate()?.issuer?.O || 'unknown issuer';
      finish('online', `reality: ${serverName} handshake forwarded and verified (${issuer})`);
    });
    socket.once('timeout', () => finish('offline', `reality probe timeout after ${timeoutMs}ms`));
    socket.once('error', (err) => {
      const code = err.code || err.message;
      // A handshake that completes but does not verify means something is
      // listening that is not the borrowed site: the port is open and the
      // cover is wrong, which is worse than being down.
      const broken = typeof code === 'string' && (code.includes('CERT') || code.includes('ALT_NAME'));
      finish(broken ? 'degraded' : 'offline', `reality probe: ${code}`);
    });
  });
}

function recordCheck(db, row) {
  db.prepare(`INSERT INTO health_checks
      (target_type,target_id,gateway_id,check_kind,status,latency_ms,detail,source,created_at)
      VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(row.targetType, row.targetId, row.gatewayId ?? null, row.checkKind, row.status,
      row.latencyMs ?? null, row.detail ?? null, row.source, Date.now());
}

/** Runs the ingress probes for one gateway and applies the result. */
export async function checkGatewayIngress(db, gateway) {
  const tcp = await tcpProbe(gateway.host, gateway.port);
  let result = tcp;
  let kind = 'tcp';
  if (tcp.status === 'online') {
    const deeper = isReality(gateway) ? await realityProbe(gateway) : await wsProbe(gateway);
    // TCP succeeded, so the host is reachable; the deeper result refines it.
    result = deeper.status === 'offline'
      ? { status: 'degraded', latencyMs: tcp.latencyMs, detail: `tcp ok, ${deeper.detail}` }
      : deeper;
    kind = isReality(gateway) ? 'tls' : 'http';
  }
  return applyIngressResult(db, gateway, { ...result, checkKind: kind });
}

export function applyIngressResult(db, gateway, result) {
  const now = Date.now();
  const previous = gateway.ingress_status;
  let failCount = gateway.ingress_fail_count;
  let next = result.status;

  if (result.status === 'offline') {
    failCount += 1;
    // A single failed probe is not an outage; only sustained failure is.
    if (failCount < config.health.failureThreshold) next = previous === 'online' ? 'degraded' : previous;
  } else {
    failCount = 0;
  }

  db.prepare(`UPDATE gateways SET ingress_status=?, ingress_latency_ms=?, ingress_checked_at=?,
      ingress_fail_count=?, ingress_detail=?, updated_at=? WHERE id=?`)
    .run(next, result.latencyMs ?? null, now, failCount, result.detail ?? null, now, gateway.id);

  recordCheck(db, {
    targetType: 'gateway', targetId: gateway.id, checkKind: result.checkKind || 'tcp',
    status: result.status, latencyMs: result.latencyMs, detail: result.detail, source: 'control-plane',
  });

  if (next !== previous) {
    const type = next === 'online' ? EVENT.GATEWAY_ONLINE
      : next === 'offline' ? EVENT.GATEWAY_OFFLINE : EVENT.GATEWAY_DEGRADED;
    recordEvent(db, {
      type,
      severity: next === 'offline' ? 'critical' : next === 'degraded' ? 'warning' : 'info',
      targetType: 'gateway', targetId: gateway.id,
      message: `${gateway.name} ingress ${previous} → ${next}: ${result.detail || ''}`.trim(),
      data: { latencyMs: result.latencyMs },
    });
  }
  return { status: next, latencyMs: result.latencyMs ?? null, detail: result.detail ?? null };
}

/**
 * Applies egress health reported by a gateway agent. Results are stored per
 * (gateway, egress) pair, then rolled up into the egress-wide status.
 */
export function applyAgentEgressHealth(db, gatewayId, results) {
  const now = Date.now();
  const gateway = db.prepare('SELECT * FROM gateways WHERE id = ?').get(gatewayId);
  const applied = [];
  for (const r of results) {
    const pair = db.prepare('SELECT * FROM gateway_egress WHERE gateway_id=? AND egress_id=?')
      .get(gatewayId, r.egressId);
    if (!pair) continue;
    const previous = pair.status;
    const failCount = r.status === 'offline' ? pair.fail_count + 1 : 0;
    const next = r.status === 'offline' && failCount < config.health.failureThreshold && previous === 'online'
      ? 'degraded'
      : r.status;
    db.prepare(`UPDATE gateway_egress SET status=?, latency_ms=?, checked_at=?, fail_count=?, detail=?
        WHERE gateway_id=? AND egress_id=?`)
      .run(next, r.latencyMs ?? null, now, failCount, (r.detail || '').slice(0, 300), gatewayId, r.egressId);
    recordCheck(db, {
      targetType: 'egress', targetId: r.egressId, gatewayId, checkKind: 'e2e',
      status: r.status, latencyMs: r.latencyMs, detail: r.detail, source: 'agent',
    });
    if (next !== previous) {
      const egress = db.prepare('SELECT name FROM egresses WHERE id=?').get(r.egressId);
      recordEvent(db, {
        type: next === 'online' ? EVENT.EGRESS_ONLINE : EVENT.EGRESS_UNAVAILABLE,
        severity: next === 'online' ? 'info' : 'critical',
        targetType: 'egress', targetId: r.egressId,
        message: `Egress ${egress?.name || r.egressId} via ${gateway?.name || gatewayId}: ${previous} → ${next}${r.detail ? ` (${r.detail})` : ''}`,
        data: { gatewayId, latencyMs: r.latencyMs },
      });
    }
    rollUpEgressStatus(db, r.egressId, now);
    applied.push({ egressId: r.egressId, status: next });
  }
  const routing = reevaluateGateway(db, gatewayId, 'agent-health');
  return { applied, routing };
}

/** Egress-wide status: online if any gateway can currently use it. */
export function rollUpEgressStatus(db, egressId, now = Date.now()) {
  const pairs = db.prepare('SELECT status, latency_ms FROM gateway_egress WHERE egress_id = ?').all(egressId);
  let status = 'unknown';
  if (pairs.some((p) => p.status === 'online')) status = 'online';
  else if (pairs.some((p) => p.status === 'degraded')) status = 'degraded';
  else if (pairs.length && pairs.every((p) => p.status === 'offline')) status = 'offline';
  const latencies = pairs.map((p) => p.latency_ms).filter((v) => typeof v === 'number');
  db.prepare('UPDATE egresses SET status=?, latency_ms=?, checked_at=?, checked_by=?, updated_at=? WHERE id=?')
    .run(status, latencies.length ? Math.min(...latencies) : null, now, 'agent', now, egressId);
  return status;
}

/**
 * Marks agents that stopped reporting, and expires egress health that is too
 * old to trust. Stale egress health becomes `unknown`, never silently `online`.
 */
export function sweepStaleReports(db, now = Date.now()) {
  const agentCutoff = now - config.health.agentStaleSeconds * 1000;
  const stale = db.prepare(
    "SELECT id, name FROM gateways WHERE agent_status='online' AND (agent_last_seen_at IS NULL OR agent_last_seen_at < ?)",
  ).all(agentCutoff);
  for (const g of stale) {
    db.prepare("UPDATE gateways SET agent_status='stale', updated_at=? WHERE id=?").run(now, g.id);
    recordEvent(db, {
      type: EVENT.AGENT_HEARTBEAT_MISSED, severity: 'warning', targetType: 'gateway', targetId: g.id,
      message: `${g.name}: agent heartbeat missed (>${config.health.agentStaleSeconds}s)`,
    });
  }

  const egressCutoff = now - config.health.egressStaleSeconds * 1000;
  const expired = db.prepare(
    "SELECT gateway_id, egress_id FROM gateway_egress WHERE status != 'unknown' AND (checked_at IS NULL OR checked_at < ?)",
  ).all(egressCutoff);
  for (const pair of expired) {
    db.prepare("UPDATE gateway_egress SET status='unknown', detail='health report stale' WHERE gateway_id=? AND egress_id=?")
      .run(pair.gateway_id, pair.egress_id);
    rollUpEgressStatus(db, pair.egress_id, now);
  }
  return { staleAgents: stale.length, staleEgressPairs: expired.length };
}

export function recentChecks(db, targetType, targetId, limit = 20) {
  return db.prepare(
    'SELECT * FROM health_checks WHERE target_type=? AND target_id=? ORDER BY id DESC LIMIT ?',
  ).all(targetType, targetId, Math.min(limit, 100));
}
