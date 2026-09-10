import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../lib/validate.js';
import { ok, created } from '../lib/respond.js';
import { unauthorized, notFound, badRequest } from '../lib/errors.js';
import { createRateLimiter, clientIp } from '../lib/ratelimit.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import {
  registerCustomer, loginCustomer, logoutCustomer, customerForSession,
  listPlans, createOrder, getOrder, listOrders, cancelOrder, fromMicro,
} from '../domain/shop.js';
import {
  subscriberForCustomer, revealToken, entitlement, activeCredentials,
} from '../domain/subscribers.js';
import { describePaymentConfig } from '../services/tron.js';
import { clientProfile } from '../domain/xray.js';
import { gatewaysFor } from './public.js';

const credentialsSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(160),
  password: z.string().min(8, 'use at least 8 characters').max(256),
});

const orderSchema = z.object({ planId: z.string().trim().min(3).max(64) });

function bearer(req) {
  const header = req.get('authorization') || '';
  const [scheme, value] = header.split(' ');
  if (!value || scheme.toLowerCase() !== 'bearer') return null;
  return value.trim();
}

function requireCustomer(db) {
  return (req, _res, next) => {
    const token = bearer(req);
    const customer = customerForSession(db, token);
    if (!customer) return next(unauthorized('Sign in to continue'));
    req.customer = customer;
    req.customerToken = token;
    return next();
  };
}

const planView = (plan) => ({
  id: plan.id,
  name: plan.name,
  description: plan.description,
  quotaBytes: plan.quota_bytes,
  durationDays: plan.duration_days,
  priceUsdt: fromMicro(plan.price_micro),
  priceMicro: plan.price_micro,
});

const orderView = (order) => ({
  id: order.id,
  planId: order.plan_id,
  planName: order.plan_name,
  quotaBytes: order.quota_bytes,
  durationDays: order.duration_days,
  status: order.status,
  priceUsdt: fromMicro(order.price_micro),
  // The exact amount matters: it is how the payment is attributed to this order.
  payAmountUsdt: fromMicro(order.pay_amount_micro),
  payAmountMicro: order.pay_amount_micro,
  payAddress: order.pay_address,
  chain: order.chain,
  asset: order.asset,
  txHash: order.tx_hash,
  confirmations: order.confirmations,
  settledBy: order.settled_by,
  createdAt: new Date(order.created_at).toISOString(),
  expiresAt: new Date(order.expires_at).toISOString(),
  paidAt: order.paid_at ? new Date(order.paid_at).toISOString() : null,
  fulfilledAt: order.fulfilled_at ? new Date(order.fulfilled_at).toISOString() : null,
});

/** Everything the "my config" screen needs, or a clear reason there is nothing. */
function subscriptionView(db, req, customerId) {
  const subscriber = subscriberForCustomer(db, customerId);
  if (!subscriber) return null;
  const state = entitlement(subscriber);
  const token = revealToken(db, subscriber.id);
  const base = config.publicBaseUrl || `${req.protocol}://${req.get('host')}`;
  const credentials = activeCredentials(db, subscriber.id).filter((c) => c.state === 'active');
  const profiles = token
    ? gatewaysFor(db, subscriber.id).flatMap(({ gateway, state: routeState }) => credentials.map((credential) => ({
      gatewayId: gateway.id,
      gatewayName: gateway.name,
      region: gateway.region,
      routeState,
      uri: clientProfile(gateway, credential.uuid),
    })))
    : [];

  return {
    id: subscriber.id,
    active: state.entitled,
    state: state.reason,
    quotaBytes: subscriber.quota_bytes,
    usedBytes: subscriber.used_bytes,
    remainingBytes: subscriber.quota_bytes > 0
      ? Math.max(0, subscriber.quota_bytes - subscriber.used_bytes) : null,
    expiresAt: new Date(subscriber.expires_at).toISOString(),
    subscriptionUrl: token ? `${base}/sub/${token}` : null,
    profiles,
    profileCount: profiles.length,
  };
}

export function shopRoutes({ db }) {
  const router = Router();
  const authLimiter = createRateLimiter({
    windowMs: 60000,
    max: 12,
    keyFn: (req) => `shop-auth:${clientIp(req)}:${String(req.body?.email || '').slice(0, 80)}`,
  });
  const generalLimiter = createRateLimiter({
    windowMs: 60000, max: 240, keyFn: (req) => `shop:${clientIp(req)}`,
  });

  router.use(generalLimiter);

  router.use((req, res, next) => {
    if (!config.shop.enabled) {
      return next(badRequest('The storefront is disabled on this deployment'));
    }
    return next();
  });

  // Public: what is for sale and how payment works.
  router.get('/config', (_req, res) => ok(res, {
    payment: describePaymentConfig(),
    supportContact: config.shop.supportContact || null,
  }));

  router.get('/plans', (_req, res) => ok(res, listPlans(db).map(planView)));

  router.post('/register', authLimiter, validate(credentialsSchema), (req, res, next) => {
    try {
      registerCustomer(db, req.body);
    } catch (err) {
      return next(err);
    }
    const session = loginCustomer(db, { ...req.body, userAgent: req.get('user-agent') });
    return created(res, {
      token: session.token,
      expiresAt: new Date(session.expiresAt).toISOString(),
      customer: session.customer,
    });
  });

  router.post('/login', authLimiter, validate(credentialsSchema), (req, res, next) => {
    const session = loginCustomer(db, { ...req.body, userAgent: req.get('user-agent') });
    if (!session) {
      logger.info('customer login failed', { ip: clientIp(req) });
      return next(unauthorized('Wrong email or password'));
    }
    return ok(res, {
      token: session.token,
      expiresAt: new Date(session.expiresAt).toISOString(),
      customer: session.customer,
    });
  });

  router.post('/logout', requireCustomer(db), (req, res) => {
    logoutCustomer(db, req.customerToken);
    return ok(res, { loggedOut: true });
  });

  // The single screen a customer lives on: their subscription and its state.
  router.get('/me', requireCustomer(db), (req, res) => ok(res, {
    customer: req.customer,
    subscription: subscriptionView(db, req, req.customer.id),
    orders: listOrders(db, req.customer.id, 10).map(orderView),
  }));

  router.post('/orders', requireCustomer(db), validate(orderSchema), (req, res, next) => {
    try {
      const order = createOrder(db, req.customer.id, req.body.planId);
      return created(res, orderView(order));
    } catch (err) {
      return next(err);
    }
  });

  router.get('/orders', requireCustomer(db), (req, res) =>
    ok(res, listOrders(db, req.customer.id, 20).map(orderView)));

  router.get('/orders/:id', requireCustomer(db), (req, res, next) => {
    const order = getOrder(db, req.params.id);
    if (!order || order.customer_id !== req.customer.id) return next(notFound('Order'));
    return ok(res, {
      ...orderView(order),
      subscription: order.status === 'fulfilled' ? subscriptionView(db, req, req.customer.id) : null,
    });
  });

  router.post('/orders/:id/cancel', requireCustomer(db), (req, res, next) => {
    if (!cancelOrder(db, req.params.id, req.customer.id)) {
      return next(badRequest('Only a pending order can be cancelled'));
    }
    return ok(res, { cancelled: true });
  });

  return router;
}

export { requireCustomer, planView, orderView };
