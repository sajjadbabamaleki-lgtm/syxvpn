import { config } from '../config.js';
import { logger } from '../logger.js';
import { newId, randomToken, sha256, hashPassword, verifyPassword } from '../lib/crypto.js';
import { counterAt, generateRecoveryCodes, generateSecret, provisioningUri, verify as verifyTotp } from '../lib/totp.js';
import { unauthorized } from '../lib/errors.js';

/**
 * Creates the initial administrator if none exists. The password comes from
 * ADMIN_PASSWORD / ADMIN_PASSWORD_HASH; in development a random one is
 * generated and printed once.
 */
export function ensureBootstrapAdmin(db, cfg = config) {
  const existing = db.prepare('SELECT id FROM admins LIMIT 1').get();
  if (existing) return null;
  const now = Date.now();
  const passwordHash = cfg.admin.passwordHash || hashPassword(cfg.admin.password);
  const id = newId('adm');
  db.prepare(
    'INSERT INTO admins (id, username, password_hash, created_at, updated_at) VALUES (?,?,?,?,?)',
  ).run(id, cfg.admin.username, passwordHash, now, now);
  if (cfg.admin.generatedPassword) {
    // Development only: the operator has no other way to learn this value.
    process.stdout.write(
      `\n  cVPN control plane bootstrap admin\n    username: ${cfg.admin.username}\n    password: ${cfg.admin.password}\n  (development only — set ADMIN_PASSWORD to pin it)\n\n`,
    );
  }
  logger.info('bootstrap admin created', { username: cfg.admin.username });
  return id;
}

/**
 * Signs an admin in.
 *
 * Returns null for a wrong username or password, and `{ needsCode: true }` when
 * the password was right but the account has a second factor and no code was
 * given — a different answer on purpose, because the caller has to ask for the
 * code, and because by then the password is already known to be correct.
 */
export function login(db, { username, password, code, userAgent }, cfg = config) {
  const admin = db.prepare('SELECT * FROM admins WHERE username = ?').get(username);
  // Always run a hash comparison so a missing user costs the same as a wrong password.
  const stored = admin?.password_hash || 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
  const okPassword = verifyPassword(password, stored);
  if (!admin || !okPassword) return null;

  if (admin.totp_confirmed_at) {
    if (!code) return { needsCode: true };
    if (!consumeSecondFactor(db, admin, code)) return null;
  }

  const token = randomToken(32);
  const now = Date.now();
  const expiresAt = now + cfg.admin.sessionTtlSeconds * 1000;
  db.prepare(
    'INSERT INTO admin_sessions (token_hash, admin_id, created_at, expires_at, last_used_at, user_agent) VALUES (?,?,?,?,?,?)',
  ).run(sha256(token), admin.id, now, expiresAt, now, (userAgent || '').slice(0, 200));
  db.prepare('UPDATE admins SET last_login_at = ? WHERE id = ?').run(now, admin.id);
  sweepSessions(db);
  return { token, expiresAt, admin: { id: admin.id, username: admin.username } };
}

export function logout(db, token) {
  if (!token) return;
  db.prepare('DELETE FROM admin_sessions WHERE token_hash = ?').run(sha256(token));
}

export function sweepSessions(db) {
  db.prepare('DELETE FROM admin_sessions WHERE expires_at <= ?').run(Date.now());
}

/**
 * Is this the account's password? Asked where the session is already trusted
 * and only the password is in question — changing it, or taking the second
 * factor off — so it neither mints a session nor spends a one-time code.
 */
export function checkPassword(db, adminId, password) {
  const admin = db.prepare('SELECT password_hash FROM admins WHERE id = ?').get(adminId);
  if (!admin) return false;
  return verifyPassword(password, admin.password_hash);
}

export function changePassword(db, adminId, newPassword) {
  db.prepare('UPDATE admins SET password_hash = ?, updated_at = ? WHERE id = ?')
    .run(hashPassword(newPassword), Date.now(), adminId);
  // Every existing session is invalidated on password change.
  db.prepare('DELETE FROM admin_sessions WHERE admin_id = ?').run(adminId);
}

function bearer(req) {
  const header = req.get('authorization') || '';
  const [scheme, value] = header.split(' ');
  if (!value || scheme.toLowerCase() !== 'bearer') return null;
  return value.trim();
}

/** Express middleware: requires a valid, unexpired admin session. */
export function requireAdmin(db) {
  return (req, _res, next) => {
    const token = bearer(req);
    if (!token) return next(unauthorized('Admin bearer token required'));
    const session = db.prepare('SELECT * FROM admin_sessions WHERE token_hash = ?').get(sha256(token));
    if (!session) return next(unauthorized('Invalid session'));
    if (session.expires_at <= Date.now()) {
      db.prepare('DELETE FROM admin_sessions WHERE token_hash = ?').run(session.token_hash);
      return next(unauthorized('Session expired'));
    }
    const admin = db.prepare('SELECT id, username FROM admins WHERE id = ?').get(session.admin_id);
    if (!admin) return next(unauthorized('Invalid session'));
    db.prepare('UPDATE admin_sessions SET last_used_at = ? WHERE token_hash = ?').run(Date.now(), session.token_hash);
    req.admin = admin;
    req.sessionToken = token;
    return next();
  };
}

/**
 * Accepts a code once — a time-based one or a recovery code — or refuses it.
 *
 * A time-based code stays valid for its whole step, so the counter it matched
 * is recorded and anything at or before it is refused afterwards: a code read
 * over a shoulder, or replayed out of a proxy log, is spent.
 */
export function consumeSecondFactor(db, admin, code, now = Date.now()) {
  const counter = admin.totp_secret ? verifyTotp(admin.totp_secret, code, { at: now }) : null;
  if (counter !== null) {
    if (admin.totp_last_counter !== null && counter <= admin.totp_last_counter) return false;
    db.prepare('UPDATE admins SET totp_last_counter = ? WHERE id = ?').run(counter, admin.id);
    return true;
  }
  return consumeRecoveryCode(db, admin.id, code, now);
}

/** Spends a recovery code. Each exists once and is gone after it is used. */
export function consumeRecoveryCode(db, adminId, code, now = Date.now()) {
  const cleaned = String(code || '').trim().toLowerCase();
  if (!cleaned) return false;
  const row = db
    .prepare('SELECT code_hash FROM admin_recovery_codes WHERE admin_id = ? AND code_hash = ? AND used_at IS NULL')
    .get(adminId, sha256(cleaned));
  if (!row) return false;
  db.prepare('UPDATE admin_recovery_codes SET used_at = ? WHERE code_hash = ?').run(now, row.code_hash);
  return true;
}

/**
 * Starts enrolment: a secret that is not in force until a code proves the
 * authenticator holds it. Enrolling in one step would let a mistyped secret
 * lock the account out of the fleet.
 */
export function beginTotpEnrolment(db, adminId, issuer = 'cVPN') {
  const admin = db.prepare('SELECT id, username, totp_confirmed_at FROM admins WHERE id = ?').get(adminId);
  if (!admin) return null;
  if (admin.totp_confirmed_at) return { alreadyEnabled: true };
  const secret = generateSecret();
  db.prepare('UPDATE admins SET totp_secret = ?, totp_confirmed_at = NULL, updated_at = ? WHERE id = ?')
    .run(secret, Date.now(), adminId);
  return { secret, uri: provisioningUri({ secret, account: admin.username, issuer }) };
}

/**
 * Turns the second factor on, once a code from the enrolled secret arrives,
 * and returns the recovery codes — the only time they are readable.
 */
export function confirmTotpEnrolment(db, adminId, code, now = Date.now()) {
  const admin = db.prepare('SELECT * FROM admins WHERE id = ?').get(adminId);
  if (!admin || !admin.totp_secret || admin.totp_confirmed_at) return null;
  const counter = verifyTotp(admin.totp_secret, code, { at: now });
  if (counter === null) return null;

  const codes = generateRecoveryCodes();
  const insert = db.prepare('INSERT INTO admin_recovery_codes (code_hash, admin_id, created_at) VALUES (?,?,?)');
  db.transaction(() => {
    db.prepare('DELETE FROM admin_recovery_codes WHERE admin_id = ?').run(adminId);
    codes.forEach((value) => insert.run(sha256(value), adminId, now));
    db.prepare('UPDATE admins SET totp_confirmed_at = ?, totp_last_counter = ?, updated_at = ? WHERE id = ?')
      .run(now, counter, now, adminId);
  })();
  return { recoveryCodes: codes };
}

/**
 * Turns it off. The password is required again here: a borrowed session should
 * not be able to remove the factor that makes the session hard to borrow.
 */
export function disableTotp(db, adminId, password, code, now = Date.now()) {
  const admin = db.prepare('SELECT * FROM admins WHERE id = ?').get(adminId);
  if (!admin || !verifyPassword(password, admin.password_hash)) return false;
  if (admin.totp_confirmed_at && !consumeSecondFactor(db, admin, code, now)) return false;
  db.transaction(() => {
    db.prepare('DELETE FROM admin_recovery_codes WHERE admin_id = ?').run(adminId);
    db.prepare(
      'UPDATE admins SET totp_secret = NULL, totp_confirmed_at = NULL, totp_last_counter = NULL, updated_at = ? WHERE id = ?',
    ).run(now, adminId);
  })();
  return true;
}

/** What the console shows about the second factor, with nothing secret in it. */
export function twoFactorState(db, adminId) {
  const admin = db
    .prepare('SELECT totp_secret, totp_confirmed_at FROM admins WHERE id = ?')
    .get(adminId);
  if (!admin) return null;
  const unused = db
    .prepare('SELECT count(*) AS n FROM admin_recovery_codes WHERE admin_id = ? AND used_at IS NULL')
    .get(adminId).n;
  return {
    enabled: Boolean(admin.totp_confirmed_at),
    enrolmentStarted: Boolean(admin.totp_secret) && !admin.totp_confirmed_at,
    recoveryCodesLeft: unused,
  };
}
