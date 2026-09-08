import { Router } from 'express';
import { z } from 'zod';
import { validate, nameField } from '../lib/validate.js';
import { ok, created } from '../lib/respond.js';
import { notFound } from '../lib/errors.js';
import {
  createSubscriber, getSubscriber, updateSubscriber, deleteSubscriber,
  rotateToken, rotateCredential, activeCredentials, entitlement, usageSummary, GB,
} from '../domain/subscribers.js';
import { subscriberView } from './serialize.js';
import { config } from '../config.js';

const MAX_QUOTA_BYTES = 100 * 1024 * GB; // 100 TiB ceiling keeps input sane.

const createSchema = z.object({
  name: nameField,
  // quotaBytes = 0 means unmetered; it is still bounded by the expiry date.
  quotaBytes: z.coerce.number().int().min(0).max(MAX_QUOTA_BYTES).optional(),
  quotaGb: z.coerce.number().min(0).max(102400).optional(),
  expiresAt: z.coerce.date().optional(),
  days: z.coerce.number().int().min(1).max(3650).optional(),
  note: z.string().trim().max(500).nullish(),
}).transform((v) => ({
  name: v.name,
  quotaBytes: v.quotaBytes ?? Math.round((v.quotaGb ?? 10) * GB),
  expiresAt: (v.expiresAt ? v.expiresAt.getTime() : Date.now() + (v.days ?? 30) * 86400000),
  note: v.note ?? null,
})).refine((v) => v.expiresAt > Date.now(), { message: 'expiresAt must be in the future' });

const patchSchema = z.object({
  name: nameField.optional(),
  quotaBytes: z.coerce.number().int().min(0).max(MAX_QUOTA_BYTES).optional(),
  quotaGb: z.coerce.number().min(0).max(102400).optional(),
  expiresAt: z.coerce.date().optional(),
  extendDays: z.coerce.number().int().min(1).max(3650).optional(),
  status: z.enum(['active', 'disabled']).optional(),
  note: z.string().trim().max(500).nullish(),
});

const rotateCredentialSchema = z.object({
  graceMinutes: z.coerce.number().int().min(0).max(1440).default(0),
});

function subscriptionUrl(req, token) {
  const base = config.publicBaseUrl || `${req.protocol}://${req.get('host')}`;
  return `${base}/sub/${token}`;
}

export function adminSubscriberRoutes({ db }) {
  const router = Router();

  router.get('/', (req, res) => {
    const q = String(req.query.q || '').trim().toLowerCase();
    const status = String(req.query.status || 'all');
    const now = Date.now();
    let rows = db.prepare('SELECT * FROM subscribers ORDER BY created_at DESC').all();
    if (q) rows = rows.filter((s) => s.name.toLowerCase().includes(q) || s.id.toLowerCase().includes(q));
    const withState = rows.map((s) => {
      const e = entitlement(s, now);
      return subscriberView(s, { entitled: e.entitled, entitlementReason: e.reason });
    });
    const filtered = status === 'all' ? withState : withState.filter((s) => {
      if (status === 'active') return s.entitled;
      if (status === 'expired') return s.entitlementReason === 'expired';
      if (status === 'disabled') return s.entitlementReason === 'disabled';
      if (status === 'exhausted') return s.entitlementReason === 'quota-exhausted';
      return true;
    });
    return ok(res, filtered, { total: rows.length, returned: filtered.length });
  });

  router.post('/', validate(createSchema), (req, res) => {
    const { id, token } = createSubscriber(db, req.body);
    const sub = getSubscriber(db, id);
    // The raw token is shown exactly once; only its hash is stored.
    return created(res, {
      ...subscriberView(sub, { entitled: true, entitlementReason: 'active' }),
      subscriptionUrl: subscriptionUrl(req, token),
      subscriptionToken: token,
    });
  });

  router.get('/:id', (req, res, next) => {
    const sub = getSubscriber(db, req.params.id);
    if (!sub) return next(notFound('Subscriber'));
    const e = entitlement(sub);
    const credentials = activeCredentials(db, sub.id).map((c) => ({
      id: c.id,
      state: c.state,
      // Only the last segment of the UUID is shown; the full value is a secret.
      uuidHint: `…${c.uuid.slice(-12)}`,
      createdAt: new Date(c.created_at).toISOString(),
      retiredAt: c.retired_at ? new Date(c.retired_at).toISOString() : null,
    }));
    return ok(res, subscriberView(sub, {
      entitled: e.entitled,
      entitlementReason: e.reason,
      credentials,
      recentUsage: usageSummary(db, sub.id).map((u) => ({
        gatewayId: u.gateway_id,
        direction: u.direction,
        bytes: u.bytes,
        at: new Date(u.created_at).toISOString(),
      })),
    }));
  });

  router.patch('/:id', validate(patchSchema), (req, res, next) => {
    const current = getSubscriber(db, req.params.id);
    if (!current) return next(notFound('Subscriber'));
    const patch = {};
    if (req.body.name !== undefined) patch.name = req.body.name;
    if (req.body.note !== undefined) patch.note = req.body.note;
    if (req.body.status !== undefined) patch.status = req.body.status;
    if (req.body.quotaBytes !== undefined) patch.quotaBytes = req.body.quotaBytes;
    else if (req.body.quotaGb !== undefined) patch.quotaBytes = Math.round(req.body.quotaGb * GB);
    if (req.body.expiresAt !== undefined) patch.expiresAt = req.body.expiresAt.getTime();
    else if (req.body.extendDays !== undefined) {
      const from = Math.max(current.expires_at, Date.now());
      patch.expiresAt = from + req.body.extendDays * 86400000;
    }
    const updated = updateSubscriber(db, req.params.id, patch);
    const e = entitlement(updated);
    return ok(res, subscriberView(updated, { entitled: e.entitled, entitlementReason: e.reason }));
  });

  router.delete('/:id', (req, res, next) => {
    if (!deleteSubscriber(db, req.params.id)) return next(notFound('Subscriber'));
    return ok(res, { deleted: true });
  });

  router.post('/:id/rotate-token', (req, res, next) => {
    const token = rotateToken(db, req.params.id);
    if (!token) return next(notFound('Subscriber'));
    return ok(res, { subscriptionUrl: subscriptionUrl(req, token), subscriptionToken: token });
  });

  router.post('/:id/rotate-credential', validate(rotateCredentialSchema), (req, res, next) => {
    const result = rotateCredential(db, req.params.id, { graceMs: req.body.graceMinutes * 60000 });
    if (!result) return next(notFound('Subscriber'));
    return ok(res, {
      credentialId: result.credentialId,
      graceMinutes: req.body.graceMinutes,
      note: req.body.graceMinutes > 0
        ? 'Previous credential stays valid until the grace period ends.'
        : 'Previous credential was revoked immediately.',
    });
  });

  return router;
}
