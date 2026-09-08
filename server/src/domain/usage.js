import { EVENT, recordEvent } from './events.js';
import { bumpAllConfigVersions } from './gateways.js';
import { logger } from '../logger.js';

/**
 * Usage accounting.
 *
 * Gateway agents read Xray's per-user counters (`user>>><email>>>>traffic>>>…`)
 * *without* resetting them and post the cumulative values. The control plane
 * derives deltas from the last value it saw for that (gateway, credential,
 * direction) triple, so:
 *   - a replayed or duplicated report cannot double count (report_id is unique),
 *   - a lost report is recovered on the next one (cumulative, not incremental),
 *   - an Xray restart is detected as a counter reset rather than a huge delta.
 */

// Defensive ceiling for a single counter delta (1 TiB). A larger jump is far
// more likely to be a bug or a hostile agent than real traffic.
const MAX_DELTA_BYTES = 1024 ** 4;

export function ingestUsageReport(db, gatewayId, { reportId, counters }) {
  const now = Date.now();

  const duplicate = db.prepare('SELECT 1 FROM usage_reports WHERE gateway_id=? AND report_id=?')
    .get(gatewayId, reportId);
  if (duplicate) return { duplicate: true, accepted: 0, appliedBytes: 0 };

  const credentialRows = db.prepare(
    'SELECT id, subscriber_id FROM credentials WHERE id IN (SELECT value FROM json_each(?))',
  ).all(JSON.stringify(counters.map((c) => c.credentialId)));
  const owner = new Map(credentialRows.map((r) => [r.id, r.subscriber_id]));

  const touchedSubscribers = new Set();
  let appliedBytes = 0;
  let accepted = 0;
  let clamped = 0;

  const apply = db.transaction(() => {
    for (const counter of counters) {
      const subscriberId = owner.get(counter.credentialId);
      // Counters for credentials the control plane does not know (revoked and
      // pruned, or an agent running an old config) are dropped, not guessed.
      if (!subscriberId) continue;

      for (const direction of ['uplink', 'downlink']) {
        const value = Math.max(0, Math.floor(Number(counter[direction]) || 0));
        const prev = db.prepare(
          'SELECT last_cumulative FROM usage_counters WHERE gateway_id=? AND credential_id=? AND direction=?',
        ).get(gatewayId, counter.credentialId, direction);
        const last = prev?.last_cumulative ?? 0;
        // value < last means the Xray process restarted and the counter reset.
        let delta = value >= last ? value - last : value;
        if (delta > MAX_DELTA_BYTES) { delta = MAX_DELTA_BYTES; clamped += 1; }

        db.prepare(`INSERT INTO usage_counters (gateway_id,credential_id,direction,last_cumulative,updated_at)
            VALUES (?,?,?,?,?)
            ON CONFLICT(gateway_id,credential_id,direction)
            DO UPDATE SET last_cumulative=excluded.last_cumulative, updated_at=excluded.updated_at`)
          .run(gatewayId, counter.credentialId, direction, value, now);

        if (delta > 0) {
          db.prepare(`INSERT INTO usage_events (subscriber_id,gateway_id,credential_id,direction,bytes,created_at)
              VALUES (?,?,?,?,?,?)`)
            .run(subscriberId, gatewayId, counter.credentialId, direction, delta, now);
          db.prepare('UPDATE subscribers SET used_bytes = used_bytes + ?, updated_at = ? WHERE id = ?')
            .run(delta, now, subscriberId);
          appliedBytes += delta;
          touchedSubscribers.add(subscriberId);
        }
      }
      accepted += 1;
    }

    db.prepare('INSERT INTO usage_reports (gateway_id,report_id,received_at,accepted_bytes,counter_count) VALUES (?,?,?,?,?)')
      .run(gatewayId, reportId, now, appliedBytes, accepted);
  });
  apply();

  if (clamped) {
    logger.warn('usage counter delta clamped', { gatewayId, clamped });
    recordEvent(db, {
      type: 'usage.clamped', severity: 'warning', targetType: 'gateway', targetId: gatewayId,
      message: `${clamped} usage counter(s) exceeded the per-report ceiling and were clamped`,
    });
  }

  // A subscriber that just crossed its quota must lose data-plane access now.
  let exhausted = 0;
  for (const subscriberId of touchedSubscribers) {
    const sub = db.prepare('SELECT * FROM subscribers WHERE id=?').get(subscriberId);
    if (!sub || sub.quota_bytes <= 0 || sub.used_bytes < sub.quota_bytes) continue;
    const already = db.prepare(
      "SELECT 1 FROM events WHERE type=? AND target_id=? AND created_at > ?",
    ).get(EVENT.QUOTA_EXHAUSTED, subscriberId, now - 86400000);
    if (already) continue;
    recordEvent(db, {
      type: EVENT.QUOTA_EXHAUSTED, severity: 'warning', targetType: 'subscriber', targetId: subscriberId,
      message: `Subscriber ${sub.name} exhausted quota`,
      data: { usedBytes: sub.used_bytes, quotaBytes: sub.quota_bytes },
    });
    exhausted += 1;
  }
  if (exhausted) bumpAllConfigVersions(db, 'quota-exhausted');

  return { duplicate: false, accepted, appliedBytes, exhausted };
}

export function totalUsage(db, sinceMs) {
  const row = db.prepare('SELECT COALESCE(SUM(bytes),0) AS total FROM usage_events WHERE created_at >= ?')
    .get(sinceMs);
  return row.total;
}

/** Clears counter state for a gateway, e.g. after a gateway rebuild. */
export function resetGatewayCounters(db, gatewayId) {
  db.prepare('DELETE FROM usage_counters WHERE gateway_id = ?').run(gatewayId);
}
