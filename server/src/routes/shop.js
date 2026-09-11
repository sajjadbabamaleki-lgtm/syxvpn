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
import { inboundProfile, offerableInbounds, inCohort } from '../domain/inbounds.js';
import { gatewaysFor } from './public.js';
import { issueLinkCode } from '../domain/chats.js';

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
  // Which tab this unlocks, and whether it is sold by time or by the gigabyte.
  // The app reads both: a plan card that does not say which of the two things
  // it buys is a refund request.
  product: plan.product,
  billing: plan.billing,
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
function subscriptionView(db, req, customerId, product = null) {
  const subscriber = subscriberForCustomer(db, customerId, product);
  if (!subscriber) return null;
  const state = entitlement(subscriber);
  const token = revealToken(db, subscriber.id);
  const base = config.publicBaseUrl || `${req.protocol}://${req.get('host')}`;
  const credentials = activeCredentials(db, subscriber.id).filter((c) => c.state === 'active');
  // Every line this subscriber could hand to a client app, including the
  // additional doors when they are in the rollout. This screen is where
  // somebody using another app — NPV Tunnel, v2rayNG, Hiddify — copies a
  // config from, so serving fewer here than the subscription endpoint does
  // would quietly give those people less than the app's own users get.
  const extras = inCohort(subscriber.id);
  const profiles = token
    ? gatewaysFor(db, subscriber.id).flatMap(({ gateway, state: routeState }) => credentials.flatMap((credential) => {
      const lines = [{
        gatewayId: gateway.id,
        gatewayName: gateway.name,
        region: gateway.region,
        routeState,
        protocol: 'vless',
        label: `${gateway.name} · ${gateway.region}`,
        uri: clientProfile(gateway, credential.uuid),
      }];
      if (!extras) return lines;
      for (const inbound of offerableInbounds(db, gateway.id)) {
        lines.push({
          gatewayId: gateway.id,
          gatewayName: gateway.name,
          region: gateway.region,
          routeState,
          protocol: inbound.kind,
          inboundId: inbound.id,
          label: `${gateway.name} · ${gateway.region} · ${inbound.kind}`,
          uri: inboundProfile(gateway, inbound, credential.uuid),
        });
      }
      return lines;
    }))
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
    // Named only when there is a bot to answer and a handle to reach it by.
    // The storefront shows the linking step at all only when this is here, so
    // nobody is offered a code for a chat that does not exist.
    supportBot: config.assistant.enabled && config.assistant.telegram.botUsername
      ? { telegram: config.assistant.telegram.botUsername }
      : null,
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

  /**
   * A one-time code that links a chat to this account.
   *
   * The bot never asks for a password: a chat app is not a place to type one,
   * and a support conversation is not a place to have typed one. The code is
   * issued to a session that is already signed in here, lasts ten minutes, and
   * works once.
   */
  router.post('/link-code', requireCustomer(db), (req, res) =>
    ok(res, issueLinkCode(db, req.customer.id)));

  // The single screen a customer lives on: their subscription and its state.
  router.get('/me', requireCustomer(db), (req, res) => ok(res, {
    customer: req.customer,
    // One per product, because they are bought separately. A subscription sold
    // before the split has product 'all' and answers for both.
    subscriptions: {
      vpn: subscriptionView(db, req, req.customer.id, 'vpn'),
      configs: subscriptionView(db, req, req.customer.id, 'configs'),
    },
    // What every installed app reads today. It stays until they have all been
    // replaced: changing the shape of this would leave a paying customer's
    // phone showing them no subscription at all.
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
      subscription: order.status === 'fulfilled'
        ? subscriptionView(db, req, req.customer.id, order.product) : null,
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
