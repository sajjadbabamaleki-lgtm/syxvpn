import { Router } from 'express';
import { z } from 'zod';
import { validate, nameField } from '../lib/validate.js';
import { ok, created } from '../lib/respond.js';
import { notFound } from '../lib/errors.js';
import {
  listPlans, createPlan, updatePlan, deletePlan, getOrder, settleOrder, toMicro, fromMicro,
} from '../domain/shop.js';
import { planView, orderView } from './shop.js';
import { describePaymentConfig } from '../services/tron.js';
import { recordEvent } from '../domain/events.js';

const GB = 1024 ** 3;

const planBody = {
  name: nameField,
  description: z.string().trim().max(300).nullish(),
  quotaGb: z.coerce.number().min(0).max(102400).optional(),
  quotaBytes: z.coerce.number().int().min(0).optional(),
  durationDays: z.coerce.number().int().min(1).max(3650),
  priceUsdt: z.coerce.number().min(0.01).max(100000),
  enabled: z.boolean().default(true),
  sortOrder: z.coerce.number().int().min(0).max(1000).default(100),
};

const createSchema = z.object(planBody).transform((v) => ({
  ...v,
  quotaBytes: v.quotaBytes ?? Math.round((v.quotaGb ?? 0) * GB),
  priceMicro: toMicro(v.priceUsdt),
}));

const patchSchema = z.object(planBody).partial().transform((v) => ({
  ...v,
  ...(v.quotaBytes === undefined && v.quotaGb !== undefined ? { quotaBytes: Math.round(v.quotaGb * GB) } : {}),
  ...(v.priceUsdt !== undefined ? { priceMicro: toMicro(v.priceUsdt) } : {}),
}));

const settleSchema = z.object({
  txHash: z.string().trim().min(6).max(120).optional(),
  note: z.string().trim().max(300).optional(),
});

/** Storefront administration: plans, orders and manual settlement. */
export function adminShopRoutes({ db, watcher }) {
  const router = Router();

  router.get('/plans', (_req, res) =>
    ok(res, listPlans(db, { includeDisabled: true }).map((p) => ({
      ...planView(p),
      enabled: p.enabled === 1,
      sortOrder: p.sort_order,
    }))));

  router.post('/plans', validate(createSchema), (req, res) =>
    created(res, planView(createPlan(db, req.body))));

  router.patch('/plans/:id', validate(patchSchema), (req, res, next) => {
    const plan = updatePlan(db, req.params.id, req.body);
    if (!plan) return next(notFound('Plan'));
    return ok(res, planView(plan));
  });

  router.delete('/plans/:id', (req, res, next) => {
    if (!deletePlan(db, req.params.id)) return next(notFound('Plan'));
    return ok(res, { deleted: true });
  });

  router.get('/orders', validate(z.object({
    status: z.enum(['pending', 'paid', 'fulfilled', 'expired', 'cancelled']).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  }), 'query'), (req, res) => {
    const { status, limit } = req.validatedQuery;
    const rows = status
      ? db.prepare('SELECT * FROM orders WHERE status = ? ORDER BY created_at DESC LIMIT ?').all(status, limit)
      : db.prepare('SELECT * FROM orders ORDER BY created_at DESC LIMIT ?').all(limit);
    const totals = db.prepare(`SELECT status, count(*) AS n, COALESCE(SUM(price_micro),0) AS micro
        FROM orders GROUP BY status`).all();
    return ok(res, rows.map((o) => ({
      ...orderView(o),
      customerId: o.customer_id,
      subscriberId: o.subscriber_id,
    })), {
      totals: Object.fromEntries(totals.map((t) => [t.status, { count: t.n, usdt: fromMicro(t.micro) }])),
    });
  });

  /**
   * Manual settlement, for a payment that arrived but the watcher could not
   * attribute (wrong amount, direct transfer, off-chain arrangement). It is
   * recorded as settled by the named operator, never as an on-chain payment.
   */
  router.post('/orders/:id/settle', validate(settleSchema), (req, res, next) => {
    const order = getOrder(db, req.params.id);
    if (!order) return next(notFound('Order'));
    try {
      const result = settleOrder(db, order.id, {
        txHash: req.body.txHash ?? null,
        fromAddress: null,
        confirmations: null,
        settledBy: `admin:${req.admin.username}`,
      });
      recordEvent(db, {
        type: 'order.settled_manually', severity: 'warning', targetType: 'order', targetId: order.id,
        message: `Order ${order.id} settled manually by ${req.admin.username}${req.body.note ? `: ${req.body.note}` : ''}`,
      });
      return ok(res, { order: orderView(result.order), subscriberId: result.subscriber?.id ?? null });
    } catch (err) {
      return next(err);
    }
  });

  router.get('/customers', (_req, res) => {
    const rows = db.prepare(`SELECT c.*, s.id AS subscriber_id, s.expires_at AS sub_expires_at,
          s.used_bytes, s.quota_bytes
        FROM customers c LEFT JOIN subscribers s ON s.customer_id = c.id
        ORDER BY c.created_at DESC LIMIT 200`).all();
    return ok(res, rows.map((c) => ({
      id: c.id,
      email: c.email,
      status: c.status,
      createdAt: new Date(c.created_at).toISOString(),
      lastLoginAt: c.last_login_at ? new Date(c.last_login_at).toISOString() : null,
      subscriberId: c.subscriber_id,
      quotaBytes: c.quota_bytes,
      usedBytes: c.used_bytes,
      expiresAt: c.sub_expires_at ? new Date(c.sub_expires_at).toISOString() : null,
    })));
  });

  router.get('/payments/config', (_req, res) => ok(res, describePaymentConfig()));

  /** Runs one watcher pass immediately instead of waiting for the poll interval. */
  router.post('/payments/scan', async (_req, res, next) => {
    if (!watcher) return next(notFound('Payment watcher'));
    try {
      return ok(res, await watcher.tick());
    } catch (err) {
      return next(err);
    }
  });

  return router;
}
