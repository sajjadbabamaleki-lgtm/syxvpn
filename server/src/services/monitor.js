import { config } from '../config.js';
import { logger } from '../logger.js';
import { listGateways } from '../domain/gateways.js';
import { checkGatewayIngress, sweepStaleReports } from '../domain/health.js';
import { reevaluateAll } from '../domain/routing.js';
import { enforceEntitlements, sweepCredentials } from '../domain/subscribers.js';
import { pruneEvents, pruneHealthChecks } from '../domain/events.js';
import { sweepSessions } from '../auth/admin.js';

/**
 * Periodic control-plane work: ingress probing, staleness expiry, entitlement
 * enforcement and route re-evaluation. Everything it does is idempotent, so a
 * missed tick only delays convergence.
 */
export function startMonitor(db, cfg = config) {
  let running = false;
  let timer = null;

  async function tick() {
    if (running) return;
    running = true;
    try {
      for (const gateway of listGateways(db)) {
        if (gateway.enabled !== 1) continue;
        await checkGatewayIngress(db, gateway);
      }
      sweepStaleReports(db);
      sweepCredentials(db);
      enforceEntitlements(db);
      const switched = reevaluateAll(db, 'monitor');
      if (switched.length) logger.info('routes re-evaluated', { switched: switched.length });
      sweepSessions(db);
      pruneEvents(db);
      pruneHealthChecks(db);
    } catch (err) {
      logger.error('monitor tick failed', { message: err.message });
    } finally {
      running = false;
    }
  }

  timer = setInterval(tick, Math.max(15, cfg.health.intervalSeconds) * 1000);
  timer.unref?.();
  // First pass shortly after boot so the dashboard is not empty for a minute.
  const kickoff = setTimeout(tick, 2000);
  kickoff.unref?.();

  return {
    tick,
    stop() {
      clearInterval(timer);
      clearTimeout(kickoff);
    },
  };
}
