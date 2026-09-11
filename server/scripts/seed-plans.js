#!/usr/bin/env node
/**
 * The three plans the public page is built around, created in one command.
 *
 *   docker compose --env-file .env -f deploy/docker-compose.yml \
 *     exec api node scripts/seed-plans.js
 *
 * The landing page reads /api/v1/shop/plans and renders whatever is there — it
 * has no prices of its own — so until a plan exists the pricing section has
 * nothing to show and says so. This puts the three in.
 *
 * Safe to run twice: a plan is matched by its duration, and one that already
 * exists is left exactly as it is. Nothing here deletes or edits anything.
 *
 * The numbers are the ones from the preview. They are a starting point, not a
 * decision: change any of them in the admin console under Plans, or edit the
 * table below and re-run after deleting the plan you want replaced.
 */

import { openDatabase } from '../src/db/index.js';
import { listPlans, createPlan, toMicro } from '../src/domain/shop.js';

const GB = 1024 ** 3;

const WANTED = [
  {
    name: 'Weekly · 30 GB',
    description: 'A week, to try it out.',
    quotaBytes: 30 * GB,
    durationDays: 7,
    priceMicro: toMicro(2),
    // 'vpn' sells the gateways only; the page crosses out the configs row for
    // it, which is the difference a buyer has to be able to see.
    product: 'vpn',
    billing: 'duration',
    sortOrder: 10,
  },
  {
    name: 'Monthly · 120 GB',
    description: 'A month, for everyday use.',
    quotaBytes: 120 * GB,
    durationDays: 30,
    priceMicro: toMicro(6),
    product: 'all',
    billing: 'duration',
    sortOrder: 20,
  },
  {
    name: 'Quarterly · unmetered',
    description: 'Three months, no volume cap.',
    // 0 is unmetered, and the page says so rather than printing "0 GB".
    quotaBytes: 0,
    durationDays: 90,
    priceMicro: toMicro(15),
    product: 'all',
    billing: 'duration',
    sortOrder: 30,
  },
];

const db = openDatabase(process.env.DB_PATH || '/data/cvpn.db');
const existing = listPlans(db, { includeDisabled: true });

console.log(`\n  ${existing.length} plan(s) already in the database.\n`);

let made = 0;
for (const want of WANTED) {
  const already = existing.find((p) => p.duration_days === want.durationDays);
  if (already) {
    console.log(`  kept    ${want.durationDays.toString().padStart(3)} days  ${already.name}`
      + `  (${(already.price_micro / 1e6).toFixed(2)} USDT, already there)`);
    continue;
  }
  const plan = createPlan(db, want);
  made += 1;
  console.log(`  created ${want.durationDays.toString().padStart(3)} days  ${plan.name}`
    + `  ${(want.priceMicro / 1e6).toFixed(2)} USDT`);
}

console.log(`\n  ${made} created. The page picks them up on the next load.\n`);
db.close();
