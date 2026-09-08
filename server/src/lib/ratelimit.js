import { tooManyRequests } from './errors.js';

/**
 * Fixed-window counter kept in process memory. Adequate for the single-instance
 * SQLite deployment this control plane targets; a multi-instance deployment
 * needs a shared store (documented in docs/SECURITY.md).
 */
export function createRateLimiter({ windowMs, max, keyFn }) {
  const buckets = new Map();

  const prune = (now) => {
    for (const [k, b] of buckets) if (b.resetAt <= now) buckets.delete(k);
  };

  return function rateLimit(req, res, next) {
    const now = Date.now();
    if (buckets.size > 10_000) prune(now);
    const key = keyFn ? keyFn(req) : clientIp(req);
    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs };
      buckets.set(key, bucket);
    }
    bucket.count += 1;
    const remaining = Math.max(0, max - bucket.count);
    res.setHeader('RateLimit-Limit', String(max));
    res.setHeader('RateLimit-Remaining', String(remaining));
    res.setHeader('RateLimit-Reset', String(Math.ceil((bucket.resetAt - now) / 1000)));
    if (bucket.count > max) {
      const retry = Math.ceil((bucket.resetAt - now) / 1000);
      res.setHeader('Retry-After', String(retry));
      return next(tooManyRequests(retry));
    }
    return next();
  };
}

export function clientIp(req) {
  return req.ip || req.socket?.remoteAddress || 'unknown';
}
