import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../lib/validate.js';
import { ok } from '../lib/respond.js';
import { unauthorized, badRequest } from '../lib/errors.js';
import { createRateLimiter, clientIp } from '../lib/ratelimit.js';
import {
  login,
  logout,
  requireAdmin,
  changePassword,
  beginTotpEnrolment,
  confirmTotpEnrolment,
  disableTotp,
  twoFactorState,
} from '../auth/admin.js';
import { EVENT, recordEvent } from '../domain/events.js';
import { config } from '../config.js';
import { logger } from '../logger.js';

const loginSchema = z.object({
  username: z.string().trim().min(1).max(64),
  password: z.string().min(1).max(256),
  // A one-time code or a recovery code. Absent on the first attempt, which is
  // how the console learns the account has a second factor at all.
  code: z.string().trim().min(6).max(32).optional(),
});

const codeSchema = z.object({ code: z.string().trim().min(6).max(32) });

const disableSchema = z.object({
  password: z.string().min(1).max(256),
  code: z.string().trim().min(6).max(32).optional(),
});

const passwordSchema = z.object({
  currentPassword: z.string().min(1).max(256),
  newPassword: z.string().min(12).max(256),
});

export function authRoutes({ db }) {
  const router = Router();
  const limiter = createRateLimiter({
    ...config.rateLimit.login,
    // Per-IP and per-username, so one account cannot be brute forced from a pool.
    keyFn: (req) => `${clientIp(req)}:${String(req.body?.username || '').slice(0, 64)}`,
  });

  router.post('/login', limiter, validate(loginSchema), (req, res, next) => {
    const session = login(db, {
      username: req.body.username,
      password: req.body.password,
      code: req.body.code,
      userAgent: req.get('user-agent'),
    });
    // The password was right and the account has a second factor. Said plainly
    // so the console can ask for the code, and no more plainly than that: the
    // caller already proved they know the password to get here.
    if (session?.needsCode) {
      return res.status(401).json({
        error: { code: 'TOTP_REQUIRED', message: 'This account needs a one-time code' },
      });
    }
    if (!session) {
      recordEvent(db, {
        type: EVENT.ADMIN_LOGIN_FAILED, severity: 'warning',
        message: `Failed admin login for "${req.body.username}"`,
        data: { ip: clientIp(req) },
      });
      logger.warn('admin login failed', { username: req.body.username, ip: clientIp(req) });
      return next(unauthorized('Invalid credentials'));
    }
    return ok(res, {
      token: session.token,
      expiresAt: new Date(session.expiresAt).toISOString(),
      admin: session.admin,
    });
  });

  router.post('/logout', requireAdmin(db), (req, res) => {
    logout(db, req.sessionToken);
    return ok(res, { loggedOut: true });
  });

  router.get('/me', requireAdmin(db), (req, res) => ok(res, { admin: req.admin }));

  router.post('/password', requireAdmin(db), validate(passwordSchema), (req, res, next) => {
    const check = login(db, { username: req.admin.username, password: req.body.currentPassword });
    if (!check) return next(unauthorized('Current password is incorrect'));
    if (req.body.newPassword === req.body.currentPassword) {
      return next(badRequest('New password must differ from the current one'));
    }
    changePassword(db, req.admin.id, req.body.newPassword);
    return ok(res, { changed: true, sessionsRevoked: true });
  });

  /**
   * Two-factor enrolment, in two steps on purpose.
   *
   * A secret issued and switched on in one call would let a mistyped or
   * mis-scanned secret lock the only account that can reach the fleet out of
   * it. The secret is stored but dormant until a code proves the authenticator
   * really holds it.
   */
  router.get('/totp', requireAdmin(db), (req, res) => ok(res, twoFactorState(db, req.admin.id)));

  router.post('/totp/setup', requireAdmin(db), (req, res, next) => {
    const started = beginTotpEnrolment(db, req.admin.id, config.admin.totpIssuer);
    if (!started) return next(unauthorized('Unknown admin'));
    if (started.alreadyEnabled) return next(badRequest('Two-factor is already on'));
    recordEvent(db, {
      type: 'admin.totp_enrolment_started', severity: 'warning',
      message: `${req.admin.username} started two-factor enrolment`,
    });
    return ok(res, started);
  });

  router.post('/totp/confirm', requireAdmin(db), limiter, validate(codeSchema), (req, res, next) => {
    const confirmed = confirmTotpEnrolment(db, req.admin.id, req.body.code);
    if (!confirmed) return next(badRequest('That code did not match — check the clock on the phone'));
    recordEvent(db, {
      type: 'admin.totp_enabled', severity: 'warning',
      message: `${req.admin.username} switched two-factor on`,
    });
    logger.info('admin two-factor enabled', { username: req.admin.username });
    // The one time these are readable. They are stored hashed.
    return ok(res, confirmed);
  });

  router.post('/totp/disable', requireAdmin(db), limiter, validate(disableSchema), (req, res, next) => {
    const done = disableTotp(db, req.admin.id, req.body.password, req.body.code);
    if (!done) return next(unauthorized('Password or code is wrong'));
    recordEvent(db, {
      type: 'admin.totp_disabled', severity: 'critical',
      message: `${req.admin.username} switched two-factor off`,
    });
    logger.warn('admin two-factor disabled', { username: req.admin.username });
    return ok(res, { enabled: false });
  });

  return router;
}
