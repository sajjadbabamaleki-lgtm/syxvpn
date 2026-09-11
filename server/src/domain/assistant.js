/**
 * What the support assistant is allowed to know, and what it may do.
 *
 * The difference between a support bot people swear at and one they thank is
 * not the wording — it is whether it can see the account in front of it. Nearly
 * every ticket this service gets is answerable from state the control plane
 * already holds: the quota ran out, the order has two confirmations of three,
 * the gateway that phone is on went degraded an hour ago, the app on it is too
 * old to read the config it was handed. A bot with a FAQ guesses at those. A
 * bot with these tools answers them.
 *
 * Two rules shape everything here, and both are about what is *not* exposed:
 *
 *  1. **State, never traffic.** The assistant may see whether a subscription is
 *     active and how much of its quota is left. It cannot see what anybody
 *     visited, from where, or when — the control plane does not record that,
 *     and this is not the place to start.
 *
 *  2. **Nothing that is a credential.** No session token, no subscription URL,
 *     no credential UUID, no config line, no gateway address. A subscription
 *     URL alone is enough to use an account, and a transcript is not a safe
 *     place for one. Gateways are named and placed, not addressed.
 *
 * Every tool is read-only except [escalate_to_human], which writes one row and
 * is the only thing here that changes anything at all. Refunds, top-ups,
 * credential rotation and cancellations are deliberately absent: they move
 * money or access, and a model that can be talked into them will be.
 */

import { config } from '../config.js';
import { entitlement, subscriberForCustomer, activeCredentials } from './subscribers.js';
import { listOrders, listPlans, fromMicro } from './shop.js';
import { listGateways } from './gateways.js';
import { offerableInbounds } from './inbounds.js';
import { listEvents } from './events.js';

/** Seconds of slack allowed before a "last seen" figure is worth mentioning. */
const RECENT_EVENT_LIMIT = 12;

/**
 * The tool definitions, in the shape the Messages API takes them.
 *
 * `strict` is on everywhere: an argument the schema does not describe is a
 * misunderstanding, and one that arrives anyway is a bug that should fail here
 * rather than three calls later.
 */
export const TOOLS = [
  {
    name: 'get_subscription',
    description:
      'The state of the linked account\'s subscription: whether it is active, why not if it is not, '
      + 'how much data is left, when it expires, and when the app last fetched it. '
      + 'Use this first for anything about connecting, running out, or expiry.',
    strict: true,
    input_schema: { type: 'object', properties: {}, required: [], additionalProperties: false },
  },
  {
    name: 'get_servers',
    description:
      'The gateways this account is currently offered, each with what the control plane last '
      + 'measured: whether its ingress answers, the state of its route out, its latency, and which '
      + 'extra protocols are live on it. Use this when someone says a connection is slow, broken, or '
      + 'only works sometimes. Returns names and regions, never addresses.',
    strict: true,
    input_schema: { type: 'object', properties: {}, required: [], additionalProperties: false },
  },
  {
    name: 'get_orders',
    description:
      'Recent orders for the linked account: status, amount, how many chain confirmations have '
      + 'arrived, and when the payment window closes. Use this for "I paid and nothing happened".',
    strict: true,
    input_schema: { type: 'object', properties: {}, required: [], additionalProperties: false },
  },
  {
    name: 'get_plans',
    description:
      'What is on sale right now, with prices in USDT. Works without a linked account, so it is the '
      + 'tool for someone who has not bought anything yet.',
    strict: true,
    input_schema: { type: 'object', properties: {}, required: [], additionalProperties: false },
  },
  {
    name: 'get_service_status',
    description:
      'The fleet as a whole: how many gateways are online, degraded or offline, and anything serious '
      + 'that has happened recently. Use it to tell a local problem from an outage everybody is '
      + 'having — and say so plainly when it is the second.',
    strict: true,
    input_schema: { type: 'object', properties: {}, required: [], additionalProperties: false },
  },
  {
    name: 'escalate_to_human',
    description:
      'Hand this conversation to a person. Use it when you cannot answer from the tools, when money '
      + 'or access would have to change, when someone asks for a human, or when they are upset. '
      + 'Say so in your reply as well — do not hand over silently.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        reason: {
          type: 'string',
          description: 'One line for the operator: what was asked and what you already checked.',
        },
      },
      required: ['reason'],
      additionalProperties: false,
    },
  },
];

const NO_ACCOUNT = {
  linked: false,
  note: 'This chat is not linked to an account. Ask them to open the storefront, sign in, and send '
    + 'the code it gives them with /link <code>.',
};

const bytesToGb = (bytes) => Math.round((bytes / 1024 ** 3) * 10) / 10;
const iso = (ms) => (ms ? new Date(ms).toISOString() : null);

function subscriptionTool(db, chat) {
  if (!chat.customer_id) return NO_ACCOUNT;
  const subscriber = subscriberForCustomer(db, chat.customer_id);
  if (!subscriber) {
    return { linked: true, hasSubscription: false, note: 'This account has never had a subscription.' };
  }
  const state = entitlement(subscriber);
  return {
    linked: true,
    hasSubscription: true,
    active: state.entitled,
    // "expired", "quota-exhausted", "disabled" — the reason is the answer to
    // most of the tickets this tool exists for.
    state: state.reason || 'active',
    product: subscriber.product,
    usedGb: bytesToGb(subscriber.used_bytes),
    quotaGb: subscriber.quota_bytes > 0 ? bytesToGb(subscriber.quota_bytes) : null,
    remainingGb: subscriber.quota_bytes > 0
      ? bytesToGb(Math.max(0, subscriber.quota_bytes - subscriber.used_bytes))
      : null,
    unmetered: subscriber.quota_bytes === 0,
    expiresAt: iso(subscriber.expires_at),
    // How long ago the app actually asked for its servers. A phone that has not
    // fetched for a week is a phone that has not been opened, which is a very
    // different problem from a gateway being down.
    lastFetchAt: iso(subscriber.last_fetch_at),
    activeCredentials: activeCredentials(db, subscriber.id).filter((c) => c.state === 'active').length,
  };
}

function serversTool(db, chat) {
  if (!chat.customer_id) return NO_ACCOUNT;
  const subscriber = subscriberForCustomer(db, chat.customer_id);
  if (!subscriber) return { linked: true, hasSubscription: false, servers: [] };

  // Imported lazily: routes/public.js owns which gateways a subscriber is told
  // about, and that rule (a stable few, chosen by rendezvous hashing) must not
  // be reimplemented here where it would drift.
  // eslint-disable-next-line global-require
  return {
    linked: true,
    servers: gatewaysForSubscriber(db, subscriber.id).map(({ gateway, state }) => ({
      name: gateway.name,
      region: gateway.region,
      ingress: gateway.ingress_status,
      route: state,
      latencyMs: gateway.ingress_latency_ms,
      checkedAt: iso(gateway.ingress_checked_at),
      extraProtocols: offerableInbounds(db, gateway.id).map((i) => i.kind),
    })),
  };
}

/**
 * Set by the route layer at start-up to `routes/public.js`'s own selector.
 *
 * A plain import would be a cycle — public.js imports the shop, the shop
 * imports this — and duplicating the selection rule would mean the assistant
 * eventually describes gateways the subscriber was never given.
 */
let gatewaysForSubscriber = () => [];
export function useGatewaySelector(fn) {
  gatewaysForSubscriber = fn;
}

function ordersTool(db, chat) {
  if (!chat.customer_id) return NO_ACCOUNT;
  return {
    linked: true,
    orders: listOrders(db, chat.customer_id, 5).map((order) => ({
      id: order.id,
      plan: order.plan_name,
      status: order.status,
      amountUsdt: fromMicro(order.pay_amount_micro),
      asset: order.asset,
      confirmations: order.confirmations,
      confirmationsRequired: config.shop.confirmations,
      createdAt: iso(order.created_at),
      expiresAt: iso(order.expires_at),
      fulfilledAt: iso(order.fulfilled_at),
    })),
  };
}

function plansTool(db) {
  return {
    payments: config.shop.payAddress ? 'USDT on TRON (TRC-20)' : 'not configured on this deployment',
    plans: listPlans(db).map((plan) => ({
      id: plan.id,
      name: plan.name,
      product: plan.product,
      billing: plan.billing,
      priceUsdt: fromMicro(plan.price_micro),
      quotaGb: plan.quota_bytes > 0 ? bytesToGb(plan.quota_bytes) : null,
      days: plan.duration_days,
    })),
  };
}

function serviceStatusTool(db) {
  const gateways = listGateways(db).filter((g) => g.enabled === 1);
  const count = (status) => gateways.filter((g) => g.ingress_status === status).length;
  return {
    gatewaysEnabled: gateways.length,
    online: count('online'),
    degraded: count('degraded'),
    offline: count('offline'),
    recentTrouble: listEvents(db, { limit: RECENT_EVENT_LIMIT, severity: 'critical' })
      .map((event) => ({ at: event.createdAt, message: event.message })),
  };
}

/**
 * Runs one tool call.
 *
 * Unknown names return an error object rather than throwing: a model that asked
 * for something that does not exist should be told so and given another turn,
 * not have the conversation end in a stack trace.
 *
 * @param onEscalate called with the reason when the assistant hands over.
 */
export function runTool(db, chat, name, input = {}, { onEscalate } = {}) {
  switch (name) {
    case 'get_subscription': return subscriptionTool(db, chat);
    case 'get_servers': return serversTool(db, chat);
    case 'get_orders': return ordersTool(db, chat);
    case 'get_plans': return plansTool(db);
    case 'get_service_status': return serviceStatusTool(db);
    case 'escalate_to_human': {
      const reason = String(input.reason || '').slice(0, 500) || 'no reason given';
      onEscalate?.(reason);
      return { handedOver: true, reason };
    }
    default:
      return { error: `no such tool: ${name}` };
  }
}
