import crypto from 'node:crypto';
import { newId, randomToken, sha256 } from '../lib/crypto.js';
import { seal, open as openSecret } from '../lib/secretbox.js';
import { EVENT, recordEvent } from './events.js';
import { bumpAllConfigVersions } from './gateways.js';

export const GB = 1024 ** 3;

/** A subscriber may receive profiles only while all three conditions hold. */
export function entitlement(subscriber, now = Date.now()) {
  if (!subscriber) return { entitled: false, reason: 'not-found' };
  if (subscriber.status !== 'active') return { entitled: false, reason: 'disabled' };
  if (subscriber.expires_at <= now) return { entitled: false, reason: 'expired' };
  if (subscriber.quota_bytes > 0 && subscriber.used_bytes >= subscriber.quota_bytes) {
    return { entitled: false, reason: 'quota-exhausted' };
  }
  return { entitled: true, reason: 'active' };
}

export function createSubscriber(db, {
  name, quotaBytes, expiresAt, note = null, customerId = null, batchId = null, silent = false,
  product = 'all',
}) {
  const now = Date.now();
  const id = newId('sub');
  const token = randomToken(32);
  const credentialId = newId('cr');
  const insert = db.transaction(() => {
    db.prepare(`INSERT INTO subscribers
        (id,name,token_hash,token_prefix,token_enc,quota_bytes,used_bytes,expires_at,status,note,created_at,updated_at,customer_id,batch_id,product)
        VALUES (?,?,?,?,?,?,0,?, 'active', ?,?,?,?,?,?)`)
      .run(id, name, sha256(token), token.slice(0, 6), seal(token), quotaBytes, expiresAt, note,
        now, now, customerId, batchId, product);
    db.prepare('INSERT INTO credentials (id,subscriber_id,uuid,state,created_at) VALUES (?,?,?,\'active\',?)')
      .run(credentialId, id, crypto.randomUUID(), now);
    // A bulk run records one event for the batch rather than a hundred.
    if (!silent) {
      recordEvent(db, {
        type: EVENT.SUBSCRIBER_CREATED, targetType: 'subscriber', targetId: id,
        message: `Subscriber ${name} created`,
        data: { quotaBytes, expiresAt: new Date(expiresAt).toISOString() },
      });
      bumpAllConfigVersions(db, 'subscriber-created');
    }
  });
  insert();
  return { id, token };
}

/**
 * Issues many subscriptions in one pass.
 *
 * The whole run is a single transaction and a single config-version bump, so
 * handing out a day's worth of configs costs the data plane one update instead
 * of one per subscriber.
 */
export function createSubscriberBatch(db, { count, namePrefix, quotaBytes, durationDays, note = null }) {
  const now = Date.now();
  const batchId = `batch_${new Date(now).toISOString().slice(0, 10)}_${randomToken(4)}`;
  const expiresAt = now + durationDays * 86400000;
  const created = [];

  const run = db.transaction(() => {
    for (let index = 1; index <= count; index += 1) {
      const name = `${namePrefix}-${String(index).padStart(3, '0')}`;
      const { id, token } = createSubscriber(db, {
        name, quotaBytes, expiresAt, note, batchId, silent: true,
      });
      created.push({ id, name, token });
    }
    recordEvent(db, {
      type: EVENT.SUBSCRIBER_CREATED, targetType: 'batch', targetId: batchId,
      message: `${count} subscriptions issued in batch ${batchId}`,
      data: { count, quotaBytes, durationDays },
    });
    bumpAllConfigVersions(db, 'subscriber-batch');
  });
  run();

  return { batchId, expiresAt, created };
}

export function listBatches(db) {
  return db.prepare(`SELECT batch_id AS batchId,
        count(*) AS total,
        SUM(CASE WHEN status = 'active' AND expires_at > ? AND (quota_bytes <= 0 OR used_bytes < quota_bytes)
                 THEN 1 ELSE 0 END) AS active,
        MIN(created_at) AS createdAt,
        MAX(quota_bytes) AS quotaBytes,
        MAX(expires_at) AS expiresAt
      FROM subscribers WHERE batch_id IS NOT NULL
      GROUP BY batch_id ORDER BY createdAt DESC LIMIT 100`).all(Date.now());
}

export function subscribersInBatch(db, batchId) {
  return db.prepare('SELECT * FROM subscribers WHERE batch_id = ? ORDER BY name').all(batchId);
}

export function getSubscriber(db, id) {
  return db.prepare('SELECT * FROM subscribers WHERE id = ?').get(id) || null;
}

export function findByToken(db, token) {
  return db.prepare('SELECT * FROM subscribers WHERE token_hash = ?').get(sha256(token)) || null;
}

export function activeCredentials(db, subscriberId) {
  return db.prepare(
    "SELECT * FROM credentials WHERE subscriber_id = ? AND state IN ('active','retiring') ORDER BY created_at DESC",
  ).all(subscriberId);
}

export function updateSubscriber(db, id, patch) {
  const current = getSubscriber(db, id);
  if (!current) return null;
  const fields = [];
  const params = [];
  const map = { name: 'name', quotaBytes: 'quota_bytes', expiresAt: 'expires_at', status: 'status', note: 'note' };
  for (const [key, column] of Object.entries(map)) {
    if (patch[key] !== undefined) { fields.push(`${column} = ?`); params.push(patch[key]); }
  }
  if (!fields.length) return current;
  params.push(Date.now(), id);
  const apply = db.transaction(() => {
    db.prepare(`UPDATE subscribers SET ${fields.join(', ')}, updated_at = ? WHERE id = ?`).run(...params);
    if (patch.status && patch.status !== current.status) {
      recordEvent(db, {
        type: patch.status === 'disabled' ? EVENT.SUBSCRIBER_DISABLED : EVENT.SUBSCRIBER_ENABLED,
        severity: 'info', targetType: 'subscriber', targetId: id,
        message: `Subscriber ${current.name} ${patch.status === 'disabled' ? 'disabled' : 'enabled'}`,
      });
    }
    // Any entitlement-affecting change must reach the data plane.
    bumpAllConfigVersions(db, 'subscriber-updated');
  });
  apply();
  return getSubscriber(db, id);
}

export function deleteSubscriber(db, id) {
  const sub = getSubscriber(db, id);
  if (!sub) return false;
  const run = db.transaction(() => {
    db.prepare('DELETE FROM subscribers WHERE id = ?').run(id);
    recordEvent(db, {
      type: EVENT.SUBSCRIBER_DISABLED, targetType: 'subscriber', targetId: id,
      message: `Subscriber ${sub.name} deleted`,
    });
    bumpAllConfigVersions(db, 'subscriber-deleted');
  });
  run();
  return true;
}

/** Invalidates the old subscription URL immediately. */
export function rotateToken(db, id) {
  const sub = getSubscriber(db, id);
  if (!sub) return null;
  const token = randomToken(32);
  const run = db.transaction(() => {
    db.prepare('UPDATE subscribers SET token_hash = ?, token_prefix = ?, token_enc = ?, updated_at = ? WHERE id = ?')
      .run(sha256(token), token.slice(0, 6), seal(token), Date.now(), id);
    recordEvent(db, {
      type: EVENT.TOKEN_ROTATED, severity: 'warning', targetType: 'subscriber', targetId: id,
      message: `Subscription URL rotated for ${sub.name}; the previous URL no longer resolves`,
    });
  });
  run();
  return token;
}

/**
 * Issues a fresh VLESS credential.
 *
 * With `graceMs > 0` the previous credential is marked `retiring` and stays
 * deployed for that period, so a subscriber who has not yet refreshed their
 * subscription is not cut off mid-session. With grace 0 the old credential is
 * revoked immediately (use after a suspected leak).
 */
export function rotateCredential(db, id, { graceMs = 0 } = {}) {
  const sub = getSubscriber(db, id);
  if (!sub) return null;
  const now = Date.now();
  const credentialId = newId('cr');
  const uuid = crypto.randomUUID();
  const run = db.transaction(() => {
    if (graceMs > 0) {
      db.prepare("UPDATE credentials SET state='retiring', retired_at=? WHERE subscriber_id=? AND state='active'")
        .run(now + graceMs, id);
    } else {
      db.prepare("UPDATE credentials SET state='revoked', revoked_at=? WHERE subscriber_id=? AND state IN ('active','retiring')")
        .run(now, id);
    }
    db.prepare("INSERT INTO credentials (id,subscriber_id,uuid,state,created_at) VALUES (?,?,?,'active',?)")
      .run(credentialId, id, uuid, now);
    recordEvent(db, {
      type: EVENT.CREDENTIAL_ROTATED, severity: 'warning', targetType: 'subscriber', targetId: id,
      message: `Credential rotated for ${sub.name}${graceMs > 0 ? ' with grace period' : ' immediately'}`,
      data: { graceMs },
    });
    bumpAllConfigVersions(db, 'credential-rotated');
  });
  run();
  return { credentialId, uuid };
}

/** Expires retiring credentials whose grace period has elapsed. */
export function sweepCredentials(db, now = Date.now()) {
  const stale = db.prepare("SELECT id FROM credentials WHERE state='retiring' AND retired_at <= ?").all(now);
  if (!stale.length) return 0;
  db.prepare("UPDATE credentials SET state='revoked', revoked_at=? WHERE state='retiring' AND retired_at <= ?")
    .run(now, now);
  bumpAllConfigVersions(db, 'credential-grace-expired');
  return stale.length;
}

/**
 * Emits expiry/quota events once per subscriber and pushes the entitlement
 * change into the data plane. Returns the number of subscribers that lost
 * entitlement in this pass.
 */
export function enforceEntitlements(db, now = Date.now()) {
  const affected = db.prepare(`
    SELECT * FROM subscribers
    WHERE status = 'active'
      AND (expires_at <= ? OR (quota_bytes > 0 AND used_bytes >= quota_bytes))
  `).all(now);
  let changed = 0;
  for (const sub of affected) {
    const expired = sub.expires_at <= now;
    const type = expired ? EVENT.SUBSCRIBER_EXPIRED : EVENT.QUOTA_EXHAUSTED;
    const already = db.prepare(
      'SELECT 1 FROM events WHERE type = ? AND target_id = ? AND created_at > ?',
    ).get(type, sub.id, sub.updated_at);
    if (already) continue;
    recordEvent(db, {
      type, severity: 'warning', targetType: 'subscriber', targetId: sub.id,
      message: expired
        ? `Subscriber ${sub.name} expired`
        : `Subscriber ${sub.name} exhausted quota (${sub.used_bytes}/${sub.quota_bytes} bytes)`,
    });
    changed += 1;
  }
  if (changed) bumpAllConfigVersions(db, 'entitlement-change');
  return changed;
}

/**
 * Returns the plaintext subscription token for a subscriber.
 *
 * Storefront customers must be able to see their own subscription URL on every
 * visit, so the token is kept sealed with SECRET_KEY alongside its hash. Only
 * the customer-facing API and the owning customer's session can reach this.
 */
export function revealToken(db, subscriberId) {
  const row = db.prepare('SELECT token_enc FROM subscribers WHERE id = ?').get(subscriberId);
  if (!row?.token_enc) return null;
  return openSecret(row.token_enc);
}

/**
 * The subscription a customer holds for one product.
 *
 * `all` is what every subscription sold before the two products were split
 * became, so it answers for either — otherwise the split would have taken half
 * of what somebody paid for away from them.
 */
export function subscriberForCustomer(db, customerId, product = null) {
  if (!product) {
    return db.prepare(
      'SELECT * FROM subscribers WHERE customer_id = ? ORDER BY created_at DESC LIMIT 1',
    ).get(customerId) || null;
  }
  return db.prepare(
    `SELECT * FROM subscribers WHERE customer_id = ? AND product IN (?, 'all')
     ORDER BY CASE product WHEN ? THEN 0 ELSE 1 END, created_at DESC LIMIT 1`,
  ).get(customerId, product, product) || null;
}

/** Every subscription a customer holds, one per product at most. */
export function subscriptionsForCustomer(db, customerId) {
  return db.prepare(
    'SELECT * FROM subscribers WHERE customer_id = ? ORDER BY created_at DESC',
  ).all(customerId);
}

/**
 * Adds quota and time to an existing subscription instead of issuing a second
 * one, so a renewing customer keeps the subscription URL already loaded in
 * their client.
 */
export function topUpSubscriber(db, id, { quotaBytes, durationDays }) {
  const sub = getSubscriber(db, id);
  if (!sub) return null;
  const now = Date.now();
  // Renewing before expiry extends from the current expiry; after expiry, from now.
  const base = Math.max(sub.expires_at, now);
  const expiresAt = base + durationDays * 86400000;
  // Unmetered (0) stays unmetered; otherwise the purchased quota is added on top
  // of what is left, and consumed bytes are reset so the meter reads correctly.
  const quota = sub.quota_bytes <= 0 || quotaBytes <= 0
    ? 0
    : Math.max(0, sub.quota_bytes - sub.used_bytes) + quotaBytes;
  const apply = db.transaction(() => {
    db.prepare(`UPDATE subscribers
        SET quota_bytes = ?, used_bytes = 0, expires_at = ?, status = 'active', updated_at = ?
        WHERE id = ?`).run(quota, expiresAt, now, id);
    bumpAllConfigVersions(db, 'subscription-topped-up');
  });
  apply();
  return getSubscriber(db, id);
}

export function usageSummary(db, subscriberId, limit = 20) {
  return db.prepare(
    'SELECT gateway_id, direction, bytes, created_at FROM usage_events WHERE subscriber_id = ? ORDER BY id DESC LIMIT ?',
  ).all(subscriberId, limit);
}
