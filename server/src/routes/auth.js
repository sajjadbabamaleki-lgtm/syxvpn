import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../lib/validate.js';
import { ok } from '../lib/respond.js';
import { unauthorized, badRequest } from '../lib/errors.js';
import { createRateLimiter, clientIp } from '../lib/ratelimit.js';
import { login, logout, requireAdmin, changePassword } from '../auth/admin.js';
import { EVENT, recordEvent } from '../domain/events.js';
import { config } from '../config.js';
import { logger } from '../logger.js';

const loginSchema = z.object({
  username: z.string().trim().min(1).max(64),
  password: z.string().min(1).max(256),
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
      userAgent: req.get('user-agent'),
    });
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

  return router;
}
