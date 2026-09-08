import { Router } from 'express';
import { config } from '../config.js';
import { createRateLimiter } from '../lib/ratelimit.js';
import { findByToken, activeCredentials, entitlement } from '../domain/subscribers.js';
import { clientProfile } from '../domain/xray.js';
import { candidatesFor, routeState } from '../domain/routing.js';
import { logger } from '../logger.js';
import { tokenHint } from '../lib/crypto.js';

/**
 * Gateways that a subscriber should currently be pointed at.
 *
 * A gateway is included only when a client can plausibly use it end to end:
 * the gateway must be enabled and reachable, and its selected egress must not
 * be known-broken. An unverified egress is still offered (with the route state
 * exposed in the JSON form) because refusing to hand out any profile is worse
 * for the subscriber than handing out one that may be degraded.
 */
export function usableGateways(db) {
  return db.prepare('SELECT * FROM gateways WHERE enabled = 1 ORDER BY priority, name').all()
    .filter((g) => g.ingress_status === 'online' || g.ingress_status === 'degraded')
    .map((g) => {
      const active = candidatesFor(db, g.id).find((c) => c.id === g.active_egress_id) || null;
      return { gateway: g, active, state: routeState(g, active) };
    })
    .filter((r) => r.state === 'healthy' || r.state === 'degraded' || r.state === 'unverified');
}

export function publicRoutes({ db }) {
  const router = Router();
  const limiter = createRateLimiter({ ...config.rateLimit.subscription });

  router.get('/sub/:token', limiter, (req, res) => {
    const token = String(req.params.token || '');
    const subscriber = token.length >= 20 ? findByToken(db, token) : null;
    const state = entitlement(subscriber);

    if (!state.entitled) {
      // Same response shape for every failure so the endpoint cannot be used to
      // enumerate valid tokens or subscriber states.
      logger.info('subscription rejected', { reason: state.reason, tokenHint: tokenHint(token) });
      res.status(404).type('text/plain').send('subscription unavailable\n');
      return;
    }

    const credentials = activeCredentials(db, subscriber.id);
    const routes = usableGateways(db);
    const profiles = [];
    for (const { gateway, state: routeStateValue } of routes) {
      for (const credential of credentials) {
        // Only the newest credential is advertised; a retiring one stays
        // deployed on the gateway but is not handed out again.
        if (credential.state !== 'active') continue;
        profiles.push({
          gatewayId: gateway.id,
          gatewayName: gateway.name,
          region: gateway.region,
          routeState: routeStateValue,
          uri: clientProfile(gateway, credential.uuid),
        });
      }
    }

    db.prepare('UPDATE subscribers SET last_fetch_at = ?, fetch_count = fetch_count + 1 WHERE id = ?')
      .run(Date.now(), subscriber.id);

    const remaining = subscriber.quota_bytes > 0
      ? Math.max(0, subscriber.quota_bytes - subscriber.used_bytes)
      : null;

    // Standard header understood by v2rayN/NG, Streisand and similar clients.
    res.setHeader(
      'Subscription-Userinfo',
      `upload=0; download=${subscriber.used_bytes}; total=${subscriber.quota_bytes}; expire=${Math.floor(subscriber.expires_at / 1000)}`,
    );
    res.setHeader('Profile-Update-Interval', '6');
    res.setHeader('Cache-Control', 'no-store');

    if (req.query.format === 'json') {
      res.json({
        data: {
          subscriber: {
            id: subscriber.id,
            name: subscriber.name,
            usedBytes: subscriber.used_bytes,
            quotaBytes: subscriber.quota_bytes,
            remainingBytes: remaining,
            expiresAt: new Date(subscriber.expires_at).toISOString(),
          },
          profiles,
          // Honest about what a profile can and cannot promise.
          notice: profiles.length
            ? 'Profiles describe the first hop only. Reachability depends on the network between the client and the gateway.'
            : 'No gateway currently has a usable path. Profiles will reappear when one recovers.',
        },
      });
      return;
    }

    res.type('text/plain; charset=utf-8')
      .send(Buffer.from(profiles.map((p) => p.uri).join('\n')).toString('base64'));
  });

  return router;
}
