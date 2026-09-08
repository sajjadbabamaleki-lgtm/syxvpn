import crypto from 'node:crypto';
import { newId, randomToken, sha256 } from '../lib/crypto.js';
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

export function createSubscriber(db, { name, quotaBytes, expiresAt, note = null }) {
  const now = Date.now();
  const id = newId('sub');
  const token = randomToken(32);
  const credentialId = newId('cr');
  const insert = db.transaction(() => {
    db.prepare(`INSERT INTO subscribers
        (id,name,token_hash,token_prefix,quota_bytes,used_bytes,expires_at,status,note,created_at,updated_at)
        VALUES (?,?,?,?,?,0,?, 'active', ?,?,?)`)
      .run(id, name, sha256(token), token.slice(0, 6), quotaBytes, expiresAt, note, now, now);
    db.prepare('INSERT INTO credentials (id,subscriber_id,uuid,state,created_at) VALUES (?,?,?,\'active\',?)')
      .run(credentialId, id, crypto.randomUUID(), now);
    recordEvent(db, {
      type: EVENT.SUBSCRIBER_CREATED, targetType: 'subscriber', targetId: id,
      message: `Subscriber ${name} created`,
      data: { quotaBytes, expiresAt: new Date(expiresAt).toISOString() },
    });
    bumpAllConfigVersions(db, 'subscriber-created');
  });
  insert();
  return { id, token };
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
    db.prepare('UPDATE subscribers SET token_hash = ?, token_prefix = ?, updated_at = ? WHERE id = ?')
      .run(sha256(token), token.slice(0, 6), Date.now(), id);
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

export function usageSummary(db, subscriberId, limit = 20) {
  return db.prepare(
    'SELECT gateway_id, direction, bytes, created_at FROM usage_events WHERE subscriber_id = ? ORDER BY id DESC LIMIT ?',
  ).all(subscriberId, limit);
}
