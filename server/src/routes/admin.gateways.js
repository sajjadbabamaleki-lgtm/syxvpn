import { Router } from 'express';
import { z } from 'zod';
import { validate, hostField, portField, nameField, regionField, wsPathField } from '../lib/validate.js';
import { ok, created } from '../lib/respond.js';
import { notFound, badRequest } from '../lib/errors.js';
import {
  listGateways, getGateway, createGateway, updateGateway, deleteGateway,
  buildGatewayConfig, assignedEgresses, bumpConfigVersion,
} from '../domain/gateways.js';
import { assignEgress, unassignEgress } from '../domain/egresses.js';
import { checkGatewayIngress, recentChecks } from '../domain/health.js';
import {
  KINDS, listInbounds, createInbound, updateInbound, deleteInbound, getInbound,
  checkGatewayInbounds, inboundConfig,
} from '../domain/inbounds.js';
import { issueAgentKey } from '../auth/agent.js';
import { EVENT, recordEvent } from '../domain/events.js';
import { gatewayView, egressView, healthCheckView, routeSwitchView } from './serialize.js';
import { lastSwitch, reevaluateGateway } from '../domain/routing.js';
import { parseDest, SHORT_ID_SHAPE } from '../lib/reality.js';

const tlsModes = ['none', 'reverse-proxy', 'xray'];

/**
 * An additional inbound. Only the shape is described here; whether the gateway
 * can actually run it is answered by rendering it (see the POST below), which
 * is the only check that knows about certificate material.
 */
const inboundSchema = z.object({
  kind: z.enum(KINDS),
  port: portField,
  listenAddress: z.string().trim().max(64).nullish(),
  enabled: z.boolean().optional(),
  realityDest: z.string().trim().max(255).nullish(),
  realityServerNames: z.array(hostField).max(8).nullish(),
  realityShortIds: z.array(z.string().trim().toLowerCase()).max(8).nullish(),
  realityFingerprint: z.enum(['chrome', 'firefox', 'safari', 'edge', 'ios', 'android', 'random']).nullish(),
});

const inboundPatchSchema = z.object({
  enabled: z.boolean().optional(),
  port: portField.optional(),
});

/**
 * What an operator is shown about an inbound.
 *
 * No key material: the Shadowsocks server key and the REALITY private key stay
 * in the database and in the gateway's own configuration. A subscriber's key is
 * not here either, because it is not stored anywhere — it is derived when a
 * profile is written.
 */
const inboundView = (row) => ({
  id: row.id,
  gatewayId: row.gateway_id,
  kind: row.kind,
  port: row.port,
  enabled: row.enabled === 1,
  status: row.status,
  latencyMs: row.latency_ms,
  checkedAt: row.checked_at,
  detail: row.detail,
  realityDest: row.reality_dest,
  realityServerNames: row.reality_server_names,
  realityPublicKey: row.reality_public_key,
  createdAt: row.created_at,
});

const baseGateway = {
  name: nameField,
  region: regionField,
  host: hostField,
  port: portField,
  transport: z.enum(['ws', 'reality', 'xhttp']).optional(),
  tlsMode: z.enum(tlsModes).optional(),
  // REALITY. The key pair and short IDs are issued by the control plane when
  // they are absent, which is the normal case: an operator supplies the
  // borrowed site and nothing else.
  realityDest: z.string().trim().max(255).nullish(),
  realityServerNames: z.array(hostField).max(8).nullish(),
  realityShortIds: z.array(z.string().trim().toLowerCase()).max(8).nullish(),
  realityFingerprint: z.enum(['chrome', 'firefox', 'safari', 'edge', 'ios', 'android', 'random']).nullish(),
  sni: hostField.nullish(),
  wsPath: wsPathField.optional(),
  wsHost: hostField.nullish(),
  listenAddress: z.string().trim().max(64).nullish(),
  listenPort: portField.nullish(),
  tlsCertPath: z.string().trim().max(512).nullish(),
  tlsKeyPath: z.string().trim().max(512).nullish(),
  priority: z.coerce.number().int().min(1).max(1000).optional(),
  enabled: z.boolean().optional(),
  blockPrivateRanges: z.boolean().optional(),
};

/**
 * Defaults live in the domain layer, not in this shape, and that is deliberate.
 * `.partial()` does not strip a `.default()` — a PATCH carrying only a port
 * arrives with every defaulted field filled in, so changing a gateway's port
 * would quietly reset its TLS mode to "none" and take its transport with it.
 */

/**
 * TLS configuration must be operationally real — a gateway may only advertise TLS
 * to clients if something is actually terminating it.
 */
/**
 * REALITY has to be operationally real too, and it fails in a way TLS does not:
 * a misconfigured certificate refuses connections, while a REALITY gateway
 * pointed at a site that does not fit quietly hands every prober a mismatch and
 * gets the address burned.
 */
function checkRealityConsistency(value, ctx) {
  if (value.transport !== 'reality') return;
  if (!parseDest(value.realityDest)) {
    ctx.addIssue({
      code: 'custom',
      path: ['realityDest'],
      message: 'transport "reality" requires realityDest as host:port — the site whose TLS handshake is borrowed, e.g. www.microsoft.com:443',
    });
  }
  if (value.tlsMode && value.tlsMode !== 'none') {
    ctx.addIssue({
      code: 'custom',
      path: ['tlsMode'],
      message: 'a REALITY gateway terminates its own connection: nothing may sit in front of it, so tlsMode must be "none"',
    });
  }
  for (const id of value.realityShortIds || []) {
    // An empty short ID admits any client holding the public key. Xray allows
    // it; this does not, because it is indistinguishable from a typo.
    if (!SHORT_ID_SHAPE.test(id)) {
      ctx.addIssue({
        code: 'custom',
        path: ['realityShortIds'],
        message: `short ID "${id}" must be 2 to 16 hexadecimal characters`,
      });
    }
  }
}

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

const createSchema = z.object(baseGateway).superRefine((value, ctx) => {
  checkTlsConsistency(value, ctx);
  checkRealityConsistency(value, ctx);
});
const patchSchema = z.object(baseGateway).partial().superRefine((value, ctx) => {
  if (value.tlsMode) checkTlsConsistency({ ...value }, ctx);
  // Only when the patch is turning REALITY on: the fields it needs are then in
  // the patch itself, and a patch that leaves the transport alone is not
  // changing any of this.
  if (value.transport === 'reality') checkRealityConsistency(value, ctx);
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

  // Additional inbounds: other protocols into the same gateway. Secrets are
  // derived per subscriber and never stored, so nothing here returns one.
  router.get('/:id/inbounds', (req, res, next) => {
    if (!getGateway(db, req.params.id)) return next(notFound('Gateway'));
    return ok(res, listInbounds(db, req.params.id).map(inboundView));
  });

  router.post('/:id/inbounds', validate(inboundSchema), (req, res, next) => {
    const gateway = getGateway(db, req.params.id);
    if (!gateway) return next(notFound('Gateway'));
    if (req.body.port === gateway.port) return next(badRequest('That port is the gateway\'s own inbound'));
    const taken = db.prepare('SELECT id FROM gateway_inbounds WHERE gateway_id=? AND port=?')
      .get(gateway.id, req.body.port);
    if (taken) return next(badRequest('An inbound already uses that port on this gateway'));

    const inbound = createInbound(db, gateway.id, req.body);
    // Rendered once, here, where an operator is waiting for the answer: an
    // inbound the gateway cannot run is a mistake to report now rather than a
    // deployment that quietly leaves it out later.
    try {
      inboundConfig(gateway, inbound, []);
    } catch (error) {
      deleteInbound(db, inbound.id);
      return next(badRequest(error.message));
    }
    bumpConfigVersion(db, gateway.id);
    recordEvent(db, {
      type: EVENT.GATEWAY_INBOUND_ADDED,
      severity: 'info',
      targetType: 'gateway',
      targetId: gateway.id,
      message: `${gateway.name}: ${inbound.kind} inbound added on ${inbound.port}`,
      data: { inboundId: inbound.id, kind: inbound.kind, port: inbound.port },
    });
    return created(res, inboundView(inbound));
  });

  router.patch('/:id/inbounds/:inboundId', validate(inboundPatchSchema), (req, res, next) => {
    const gateway = getGateway(db, req.params.id);
    if (!gateway) return next(notFound('Gateway'));
    const existing = getInbound(db, req.params.inboundId);
    if (!existing || existing.gateway_id !== gateway.id) return next(notFound('Inbound'));
    const updated = updateInbound(db, existing.id, req.body);
    bumpConfigVersion(db, gateway.id);
    return ok(res, inboundView(updated));
  });

  router.delete('/:id/inbounds/:inboundId', (req, res, next) => {
    const gateway = getGateway(db, req.params.id);
    if (!gateway) return next(notFound('Gateway'));
    const existing = getInbound(db, req.params.inboundId);
    if (!existing || existing.gateway_id !== gateway.id) return next(notFound('Inbound'));
    deleteInbound(db, existing.id);
    bumpConfigVersion(db, gateway.id);
    return ok(res, { removed: true });
  });

  router.post('/:id/inbounds/check', async (req, res, next) => {
    const gateway = getGateway(db, req.params.id);
    if (!gateway) return next(notFound('Gateway'));
    try {
      return ok(res, { gatewayId: gateway.id, inbounds: await checkGatewayInbounds(db, gateway) });
    } catch (error) {
      return next(error);
    }
  });

  return router;
}
