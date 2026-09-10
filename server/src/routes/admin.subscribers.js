import { Router } from 'express';
import { z } from 'zod';
import { validate, nameField } from '../lib/validate.js';
import { ok, created } from '../lib/respond.js';
import { notFound } from '../lib/errors.js';
import {
  createSubscriber, getSubscriber, updateSubscriber, deleteSubscriber,
  rotateToken, rotateCredential, activeCredentials, entitlement, usageSummary, GB,
  createSubscriberBatch, listBatches, subscribersInBatch, revealToken,
} from '../domain/subscribers.js';
import { clientProfile } from '../domain/xray.js';
import { usableGateways, gatewaysFor } from './public.js';
import { recordEvent } from '../domain/events.js';
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

const batchSchema = z.object({
  count: z.coerce.number().int().min(1).max(500),
  namePrefix: z.string().trim().min(1).max(40).regex(/^[A-Za-z0-9 ._-]+$/, 'letters, digits, space, dot, dash or underscore'),
  quotaBytes: z.coerce.number().int().min(0).max(MAX_QUOTA_BYTES).optional(),
  quotaGb: z.coerce.number().min(0).max(102400).optional(),
  days: z.coerce.number().int().min(1).max(3650).default(30),
  note: z.string().trim().max(500).nullish(),
}).transform((v) => ({
  count: v.count,
  namePrefix: v.namePrefix,
  quotaBytes: v.quotaBytes ?? Math.round((v.quotaGb ?? 10) * GB),
  durationDays: v.days,
  note: v.note ?? null,
}));

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

  /**
   * Issues many subscriptions at once — the day's batch to hand out.
   *
   * The raw links are returned exactly once here, and can be re-read later per
   * subscriber (the token is sealed at rest, not hash-only, so an operator who
   * loses a link is not stuck reissuing it).
   */
  router.post('/batch', validate(batchSchema), (req, res) => {
    const { batchId, created: issued } = createSubscriberBatch(db, req.body);
    const fleet = usableGateways(db);
    const items = issued.map(({ id, name, token }) => {
      const sub = getSubscriber(db, id);
      const credential = activeCredentials(db, id).find((c) => c.state === 'active');
      return {
        id,
        name,
        subscriptionUrl: subscriptionUrl(req, token),
        // The raw profile URIs, for handing someone a single config rather than
        // a subscription link. Each subscriber's own gateways, not the fleet's:
        // what is printed here is what that subscriber can leak.
        profiles: credential
          ? gatewaysFor(db, id).map(({ gateway }) => clientProfile(gateway, credential.uuid))
          : [],
        quotaBytes: sub.quota_bytes,
        expiresAt: new Date(sub.expires_at).toISOString(),
      };
    });
    return created(res, {
      batchId,
      count: items.length,
      usableGateways: fleet.length,
      items,
    });
  });

  router.get('/batches', (_req, res) => ok(res, listBatches(db).map((b) => ({
    ...b,
    createdAt: new Date(b.createdAt).toISOString(),
    expiresAt: new Date(b.expiresAt).toISOString(),
  }))));

  router.get('/batches/:batchId', (req, res, next) => {
    const rows = subscribersInBatch(db, req.params.batchId);
    if (!rows.length) return next(notFound('Batch'));
    const format = String(req.query.format || 'json');
    const items = rows.map((sub) => {
      const token = revealToken(db, sub.id);
      const e = entitlement(sub);
      return {
        id: sub.id,
        name: sub.name,
        subscriptionUrl: token ? subscriptionUrl(req, token) : null,
        quotaBytes: sub.quota_bytes,
        usedBytes: sub.used_bytes,
        expiresAt: new Date(sub.expires_at).toISOString(),
        status: e.reason,
      };
    });
    recordEvent(db, {
      type: 'subscriber.batch_exported', severity: 'info', targetType: 'batch', targetId: req.params.batchId,
      message: `Batch ${req.params.batchId} exported as ${format} by ${req.admin.username}`,
    });

    if (format === 'csv') {
      const header = 'name,subscription_url,quota_bytes,used_bytes,expires_at,status';
      const body = items.map((i) => [
        i.name, i.subscriptionUrl, i.quotaBytes, i.usedBytes, i.expiresAt, i.status,
      ].join(',')).join('\n');
      res.type('text/csv').set('Content-Disposition', `attachment; filename="${req.params.batchId}.csv"`);
      return res.send(`${header}\n${body}\n`);
    }
    if (format === 'txt') {
      res.type('text/plain');
      return res.send(`${items.map((i) => `${i.name}\n${i.subscriptionUrl}\n`).join('\n')}`);
    }
    return ok(res, items, { batchId: req.params.batchId, count: items.length });
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

  /**
   * Re-reads a subscription link. Recorded as an event, because being able to
   * read a live credential is exactly the kind of action an audit trail is for.
   */
  router.get('/:id/subscription', (req, res, next) => {
    const sub = getSubscriber(db, req.params.id);
    if (!sub) return next(notFound('Subscriber'));
    const token = revealToken(db, sub.id);
    if (!token) return next(notFound('Subscription token'));
    const credential = activeCredentials(db, sub.id).find((c) => c.state === 'active');
    // What this subscriber is actually served, so an operator reading a link
    // sees the same list the customer does.
    const routes = gatewaysFor(db, sub.id);
    recordEvent(db, {
      type: 'subscriber.link_revealed', severity: 'info', targetType: 'subscriber', targetId: sub.id,
      message: `Subscription link for ${sub.name} shown to ${req.admin.username}`,
    });
    return ok(res, {
      subscriptionUrl: subscriptionUrl(req, token),
      profiles: credential ? routes.map(({ gateway, state }) => ({
        gatewayId: gateway.id,
        gatewayName: gateway.name,
        routeState: state,
        uri: clientProfile(gateway, credential.uuid),
      })) : [],
    });
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
