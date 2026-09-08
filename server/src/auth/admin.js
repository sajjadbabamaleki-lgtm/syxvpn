import { config } from '../config.js';
import { logger } from '../logger.js';
import { newId, randomToken, sha256, hashPassword, verifyPassword } from '../lib/crypto.js';
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
      `\n  Jordan control plane bootstrap admin\n    username: ${cfg.admin.username}\n    password: ${cfg.admin.password}\n  (development only — set ADMIN_PASSWORD to pin it)\n\n`,
    );
  }
  logger.info('bootstrap admin created', { username: cfg.admin.username });
  return id;
}

export function login(db, { username, password, userAgent }, cfg = config) {
  const admin = db.prepare('SELECT * FROM admins WHERE username = ?').get(username);
  // Always run a hash comparison so a missing user costs the same as a wrong password.
  const stored = admin?.password_hash || 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
  const okPassword = verifyPassword(password, stored);
  if (!admin || !okPassword) return null;

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
