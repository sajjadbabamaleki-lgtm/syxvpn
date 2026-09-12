/**
 * The six digits that prove an address belongs to whoever is typing it.
 *
 * One code per address at a time, ten minutes, five guesses, one use. It is
 * issued before anybody knows whether the address has an account — the app
 * takes an address, a password and a code, and which of sign-in and
 * registration that turns out to be is worked out afterwards. Asking first
 * would answer, to anyone with a list of addresses, which of them are
 * customers here.
 */

import crypto from 'node:crypto';
import { sha256, safeEqual } from '../lib/crypto.js';

export const CODE_TTL_MS = 10 * 60 * 1000;
/** How soon a second code may be asked for. A resend button is a free mailer. */
export const CODE_RESEND_MS = 45 * 1000;
const MAX_ATTEMPTS = 5;

const normalize = (email) => String(email).trim().toLowerCase();

/**
 * Issues a code, or says how long the caller has to wait for the next one.
 *
 * @returns {{ code: string, expiresAt: number } | { retryAfterSeconds: number }}
 */
export function issueEmailCode(db, email, now = Date.now()) {
  const address = normalize(email);
  const live = db.prepare('SELECT * FROM email_codes WHERE email = ?').get(address);
  if (live && now - live.created_at < CODE_RESEND_MS) {
    return { retryAfterSeconds: Math.ceil((CODE_RESEND_MS - (now - live.created_at)) / 1000) };
  }

  // randomInt, not Math.random: this is a credential.
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  db.prepare(`INSERT INTO email_codes (email,code_hash,created_at,expires_at,attempts)
      VALUES (?,?,?,?,0)
      ON CONFLICT(email) DO UPDATE SET
        code_hash = excluded.code_hash,
        created_at = excluded.created_at,
        expires_at = excluded.expires_at,
        attempts = 0`)
    .run(address, sha256(code), now, now + CODE_TTL_MS);
  db.prepare('DELETE FROM email_codes WHERE expires_at <= ?').run(now);
  return { code, expiresAt: now + CODE_TTL_MS };
}

/**
 * Spends a code.
 *
 * A wrong guess costs an attempt and the fifth one burns the code, so a
 * six-digit space cannot be walked. A right one deletes the row: a code that
 * has been used is not a code any more, and the same one must not sign in on
 * two devices or register an account and then open it again.
 */
export function verifyEmailCode(db, email, code, now = Date.now()) {
  const address = normalize(email);
  const row = db.prepare('SELECT * FROM email_codes WHERE email = ?').get(address);
  if (!row) return false;
  if (row.expires_at <= now || row.attempts >= MAX_ATTEMPTS) {
    db.prepare('DELETE FROM email_codes WHERE email = ?').run(address);
    return false;
  }
  const given = String(code ?? '').trim();
  if (!safeEqual(sha256(given), row.code_hash)) {
    db.prepare('UPDATE email_codes SET attempts = attempts + 1 WHERE email = ?').run(address);
    return false;
  }
  db.prepare('DELETE FROM email_codes WHERE email = ?').run(address);
  return true;
}

/** Drops a code without spending it — used when the mail itself failed to go. */
export function clearEmailCode(db, email) {
  db.prepare('DELETE FROM email_codes WHERE email = ?').run(normalize(email));
}
