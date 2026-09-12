#!/usr/bin/env node
/**
 * Answers one question: why does the app show no servers?
 *
 * A subscriber is handed a profile only where a gateway clears every hurdle in
 * turn — enabled, reachable, with an egress that is not known-broken — and when
 * the list comes back empty the app can only say that it is empty. It cannot
 * say which hurdle, because the subscription endpoint deliberately tells a
 * caller nothing it could enumerate the fleet with.
 *
 * This runs on the server, where saying so is safe.
 *
 * Usage:
 *   node scripts/why-no-servers.js                     # the fleet
 *   node scripts/why-no-servers.js someone@example.com # and one subscriber
 *
 * It reads. Nothing here writes to the database.
 */
import { openDatabase } from '../src/db/index.js';
import { enabledGateways, usableGateways, gatewaysFor } from '../src/routes/public.js';
import { candidatesFor, routeState } from '../src/domain/routing.js';
import { activeCredentials, entitlement } from '../src/domain/subscribers.js';

/**
 * The route states in the words of somebody trying to fix one.
 *
 * The states themselves come from domain/routing.js rather than being worked
 * out again here: a second opinion about why a gateway is unusable is a second
 * opinion that can be wrong.
 */
const WHY = {
  disabled: 'disabled in the admin console — switch it on there',
  'ingress-down': 'the gateway itself is not answering: the agent is not reporting, or the port is shut',
  'no-egress': 'no egress is selected for it, so a client could reach it and get nowhere',
  'egress-down': 'its selected egress is offline',
};

const db = openDatabase(process.env.DB_PATH || '/data/cvpn.db');
const email = (process.argv[2] || '').trim().toLowerCase();

const all = db.prepare('SELECT * FROM gateways ORDER BY priority, name').all();
const enabled = enabledGateways(db);
const usable = usableGateways(db);

console.log('== gateways');
console.log(`   registered   ${all.length}`);
console.log(`   enabled      ${enabled.length}`);
console.log(`   usable now   ${usable.length}`);

if (!all.length) {
  console.log('');
  console.log('   Nothing is registered. The control plane is running and has no fleet,');
  console.log('   so every subscription is correctly empty: there is nothing to hand out.');
  console.log('   Add a gateway in the admin console, and run the agent on that host.');
} else {
  console.log('');
  for (const gateway of all) {
    const active = candidatesFor(db, gateway.id).find((c) => c.id === gateway.active_egress_id) || null;
    const state = routeState(gateway, active);
    const offered = usable.some((r) => r.gateway.id === gateway.id);
    console.log(`   ${gateway.name} (${gateway.id})`);
    const seen = gateway.agent_last_seen_at
      ? new Date(gateway.agent_last_seen_at).toISOString()
      : 'never';
    console.log(`      region ${gateway.region || '—'}  ingress ${gateway.ingress_status || 'unknown'}`
      + `  agent ${gateway.agent_status || 'unknown'}, last seen ${seen}`);
    console.log(`      route ${state}`);
    console.log(`      ${offered ? 'offered to subscribers' : `NOT offered: ${WHY[state] || state}`}`);
  }
}

if (!email) {
  console.log('');
  console.log('Pass an email to see what one account would actually be handed.');
  process.exit(0);
}

console.log('');
console.log(`== ${email}`);
const customer = db.prepare('SELECT id FROM customers WHERE email = ?').get(email);
if (!customer) {
  console.log('   no account with that address');
  process.exit(1);
}
const subscriber = db.prepare(
  'SELECT * FROM subscribers WHERE customer_id = ? ORDER BY created_at DESC',
).get(customer.id);
if (!subscriber) {
  console.log('   the account exists and has no subscription — nothing was bought or comped');
  process.exit(1);
}

const state = entitlement(subscriber);
console.log(`   subscription ${subscriber.id}  ${state.entitled ? 'entitled' : `NOT entitled: ${state.reason}`}`);
console.log(`   quota ${subscriber.quota_bytes === 0 ? 'unmetered' : `${(subscriber.quota_bytes / 1024 ** 3).toFixed(1)} GB`}`
  + `  used ${(subscriber.used_bytes / 1024 ** 3).toFixed(2)} GB`
  + `  expires ${new Date(subscriber.expires_at).toISOString().slice(0, 10)}`);

const credentials = activeCredentials(db, subscriber.id).filter((c) => c.state === 'active');
console.log(`   active credentials ${credentials.length}`);

const routes = gatewaysFor(db, subscriber.id);
console.log(`   gateways offered to this subscriber ${routes.length}`);
console.log(`   => profiles it would receive: ${routes.length * credentials.length}`);

if (routes.length * credentials.length === 0) {
  console.log('');
  console.log('   That is the empty list the app is showing.');
  if (!credentials.length) console.log('   Cause: the subscription has no active credential.');
  if (!routes.length) console.log('   Cause: no gateway is currently usable (see above).');
}
