import crypto from 'node:crypto';
import { config } from '../config.js';

/**
 * Which gateways a given subscriber is told about.
 *
 * Until now, every subscriber was handed the address of every gateway. That
 * makes one leaked configuration a map of the whole fleet: a censor who buys a
 * single subscription — or picks up one phone — learns every address at once
 * and can block all of them in an afternoon. It is the cheapest way to lose a
 * fleet, and it costs the attacker one customer's price.
 *
 * So each subscriber gets a stable handful instead. A leak then burns that
 * handful. (Attribution was never the problem: the credential UUID in a leaked
 * profile already names the subscriber exactly.)
 *
 * The selection is rendezvous hashing — score every gateway against the
 * subscriber, keep the best few — which has the two properties this needs and
 * a modulo does not:
 *
 *   - it is stable, so a subscriber's configurations do not churn between
 *     requests, restarts or deployments;
 *   - adding or removing a gateway moves only the subscribers who had that
 *     gateway, rather than reshuffling everyone.
 *
 * The set is computed over every *enabled* gateway rather than every healthy
 * one, and health is applied afterwards. That ordering matters: scoring the
 * healthy pool would mean each time a gateway flapped, its subscribers were
 * handed a different one — and after enough flapping everybody would have been
 * told about everything, which is the state this exists to prevent.
 */

/** Deterministic, uniformly distributed, and not guessable without the ids. */
const score = (subscriberId, gatewayId) => crypto
  .createHash('sha256')
  .update(`${subscriberId}:${gatewayId}`)
  .digest('hex');

/**
 * The subscriber's own gateways, best-scoring first, preferring one per region
 * before doubling up.
 *
 * Region diversity is not decoration: three gateways in Frankfurt are one
 * German decision away from nothing, and a subscriber cannot be told to try
 * elsewhere if elsewhere was never in their list.
 */
export function homeGateways(gateways, subscriberId, size) {
  if (!(size > 0) || gateways.length <= size) return gateways;

  const ranked = gateways
    .map((gateway) => ({ gateway, key: score(subscriberId, gateway.id) }))
    .sort((a, b) => (a.key < b.key ? -1 : 1));

  const chosen = [];
  const regions = new Set();
  // First pass: the best-scoring gateway from each region it has not covered.
  for (const entry of ranked) {
    if (chosen.length >= size) break;
    const region = entry.gateway.region || '';
    if (regions.has(region)) continue;
    regions.add(region);
    chosen.push(entry);
  }
  // Second: fill the remaining slots by score, regions already spent.
  for (const entry of ranked) {
    if (chosen.length >= size) break;
    if (chosen.includes(entry)) continue;
    chosen.push(entry);
  }
  return chosen.map((entry) => entry.gateway);
}

/**
 * Narrows [usable] to what this subscriber should be told about.
 *
 * @param enabled every enabled gateway, healthy or not — the set is scored over
 *   this so membership does not move when health flaps.
 * @param usable the routes a client could actually use right now, in the order
 *   the operator's priorities put them.
 *
 * If none of the subscriber's own gateways is usable, the next best ones are
 * lent to them rather than leaving them with nothing: a customer with no
 * working configuration is a customer who has already left, and this is a rare
 * state that resolves as soon as one of their own comes back.
 */
export function routesForSubscriber(enabled, usable, subscriberId, {
  size = config.fleet.gatewaysPerSubscriber,
} = {}) {
  if (!(size > 0) || usable.length <= size) return usable;

  const home = new Set(homeGateways(enabled, subscriberId, size).map((g) => g.id));
  const mine = usable.filter((route) => home.has(route.gateway.id));
  if (mine.length) return mine;

  const lent = homeGateways(usable.map((r) => r.gateway), subscriberId, size);
  const lentIds = new Set(lent.map((g) => g.id));
  return usable.filter((route) => lentIds.has(route.gateway.id));
}
