import { Router } from 'express';
import { ok } from '../lib/respond.js';
import { listGateways } from '../domain/gateways.js';
import { candidatesFor, routeState, lastSwitch, reevaluateAll } from '../domain/routing.js';
import { entitlement } from '../domain/subscribers.js';
import { listEvents } from '../domain/events.js';
import { totalUsage } from '../domain/usage.js';
import { egressView, routeSwitchView, iso } from './serialize.js';
import { VERSION } from './meta.js';

/** Per-gateway route table: ingress, the selected egress, and why. */
export function buildRoutes(db) {
  return listGateways(db).map((g) => {
    const candidates = candidatesFor(db, g.id);
    const active = candidates.find((c) => c.id === g.active_egress_id) || null;
    const backups = candidates
      .filter((c) => c.id !== g.active_egress_id)
      .map((c) => egressView(c, {
        assignedPriority: c.assign_priority,
        pairStatus: c.pair_status,
        pairLatencyMs: c.pair_latency_ms,
        pairCheckedAt: iso(c.pair_checked_at),
      }));
    return {
      gatewayId: g.id,
      gatewayName: g.name,
      region: g.region,
      enabled: g.enabled === 1,
      state: routeState(g, active),
      ingress: {
        status: g.ingress_status,
        latencyMs: g.ingress_latency_ms,
        checkedAt: iso(g.ingress_checked_at),
        detail: g.ingress_detail,
      },
      egress: active
        ? egressView(active, {
          assignedPriority: active.assign_priority,
          pairStatus: active.pair_status,
          pairLatencyMs: active.pair_latency_ms,
          pairCheckedAt: iso(active.pair_checked_at),
          pairDetail: active.pair_detail,
        })
        : null,
      backups,
      activeSince: iso(g.active_egress_since),
      selectionReason: g.active_egress_reason,
      lastSwitch: routeSwitchView(lastSwitch(db, g.id)),
      configInSync: g.deployed_config_version === g.config_version,
      agentStatus: g.agent_status,
    };
  });
}

function networkState(routes) {
  const enabled = routes.filter((r) => r.enabled);
  if (!enabled.length) return 'unconfigured';
  const healthy = enabled.filter((r) => r.state === 'healthy').length;
  if (healthy === enabled.length) return 'healthy';
  if (healthy > 0) return 'degraded';
  const usable = enabled.filter((r) => r.state === 'degraded' || r.state === 'unverified').length;
  return usable > 0 ? 'degraded' : 'down';
}

export function adminNetworkRoutes({ db, startedAt }) {
  const router = Router();

  router.get('/routes', (_req, res) => {
    const routes = buildRoutes(db);
    return ok(res, routes, { state: networkState(routes) });
  });

  router.post('/routes/reevaluate', (_req, res) => {
    const changes = reevaluateAll(db, 'manual');
    return ok(res, { changes });
  });

  router.get('/overview', (_req, res) => {
    const now = Date.now();
    const gateways = listGateways(db);
    const routes = buildRoutes(db);
    const subscribers = db.prepare('SELECT * FROM subscribers').all();
    const egresses = db.prepare('SELECT * FROM egresses').all();

    const count = (rows, fn) => rows.filter(fn).length;
    const subStates = subscribers.map((s) => entitlement(s, now).reason);

    return ok(res, {
      controlPlane: {
        version: VERSION,
        uptimeSeconds: Math.round((now - startedAt) / 1000),
        time: new Date(now).toISOString(),
      },
      state: networkState(routes),
      gateways: {
        total: gateways.length,
        enabled: count(gateways, (g) => g.enabled === 1),
        online: count(gateways, (g) => g.ingress_status === 'online'),
        degraded: count(gateways, (g) => g.ingress_status === 'degraded'),
        offline: count(gateways, (g) => g.ingress_status === 'offline'),
        unknown: count(gateways, (g) => g.ingress_status === 'unknown'),
        agentsOnline: count(gateways, (g) => g.agent_status === 'online'),
        configOutOfSync: count(gateways, (g) => g.deployed_config_version !== g.config_version),
      },
      egress: {
        total: egresses.length,
        enabled: count(egresses, (e) => e.enabled === 1),
        online: count(egresses, (e) => e.status === 'online'),
        offline: count(egresses, (e) => e.status === 'offline'),
        unknown: count(egresses, (e) => e.status === 'unknown'),
      },
      routes: {
        total: routes.length,
        healthy: count(routes, (r) => r.state === 'healthy'),
        degraded: count(routes, (r) => r.state === 'degraded'),
        unverified: count(routes, (r) => r.state === 'unverified'),
        ingressDown: count(routes, (r) => r.state === 'ingress-down'),
        egressDown: count(routes, (r) => r.state === 'egress-down'),
        noEgress: count(routes, (r) => r.state === 'no-egress'),
      },
      subscribers: {
        total: subscribers.length,
        active: count(subStates, (s) => s === 'active'),
        expired: count(subStates, (s) => s === 'expired'),
        disabled: count(subStates, (s) => s === 'disabled'),
        quotaExhausted: count(subStates, (s) => s === 'quota-exhausted'),
      },
      usage: {
        last24hBytes: totalUsage(db, now - 86400000),
        last7dBytes: totalUsage(db, now - 7 * 86400000),
        // Usage is only ever counted from authenticated gateway reports.
        measured: db.prepare('SELECT count(*) AS n FROM usage_reports').get().n > 0,
      },
      alerts: listEvents(db, { limit: 8 }).filter((e) => e.severity !== 'info'),
      activeRoute: routes.find((r) => r.state === 'healthy')
        || routes.find((r) => r.state === 'degraded')
        || routes[0] || null,
    });
  });

  return router;
}
