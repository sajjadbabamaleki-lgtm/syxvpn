import { useCallback, useEffect, useRef, useState } from 'react';

// Values survive navigation so returning to a screen shows data immediately.
const cache = new Map();

/**
 * Polling data hook built for bad networks:
 *  - shows cached data immediately and marks it stale rather than blanking out
 *  - pauses while the tab is hidden and refreshes on focus
 *  - backs off exponentially while the control plane is unreachable
 */
export function useResource(key, fetcher, { intervalMs = 15000, enabled = true } = {}) {
  const [data, setData] = useState(() => cache.get(key)?.value ?? null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(() => !cache.has(key));
  const [updatedAt, setUpdatedAt] = useState(() => cache.get(key)?.at ?? null);
  const [stale, setStale] = useState(false);

  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const failures = useRef(0);
  const timer = useRef(null);
  const alive = useRef(true);

  const load = useCallback(async ({ quiet = false } = {}) => {
    if (!enabled) return undefined;
    if (!quiet && !cache.has(key)) setLoading(true);
    try {
      const value = await fetcherRef.current();
      if (!alive.current) return undefined;
      cache.set(key, { value, at: Date.now() });
      setData(value);
      setUpdatedAt(Date.now());
      setError(null);
      setStale(false);
      failures.current = 0;
      return value;
    } catch (err) {
      if (!alive.current) return undefined;
      failures.current += 1;
      setError(err);
      // Keep showing the last good value, flagged as stale.
      if (cache.has(key)) setStale(true);
      return undefined;
    } finally {
      if (alive.current) setLoading(false);
    }
  }, [key, enabled]);

  useEffect(() => {
    alive.current = true;
    if (!enabled) return undefined;

    let cancelled = false;
    const schedule = () => {
      clearTimeout(timer.current);
      if (cancelled || document.hidden) return;
      // 15s, 30s, 60s, 120s… capped, while the control plane is unreachable.
      const backoff = Math.min(intervalMs * 2 ** Math.min(failures.current, 3), 120000);
      timer.current = setTimeout(async () => {
        await load({ quiet: true });
        schedule();
      }, failures.current ? backoff : intervalMs);
    };

    load({ quiet: cache.has(key) }).then(schedule);

    const onVisible = () => {
      if (document.hidden) clearTimeout(timer.current);
      else { load({ quiet: true }); schedule(); }
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', onVisible);

    return () => {
      cancelled = true;
      alive.current = false;
      clearTimeout(timer.current);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', onVisible);
    };
  }, [key, load, intervalMs, enabled]);

  // Endpoints that return `{ data, meta }` are unwrapped here so a view can
  // read `data` the same way regardless.
  const envelope = data && typeof data === 'object' && !Array.isArray(data)
    && 'data' in data && 'meta' in data;

  return {
    data: envelope ? data.data : data,
    meta: envelope ? data.meta : undefined,
    error,
    loading,
    stale,
    updatedAt,
    refresh: () => load({ quiet: true }),
  };
}

export function invalidate(prefix) {
  for (const key of [...cache.keys()]) if (key.startsWith(prefix)) cache.delete(key);
}
