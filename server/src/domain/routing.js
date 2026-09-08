import { EVENT, recordEvent } from './events.js';

/**
 * Deterministic egress selection with hysteresis.
 *
 * Ranking key, best first:
 *   1. pair health   (online < degraded < unknown; offline is excluded)
 *   2. assignment priority (lower wins)
 *   3. egress priority (lower wins)
 *   4. weight (higher wins)
 *   5. measured latency (lower wins, unmeasured last)
 *   6. egress id (stable tie-break)
 *
 * The currently active egress is retained unless a *strictly better* candidate
 * exists, so equal-ranked paths never flap.
 */
const STATUS_RANK = { online: 0, degraded: 1, unknown: 2 };

export function candidatesFor(db, gatewayId) {
  return db.prepare(`
    SELECT e.*, ge.priority AS assign_priority, ge.status AS pair_status,
           ge.latency_ms AS pair_latency_ms, ge.checked_at AS pair_checked_at,
           ge.fail_count AS pair_fail_count, ge.detail AS pair_detail
    FROM gateway_egress ge
    JOIN egresses e ON e.id = ge.egress_id
    WHERE ge.gateway_id = ?
    ORDER BY ge.priority, e.priority, e.name
  `).all(gatewayId);
}

export function rankKey(c) {
  return [
    STATUS_RANK[c.pair_status] ?? 3,
    c.assign_priority ?? 100,
    c.priority ?? 100,
    -(c.weight ?? 1),
    c.pair_latency_ms == null ? Number.MAX_SAFE_INTEGER : c.pair_latency_ms,
    c.id,
  ];
}

function compare(a, b) {
  const ka = rankKey(a);
  const kb = rankKey(b);
  for (let i = 0; i < ka.length; i += 1) {
    if (ka[i] < kb[i]) return -1;
    if (ka[i] > kb[i]) return 1;
  }
  return 0;
}

export function selectEgress(db, gatewayId, currentId) {
  const all = candidatesFor(db, gatewayId);
  const eligible = all.filter((c) => c.enabled === 1 && c.pair_status !== 'offline');
  const previous = all.find((c) => c.id === currentId) || null;
  if (!eligible.length) {
    return {
      egress: null,
      reason: previous ? `all paths unusable (${previous.name}: ${previous.pair_status})` : 'no-eligible-egress',
    };
  }
  const best = [...eligible].sort(compare)[0];
  const current = eligible.find((c) => c.id === currentId);
  if (current && compare(current, best) <= 0) {
    return { egress: current, reason: 'retained' };
  }
  let reason;
  if (!previous) reason = 'initial-selection';
  else if (!current) reason = `previous path unusable (${previous.name}: ${previous.pair_status})`;
  else reason = `better path available (${current.pair_status} -> ${best.pair_status})`;
  return { egress: best, reason };
}

/**
 * Re-evaluates one gateway's active egress. Any change bumps config_version so
 * the gateway agent picks up a new data-plane configuration on its next poll —
 * this is what makes failover real rather than cosmetic.
 */
export function reevaluateGateway(db, gatewayId, trigger = 'health-change') {
  const gateway = db.prepare('SELECT * FROM gateways WHERE id = ?').get(gatewayId);
  if (!gateway) return null;
  const { egress, reason } = selectEgress(db, gatewayId, gateway.active_egress_id);
  const nextId = egress?.id ?? null;
  if (nextId === gateway.active_egress_id) return { changed: false, activeEgressId: nextId };

  const now = Date.now();
  db.prepare(`UPDATE gateways
      SET active_egress_id = ?, active_egress_since = ?, active_egress_reason = ?,
          config_version = config_version + 1, updated_at = ?
      WHERE id = ?`)
    .run(nextId, now, `${trigger}: ${reason}`, now, gatewayId);
  db.prepare('INSERT INTO route_switches (gateway_id, from_egress_id, to_egress_id, reason, created_at) VALUES (?,?,?,?,?)')
    .run(gatewayId, gateway.active_egress_id, nextId, `${trigger}: ${reason}`, now);

  const nameOf = (id) => (id
    ? db.prepare('SELECT name FROM egresses WHERE id = ?').get(id)?.name || id
    : 'none');

  if (nextId) {
    recordEvent(db, {
      type: EVENT.ROUTE_SWITCHED,
      severity: gateway.active_egress_id ? 'warning' : 'info',
      targetType: 'gateway',
      targetId: gatewayId,
      message: `${gateway.name}: egress ${nameOf(gateway.active_egress_id)} -> ${nameOf(nextId)} (${reason})`,
      data: { from: gateway.active_egress_id, to: nextId, reason, trigger },
    });
  } else {
    recordEvent(db, {
      type: EVENT.ROUTE_UNAVAILABLE,
      severity: 'critical',
      targetType: 'gateway',
      targetId: gatewayId,
      message: `${gateway.name}: no usable egress path (was ${nameOf(gateway.active_egress_id)}) — traffic fails closed`,
      data: { from: gateway.active_egress_id, trigger },
    });
  }
  return { changed: true, from: gateway.active_egress_id, activeEgressId: nextId, reason };
}

export function reevaluateAll(db, trigger = 'periodic') {
  const ids = db.prepare('SELECT id FROM gateways').all().map((r) => r.id);
  return ids.map((id) => ({ gatewayId: id, ...reevaluateGateway(db, id, trigger) })).filter((r) => r.changed);
}

/**
 * Route state as an operator reads it: reaching the gateway and reaching the
 * internet from that gateway are two different failures.
 */
export function routeState(gateway, activePair) {
  if (gateway.enabled === 0) return 'disabled';
  if (gateway.ingress_status === 'offline') return 'ingress-down';
  if (!activePair) return 'no-egress';
  if (activePair.pair_status === 'offline') return 'egress-down';
  if (gateway.ingress_status === 'unknown' || activePair.pair_status === 'unknown') return 'unverified';
  if (gateway.ingress_status === 'degraded' || activePair.pair_status === 'degraded') return 'degraded';
  return 'healthy';
}

export function lastSwitch(db, gatewayId) {
  return db.prepare('SELECT * FROM route_switches WHERE gateway_id = ? ORDER BY id DESC LIMIT 1').get(gatewayId) || null;
}
