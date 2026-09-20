import { Router } from 'express';
import { z } from 'zod';
import { createRateLimiter, clientIp } from '../lib/ratelimit.js';
import { validate } from '../lib/validate.js';
import { ok, fail } from '../lib/respond.js';
import { clientProfile } from '../domain/xray.js';
import { gatewaysFor } from './public.js';
import { leaseGuestSession, guestStanding, guestCredentials } from '../domain/guests.js';
import { logger } from '../logger.js';

/**
 * The switch, before the account.
 *
 * Open to the internet with no credential of any kind, which is the point and
 * also the risk, so everything here is bounded: a short session, a count per
 * device, a fleet-wide ceiling for the day, and a rate limit per address on top
 * of all three. Nothing it returns is worth stealing for longer than a few
 * minutes.
 */

const deviceSchema = z.object({
  // The app's own identifier. Long enough not to collide, short enough that
  // nobody can push anything interesting through it; never read as anything
  // but an opaque string, and stored only as a hash.
  deviceId: z.string().min(16).max(128),
});

export function guestRoutes({ db }) {
  const router = Router();

  /**
   * Loose, and deliberately not the thing holding this endpoint up.
   *
   * On the networks this serves, an address is not a person: Iranian mobile
   * carriers put very large numbers of subscribers behind one public address,
   * so a limit tight enough to stop one abuser would lock out everybody who
   * happens to share their carrier. The bounds that hold are the per-device
   * count and the day's ceiling, both of which survive a shared address.
   *
   * What is left here is the narrow job a rate limit is actually good at:
   * stopping a loop hammering the endpoint faster than any person could press
   * a switch.
   */
  const limiter = createRateLimiter({
    windowMs: 60000,
    max: 30,
    keyFn: (req) => `guest:${clientIp(req)}`,
  });

  router.use(limiter);

  /** What is on offer, and what this device has left of it. */
  router.get('/standing', (req, res) => {
    const deviceId = typeof req.query.deviceId === 'string' ? req.query.deviceId : null;
    return ok(res, { guest: guestStanding(db, deviceId) });
  });

  /**
   * One session: a config that works now and stops on its own.
   *
   * No subscription URL and no token. A guest has nothing to come back to —
   * the next session is another lease — and handing out a durable URL for
   * something meant to last three minutes would be handing out the thing the
   * limit exists to meter.
   */
  router.post('/session', validate(deviceSchema), (req, res) => {
    const lease = leaseGuestSession(db, req.body.deviceId);
    if (!lease.ok) {
      const status = lease.reason === 'busy' ? 429 : 403;
      logger.info('guest session refused', { reason: lease.reason, ip: clientIp(req) });
      return fail(res, status, `GUEST_${lease.reason.toUpperCase()}`, refusal(lease.reason), {
        reason: lease.reason,
        sessionsLeft: lease.sessionsLeft ?? 0,
      });
    }

    const credentials = guestCredentials(db, lease.subscriberId);
    const profiles = gatewaysFor(db, lease.subscriberId)
      .flatMap(({ gateway, state: routeState }) => credentials.map((credential) => ({
        gatewayId: gateway.id,
        gatewayName: gateway.name,
        region: gateway.region,
        routeState,
        protocol: 'vless',
        label: `${gateway.name} · ${gateway.region}`,
        uri: clientProfile(gateway, credential.uuid),
      })));

    if (profiles.length === 0) {
      // Nothing to hand over means no gateway can serve anyone right now. Said
      // as our problem, because it is, and the lease is already spent — which
      // is worth knowing rather than hiding behind a generic error.
      logger.warn('guest session had no gateway to offer', { subscriberId: lease.subscriberId });
      return fail(res, 503, 'GUEST_NO_GATEWAY', 'No server is free right now. Try again shortly.');
    }

    return ok(res, {
      expiresAt: new Date(lease.expiresAt).toISOString(),
      secondsLeft: lease.secondsLeft,
      sessionsLeft: lease.sessionsLeft,
      sessionMinutes: lease.sessionMinutes,
      profiles,
    });
  });

  return router;
}

function refusal(reason) {
  if (reason === 'off') return 'Free sessions are not available on this deployment';
  if (reason === 'busy') return 'The free sessions for today are all taken. Make an account to keep going.';
  return 'You have used your free sessions. Make an account to keep going.';
}

