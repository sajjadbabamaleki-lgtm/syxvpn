import { Router } from 'express';
import { ok, fail } from '../lib/respond.js';
import { config } from '../config.js';
import { paymentsConfigured } from '../services/tron.js';

export const VERSION = '0.2.0';

export function metaRoutes({ db, startedAt }) {
  const router = Router();

  // Liveness: the process is running and can serve HTTP.
  router.get('/health', (_req, res) => ok(res, {
    status: 'ok',
    version: VERSION,
    uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
    time: new Date().toISOString(),
  }));

  // Readiness: dependencies the control plane needs in order to be useful.
  router.get('/readiness', (_req, res) => {
    const checks = {};
    let ready = true;
    try {
      db.prepare('SELECT 1 FROM schema_migrations LIMIT 1').get();
      checks.database = 'ok';
    } catch (err) {
      checks.database = `error: ${err.message}`;
      ready = false;
    }
    try {
      checks.admins = db.prepare('SELECT count(*) AS n FROM admins').get().n > 0 ? 'ok' : 'no-admin';
      if (checks.admins !== 'ok') ready = false;
    } catch {
      checks.admins = 'error';
      ready = false;
    }
    // The storefront not being able to take payments is reported, not hidden,
    // but it does not make the control plane unready.
    checks.payments = config.shop.enabled
      ? (paymentsConfigured() ? 'ok' : 'not-configured')
      : 'disabled';

    if (!ready) return fail(res, 503, 'NOT_READY', 'Control plane dependencies unavailable', checks);
    return ok(res, { status: 'ready', checks, version: VERSION });
  });

  return router;
}
