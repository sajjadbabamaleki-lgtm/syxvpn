import { Router } from 'express';
import { z } from 'zod';
import { ok } from '../lib/respond.js';
import { validate } from '../lib/validate.js';
import { listEvents } from '../domain/events.js';
import { healthCheckView } from './serialize.js';

const eventQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  severity: z.enum(['info', 'warning', 'critical']).optional(),
  targetId: z.string().trim().max(64).optional(),
  before: z.coerce.number().int().optional(),
});

const healthQuery = z.object({
  targetType: z.enum(['gateway', 'egress']).optional(),
  targetId: z.string().trim().max(64).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export function adminObservabilityRoutes({ db }) {
  const router = Router();

  router.get('/events', validate(eventQuery, 'query'), (req, res) =>
    ok(res, listEvents(db, req.validatedQuery)));

  router.get('/health-checks', validate(healthQuery, 'query'), (req, res) => {
    const { targetType, targetId, limit } = req.validatedQuery;
    const clauses = [];
    const params = [];
    if (targetType) { clauses.push('target_type = ?'); params.push(targetType); }
    if (targetId) { clauses.push('target_id = ?'); params.push(targetId); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    params.push(limit);
    const rows = db.prepare(`SELECT * FROM health_checks ${where} ORDER BY id DESC LIMIT ?`).all(...params);
    return ok(res, rows.map(healthCheckView));
  });

  router.get('/usage', validate(z.object({
    subscriberId: z.string().trim().max(64).optional(),
    limit: z.coerce.number().int().min(1).max(500).default(100),
  }), 'query'), (req, res) => {
    const { subscriberId, limit } = req.validatedQuery;
    const rows = subscriberId
      ? db.prepare('SELECT * FROM usage_events WHERE subscriber_id=? ORDER BY id DESC LIMIT ?').all(subscriberId, limit)
      : db.prepare('SELECT * FROM usage_events ORDER BY id DESC LIMIT ?').all(limit);
    return ok(res, rows.map((u) => ({
      id: u.id,
      subscriberId: u.subscriber_id,
      gatewayId: u.gateway_id,
      credentialId: u.credential_id,
      direction: u.direction,
      bytes: u.bytes,
      createdAt: new Date(u.created_at).toISOString(),
    })));
  });

  return router;
}
