import { isReality } from './xray.js';

/**
 * Things about the shape of the fleet that no single gateway can notice.
 *
 * Every health check here asks about one machine: is it up, can it reach the
 * internet, is its agent reporting. All of those can be green while the fleet
 * as a whole is arranged in a way that gets it blocked — and nothing was
 * looking at the arrangement.
 *
 * These are advisories, not errors. Each one names what it found and why it
 * matters; none of them stops anything from working today, which is exactly
 * why they need saying out loud.
 */

const groupBy = (rows, key) => {
  const out = new Map();
  for (const row of rows) {
    const value = key(row);
    if (!value) continue;
    if (!out.has(value)) out.set(value, []);
    out.get(value).push(row);
  }
  return out;
};

export function fleetAdvisories(db) {
  const gateways = db.prepare('SELECT * FROM gateways WHERE enabled = 1 ORDER BY priority, name').all();
  const reality = gateways.filter(isReality);
  const advisories = [];

  // A private key copied between gateways means one seized machine hands over
  // the others. The control plane issues a pair per gateway, so this can only
  // be a key someone pasted — which is why it is worth catching rather than
  // assuming impossible.
  for (const [, shared] of groupBy(reality, (g) => g.reality_public_key)) {
    if (shared.length < 2) continue;
    advisories.push({
      code: 'reality-key-reused',
      severity: 'critical',
      message: `${shared.map((g) => g.name).join(', ')} share one REALITY key pair. `
        + 'Seizing any one of them exposes the others. Re-register each with its own key.',
      gatewayIds: shared.map((g) => g.id),
    });
  }

  // Borrowing the same site everywhere turns the disguise into the thing that
  // identifies you: "TLS to www.microsoft.com from a VPS that hosts nothing
  // else" is a pattern, and it is the same pattern on every address you own.
  for (const [dest, shared] of groupBy(reality, (g) => g.reality_dest)) {
    if (shared.length < 2) continue;
    advisories.push({
      code: 'reality-dest-shared',
      severity: 'warning',
      message: `${shared.length} gateways borrow ${dest}. One site across the fleet is a `
        + 'fingerprint of its own — give each gateway a different one.',
      gatewayIds: shared.map((g) => g.id),
    });
  }

  // A subscriber's share of the fleet spans regions before it doubles up, and
  // it cannot span what is not there.
  const regions = new Set(gateways.map((g) => g.region).filter(Boolean));
  if (gateways.length > 1 && regions.size === 1) {
    advisories.push({
      code: 'single-region',
      severity: 'warning',
      message: `Every gateway is in ${[...regions][0]}. One decision there takes all of them, `
        + 'and no subscriber has anywhere else to try.',
      gatewayIds: gateways.map((g) => g.id),
    });
  }

  // Every gateway on one address is one route away from all of them, whatever
  // the transports say.
  for (const [host, shared] of groupBy(gateways, (g) => g.host)) {
    if (shared.length < 2) continue;
    advisories.push({
      code: 'shared-address',
      severity: 'warning',
      message: `${shared.map((g) => g.name).join(', ')} are all on ${host}. `
        + 'Blocking that address blocks every one of them at once.',
      gatewayIds: shared.map((g) => g.id),
    });
  }

  const order = { critical: 0, warning: 1, info: 2 };
  return advisories.sort((a, b) => order[a.severity] - order[b.severity]);
}
