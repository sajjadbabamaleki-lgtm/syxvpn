import { Router } from 'express';
import { z } from 'zod';
import { validate, hostField, portField, nameField, regionField, wsPathField } from '../lib/validate.js';
import { ok, created } from '../lib/respond.js';
import { notFound, badRequest } from '../lib/errors.js';
import {
  listGateways, getGateway, createGateway, updateGateway, deleteGateway,
  buildGatewayConfig, assignedEgresses,
} from '../domain/gateways.js';
import { assignEgress, unassignEgress } from '../domain/egresses.js';
import { checkGatewayIngress, recentChecks } from '../domain/health.js';
import { issueAgentKey } from '../auth/agent.js';
import { EVENT, recordEvent } from '../domain/events.js';
import { gatewayView, egressView, healthCheckView, routeSwitchView } from './serialize.js';
import { lastSwitch, reevaluateGateway } from '../domain/routing.js';

const tlsModes = ['none', 'reverse-proxy', 'xray'];

const baseGateway = {
  name: nameField,
  region: regionField,
  host: hostField,
  port: portField,
  tlsMode: z.enum(tlsModes).default('none'),
  sni: hostField.nullish(),
  wsPath: wsPathField.default('/ws'),
  wsHost: hostField.nullish(),
  listenAddress: z.string().trim().max(64).nullish(),
  listenPort: portField.nullish(),
  tlsCertPath: z.string().trim().max(512).nullish(),
  tlsKeyPath: z.string().trim().max(512).nullish(),
  priority: z.coerce.number().int().min(1).max(1000).default(100),
  enabled: z.boolean().default(true),
  blockPrivateRanges: z.boolean().default(true),
};

/**
 * TLS configuration must be operationally real — a gateway may only advertise TLS
 * to clients if something is actually terminating it.
 */
function checkTlsConsistency(value, ctx) {
  if (value.tlsMode === 'xray' && (!value.tlsCertPath || !value.tlsKeyPath)) {
    ctx.addIssue({
      code: 'custom',
      path: ['tlsCertPath'],
      message: 'tlsMode "xray" requires tlsCertPath and tlsKeyPath so Xray can actually serve TLS',
    });
  }
  if (value.tlsMode === 'reverse-proxy' && !value.listenPort) {
    ctx.addIssue({
      code: 'custom',
      path: ['listenPort'],
      message: 'tlsMode "reverse-proxy" requires listenPort (the loopback port Xray binds behind the proxy)',
    });
  }
}

const createSchema = z.object(baseGateway).superRefine(checkTlsConsistency);
const patchSchema = z.object(baseGateway).partial().superRefine((value, ctx) => {
  if (value.tlsMode) checkTlsConsistency({ ...value }, ctx);
});

const assignSchema = z.object({
  egressId: z.string().trim().min(3).max(64),
  priority: z.coerce.number().int().min(1).max(1000).default(100),
});

export function adminGatewayRoutes({ db }) {
  const router = Router();

  router.get('/', (_req, res) => {
    const rows = listGateways(db);
    const data = rows.map((g) => gatewayView(g, {
      egressCount: db.prepare('SELECT count(*) AS n FROM gateway_egress WHERE gateway_id=?').get(g.id).n,
    }));
    return ok(res, data);
  });

  router.post('/', validate(createSchema), (req, res) => {
    const gateway = createGateway(db, req.body);
    const agentKey = issueAgentKey(db, gateway.id);
    // The agent key is returned exactly once, at registration.
    return created(res, { ...gatewayView(getGateway(db, gateway.id)), agentKey });
  });

  router.get('/:id', (req, res, next) => {
    const gateway = getGateway(db, req.params.id);
    if (!gateway) return next(notFound('Gateway'));
    const egresses = assignedEgresses(db, gateway.id).map((e) => egressView(e, {
      assignedPriority: e.assign_priority,
      pairStatus: e.pair_status,
      pairLatencyMs: e.pair_latency_ms,
      pairDetail: e.pair_detail,
      active: e.id === gateway.active_egress_id,
    }));
    return ok(res, gatewayView(gateway, {
      egresses,
      recentChecks: recentChecks(db, 'gateway', gateway.id, 20).map(healthCheckView),
      lastSwitch: routeSwitchView(lastSwitch(db, gateway.id)),
    }));
  });

  router.patch('/:id', validate(patchSchema), (req, res, next) => {
    const gateway = updateGateway(db, req.params.id, req.body);
    if (!gateway) return next(notFound('Gateway'));
    return ok(res, gatewayView(gateway));
  });

  router.delete('/:id', (req, res, next) => {
    if (!deleteGateway(db, req.params.id)) return next(notFound('Gateway'));
    return ok(res, { deleted: true });
  });

  router.post('/:id/check', async (req, res, next) => {
    const gateway = getGateway(db, req.params.id);
    if (!gateway) return next(notFound('Gateway'));
    try {
      const result = await checkGatewayIngress(db, gateway);
      reevaluateGateway(db, gateway.id, 'manual-check');
      return ok(res, { gatewayId: gateway.id, ingress: result });
    } catch (err) {
      return next(err);
    }
  });

  router.post('/:id/agent-key', (req, res, next) => {
    const gateway = getGateway(db, req.params.id);
    if (!gateway) return next(notFound('Gateway'));
    const agentKey = issueAgentKey(db, gateway.id);
    recordEvent(db, {
      type: EVENT.AGENT_KEY_ROTATED, severity: 'warning', targetType: 'gateway', targetId: gateway.id,
      message: `${gateway.name}: agent key rotated — the previous key stops working immediately`,
    });
    return ok(res, { gatewayId: gateway.id, agentKey });
  });

  // Preview of exactly what the agent will fetch. Egress credentials are
  // included here because this endpoint is admin-only.
  router.get('/:id/xray-config', (req, res, next) => {
    const built = buildGatewayConfig(db, req.params.id);
    if (!built) return next(notFound('Gateway'));
    return ok(res, built);
  });

  router.post('/:id/egresses', validate(assignSchema), (req, res, next) => {
    const gateway = getGateway(db, req.params.id);
    if (!gateway) return next(notFound('Gateway'));
    const egress = db.prepare('SELECT id FROM egresses WHERE id=?').get(req.body.egressId);
    if (!egress) return next(badRequest('Unknown egress id'));
    const routing = assignEgress(db, gateway.id, req.body.egressId, req.body.priority);
    return ok(res, { assigned: true, routing });
  });

  router.delete('/:id/egresses/:egressId', (req, res, next) => {
    if (!getGateway(db, req.params.id)) return next(notFound('Gateway'));
    if (!unassignEgress(db, req.params.id, req.params.egressId)) return next(notFound('Assignment'));
    return ok(res, { removed: true });
  });

  return router;
}
