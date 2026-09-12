#!/usr/bin/env node
/**
 * Removes a customer account and everything that belonged to it, so the address
 * can be signed up again from scratch.
 *
 * Usage:
 *   node scripts/forget-customer.js someone@example.com [another@example.com …]
 *   node scripts/forget-customer.js --dry-run someone@example.com
 *
 * Sessions, orders and link codes fall with the customer row on their own
 * cascades. Subscribers do not: the column joining them was added later and
 * carries no foreign key, so deleting only the customer would leave a
 * subscription row behind — one still inside its dates, still answering on the
 * subscription URL whoever holds it already has. They are deleted here, by hand
 * and in the same transaction, and their credentials cascade from those.
 *
 * A comped address gets its subscription back the next time it signs in; that
 * grant is made on the way in, not at registration.
 */
import { openDatabase } from '../src/db/index.js';

const db = openDatabase(process.env.DB_PATH || '/data/cvpn.db');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const emails = args
  .filter((a) => a !== '--dry-run')
  .map((a) => a.trim().toLowerCase())
  .filter(Boolean);

if (!emails.length) {
  process.stderr.write('Usage: node scripts/forget-customer.js [--dry-run] <email> [email …]\n');
  process.exit(1);
}

const findCustomer = db.prepare('SELECT id, email, created_at FROM customers WHERE email = ?');
const findSubscribers = db.prepare('SELECT id, name, product, expires_at FROM subscribers WHERE customer_id = ?');
const countOrders = db.prepare('SELECT count(*) n FROM orders WHERE customer_id = ?');
const countSessions = db.prepare('SELECT count(*) n FROM customer_sessions WHERE customer_id = ?');
const deleteSubscribers = db.prepare('DELETE FROM subscribers WHERE customer_id = ?');
const deleteCustomer = db.prepare('DELETE FROM customers WHERE id = ?');

let missing = 0;

const forget = db.transaction((email) => {
  const customer = findCustomer.get(email);
  if (!customer) {
    process.stdout.write(`— ${email}: no account\n`);
    missing += 1;
    return;
  }
  const subscribers = findSubscribers.all(customer.id);
  const orders = countOrders.get(customer.id).n;
  const sessions = countSessions.get(customer.id).n;

  process.stdout.write(
    `${dryRun ? 'would delete' : 'deleted'} ${email} (${customer.id})`
    + ` — ${subscribers.length} subscription(s), ${orders} order(s), ${sessions} session(s)\n`,
  );
  for (const s of subscribers) {
    process.stdout.write(`    ${s.id}  ${s.product}  expires ${new Date(s.expires_at).toISOString().slice(0, 10)}\n`);
  }
  if (dryRun) return;
  deleteSubscribers.run(customer.id);
  deleteCustomer.run(customer.id);
});

for (const email of emails) forget(email);

if (dryRun) process.stdout.write('\nNothing was changed. Run again without --dry-run to delete.\n');
process.exit(missing === emails.length ? 1 : 0);
