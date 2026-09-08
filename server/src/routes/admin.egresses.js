import { Router } from 'express';
import { z } from 'zod';
import { validate, hostField, portField, nameField, regionField, wsPathField } from '../lib/validate.js';
import { ok, created } from '../lib/respond.js';
import { notFound } from '../lib/errors.js';
import {
  listEgresses, getEgress, createEgress, updateEgress, deleteEgress,
} from '../domain/egresses.js';
import { recentChecks } from '../domain/health.js';
import { egressView, healthCheckView } from './serialize.js';

const kinds = ['direct', 'socks', 'vless'];

const base = {
  name: nameField,
  region: regionField,
  kind: z.enum(kinds),
  host: hostField.nullish(),
  port: portField.nullish(),
  // For a `direct` egress this selects which authorized uplink address the
  // gateway sends from (multi-homed VPS / authorized transit).
  bindAddress: z.string().trim().max(64).nullish(),
  username: z.string().trim().max(64).nullish(),
  secret: z.string().min(1).max(256).nullish(),
  tls: z.boolean().default(false),
  sni: hostField.nullish(),
  transport: z.enum(['tcp', 'ws']).default('tcp'),
  wsPath: wsPathField.nullish(),
  // End-to-end probe target the agent fetches *through* this egress.
  probeUrl: z.string().trim().url().max(300).nullish(),
  priority: z.coerce.number().int().min(1).max(1000).default(100),
  weight: z.coerce.number().int().min(1).max(1000).default(1),
  enabled: z.boolean().default(true),
  authorizationNote: z.string().trim().max(500).nullish(),
};

function checkShape(value, ctx) {
  const needsEndpoint = value.kind === 'socks' || value.kind === 'vless';
  if (needsEndpoint && (!value.host || !value.port)) {
    ctx.addIssue({ code: 'custom', path: ['host'], message: `kind "${value.kind}" requires host and port` });
  }
  if (value.kind === 'vless' && !value.secret) {
    ctx.addIssue({ code: 'custom', path: ['secret'], message: 'kind "vless" requires the upstream user id as secret' });
  }
}

const createSchema = z.object(base).superRefine(checkShape);
const patchSchema = z.object(base).partial().superRefine((v, ctx) => { if (v.kind) checkShape(v, ctx); });

export function adminEgressRoutes({ db }) {
  const router = Router();

  router.get('/', (_req, res) => {
    const rows = listEgresses(db).map((e) => egressView(e, {
      assignedGateways: db.prepare('SELECT count(*) AS n FROM gateway_egress WHERE egress_id=?').get(e.id).n,
      activeOn: db.prepare('SELECT count(*) AS n FROM gateways WHERE active_egress_id=?').get(e.id).n,
    }));
    return ok(res, rows);
  });

  router.post('/', validate(createSchema), (req, res) => created(res, egressView(createEgress(db, req.body))));

  router.get('/:id', (req, res, next) => {
    const egress = getEgress(db, req.params.id);
    if (!egress) return next(notFound('Egress'));
    const pairs = db.prepare(`SELECT ge.*, g.name AS gateway_name FROM gateway_egress ge
        JOIN gateways g ON g.id = ge.gateway_id WHERE ge.egress_id = ?`).all(egress.id);
    return ok(res, egressView(egress, {
      gateways: pairs.map((p) => ({
        gatewayId: p.gateway_id,
        gatewayName: p.gateway_name,
        status: p.status,
        latencyMs: p.latency_ms,
        checkedAt: p.checked_at ? new Date(p.checked_at).toISOString() : null,
        detail: p.detail,
      })),
      recentChecks: recentChecks(db, 'egress', egress.id, 20).map(healthCheckView),
    }));
  });

  router.patch('/:id', validate(patchSchema), (req, res, next) => {
    const egress = updateEgress(db, req.params.id, req.body);
    if (!egress) return next(notFound('Egress'));
    return ok(res, egressView(egress));
  });

  router.delete('/:id', (req, res, next) => {
    if (!deleteEgress(db, req.params.id)) return next(notFound('Egress'));
    return ok(res, { deleted: true });
  });

  return router;
}
