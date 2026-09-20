import { config } from '../config.js';
import { sha256 } from '../lib/crypto.js';
import { createSubscriber, activeCredentials } from './subscribers.js';
import { recordEvent } from './events.js';

/**
 * A few minutes of the real tunnel, for somebody who has typed nothing.
 *
 * The question this answers is the only one a new person actually has — does
 * this work from where I am sitting — and no screen can answer it. So the
 * switch works before the account does, for long enough to see traffic move.
 *
 * What it is not: a plan. Three minutes at a time, a handful of times, metered
 * well above what three minutes uses so nothing is cut off mid-demonstration
 * and nothing runs away either.
 *
 * ## What holds it, and what does not
 *
 * The per-device count does not hold against somebody who clears the app's
 * data: the identifier is the app's own, because Android no longer hands out a
 * stable one and a hardware identifier would be a tracking key this project
 * has no business keeping. That is a deliberate trade, not an oversight.
 *
 * What holds is `leasesPerDay`, counted across every device at once. It bounds
 * the giveaway's whole cost in a day however many identifiers somebody
 * invents, and it is the setting to reach for if the usage graph ever looks
 * wrong — not a cleverer fingerprint, which would lose the argument anyway and
 * cost the project something it would rather not hold.
 */
export const GUEST_NOTE = 'guest — no account';

/** Hashed, so a device identifier is never stored in a form a leak could reuse. */
const deviceKey = (deviceId) => sha256(String(deviceId));

const DAY = 86400000;

/**
 * Grants one session to a device, or says why not.
 *
 * Returns `{ ok: true, ... }`, or `{ ok: false, reason }` where reason is one
 * of `off`, `spent` or `busy`. The caller turns those into something a person
 * reads; they are separate because they mean different things to the person
 * holding the phone — one is permanent, one is theirs, one is ours and passes.
 */
export function leaseGuestSession(db, deviceId) {
  const cfg = config.guest;
  if (!cfg.enabled || cfg.sessionsPerDevice <= 0 || cfg.sessionMinutes <= 0) {
    return { ok: false, reason: 'off' };
  }

  const now = Date.now();
  const id = deviceKey(deviceId);

  // The rolling window, kept swept here rather than by a job: this is the only
  // thing that writes to the table, so it is the only thing that has to.
  db.prepare('DELETE FROM guest_leases WHERE created_at < ?').run(now - 2 * DAY);

  const device = db.prepare('SELECT * FROM guest_devices WHERE id = ?').get(id);
  if (device && device.sessions_used >= cfg.sessionsPerDevice) {
    return { ok: false, reason: 'spent', sessionsLeft: 0 };
  }

  const today = db.prepare('SELECT COUNT(*) n FROM guest_leases WHERE created_at >= ?')
    .get(now - DAY).n;
  if (today >= cfg.leasesPerDay) {
    // Ours, not theirs, and it passes — so it is said differently from a spent
    // allowance, and an account is still the way out of it today.
    return { ok: false, reason: 'busy' };
  }

  const expiresAt = now + cfg.sessionMinutes * 60000;
  const sessionBytes = Math.max(1, cfg.sessionMb) * 1024 * 1024;

  let subscriberId = device?.subscriber_id || null;
  // The row is reused across a device's sessions rather than one being made
  // each time: five sessions should leave one subscription behind, not five,
  // and the usage already counted against it is what makes a session that
  // overruns its clock cost the next one.
  const existing = subscriberId
    ? db.prepare("SELECT * FROM subscribers WHERE id = ? AND status = 'active'").get(subscriberId)
    : null;

  if (existing) {
    db.prepare('UPDATE subscribers SET expires_at = ?, quota_bytes = ?, updated_at = ? WHERE id = ?')
      .run(expiresAt, existing.quota_bytes + sessionBytes, now, existing.id);
  } else {
    const created = createSubscriber(db, {
      name: `guest ${id.slice(0, 8)}`,
      quotaBytes: sessionBytes,
      expiresAt,
      note: GUEST_NOTE,
      product: 'vpn',
      // Quiet: a guest arriving is not an event an operator reads a feed for,
      // and at a few hundred a day it would be the only thing in it.
      silent: true,
    });
    subscriberId = created.id;
  }

  const sessionsUsed = (device?.sessions_used || 0) + 1;
  if (device) {
    db.prepare('UPDATE guest_devices SET subscriber_id = ?, sessions_used = ?, last_session_at = ? WHERE id = ?')
      .run(subscriberId, sessionsUsed, now, id);
  } else {
    db.prepare(`INSERT INTO guest_devices (id, subscriber_id, sessions_used, first_seen_at, last_session_at)
        VALUES (?,?,?,?,?)`).run(id, subscriberId, sessionsUsed, now, now);
  }
  db.prepare('INSERT INTO guest_leases (device_id, created_at) VALUES (?,?)').run(id, now);

  // The gateways are told now rather than at the next two-minute poll: three
  // minutes is short enough that a slow rollout would spend most of it. The
  // agent applies a client-list change without restarting Xray, so this costs
  // nobody already connected anything.
  bumpGatewayConfigs(db, now);

  return {
    ok: true,
    subscriberId,
    expiresAt,
    secondsLeft: Math.round((expiresAt - now) / 1000),
    sessionsLeft: Math.max(0, cfg.sessionsPerDevice - sessionsUsed),
    sessionMinutes: cfg.sessionMinutes,
  };
}

/** What a device would be told before it presses anything. */
export function guestStanding(db, deviceId) {
  const cfg = config.guest;
  if (!cfg.enabled || cfg.sessionsPerDevice <= 0 || cfg.sessionMinutes <= 0) return null;
  const device = deviceId
    ? db.prepare('SELECT sessions_used FROM guest_devices WHERE id = ?').get(deviceKey(deviceId))
    : null;
  return {
    sessionMinutes: cfg.sessionMinutes,
    sessionsPerDevice: cfg.sessionsPerDevice,
    sessionsLeft: Math.max(0, cfg.sessionsPerDevice - (device?.sessions_used || 0)),
  };
}

/** The credential UUIDs a guest subscription is served through. */
export function guestCredentials(db, subscriberId) {
  return activeCredentials(db, subscriberId).filter((c) => c.state === 'active');
}

function bumpGatewayConfigs(db, now) {
  db.prepare('UPDATE gateways SET config_version = config_version + 1, updated_at = ? WHERE enabled = 1')
    .run(now);
}

/** For the operator's own reading: what the giveaway has cost lately. */
export function guestUsageToday(db, now = Date.now()) {
  return {
    leases: db.prepare('SELECT COUNT(*) n FROM guest_leases WHERE created_at >= ?').get(now - DAY).n,
    devices: db.prepare('SELECT COUNT(*) n FROM guest_devices').get().n,
    limit: config.guest.leasesPerDay,
  };
}

/** Whether this subscription is a guest one, for screens that must not offer it a plan page. */
export function isGuest(subscriber) {
  return subscriber?.note === GUEST_NOTE;
}

export function recordGuestEvent(db, message, data) {
  recordEvent(db, { type: 'guest.session', targetType: 'guest', targetId: 'guest', message, data });
}
