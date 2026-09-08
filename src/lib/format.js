export function bytes(value) {
  if (value === null || value === undefined) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let n = Number(value);
  if (!Number.isFinite(n)) return '—';
  if (n < 1024) return `${n} B`;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i += 1; }
  return `${n < 10 ? n.toFixed(1) : Math.round(n)} ${units[i]}`;
}

export function relativeTime(iso) {
  if (!iso) return 'never';
  const target = new Date(iso).getTime();
  if (Number.isNaN(target)) return '—';
  const diff = Date.now() - target;
  const abs = Math.abs(diff);
  const suffix = diff >= 0 ? 'ago' : 'from now';
  if (abs < 5000) return 'just now';
  if (abs < 60_000) return `${Math.round(abs / 1000)}s ${suffix}`;
  if (abs < 3_600_000) return `${Math.round(abs / 60_000)}m ${suffix}`;
  if (abs < 86_400_000) return `${Math.round(abs / 3_600_000)}h ${suffix}`;
  return `${Math.round(abs / 86_400_000)}d ${suffix}`;
}

export function absoluteTime(iso) {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });
}

export const latency = (ms) => (ms === null || ms === undefined ? '—' : `${ms} ms`);

/** Maps a domain status onto one of four visual tones. */
export function tone(status) {
  switch (status) {
    case 'online':
    case 'healthy':
    case 'active':
      return 'ok';
    case 'degraded':
    case 'unverified':
    case 'stale':
    case 'warning':
      return 'warn';
    case 'offline':
    case 'down':
    case 'ingress-down':
    case 'egress-down':
    case 'no-egress':
    case 'critical':
      return 'bad';
    default:
      return 'idle';
  }
}

export const ROUTE_STATE_LABEL = {
  healthy: 'Healthy',
  degraded: 'Degraded',
  unverified: 'Unverified',
  'ingress-down': 'Gateway unreachable',
  'egress-down': 'Egress unavailable',
  'no-egress': 'No egress path',
  disabled: 'Disabled',
};

export const ROUTE_STATE_HINT = {
  healthy: 'Clients can reach the gateway and the gateway can reach the internet.',
  degraded: 'Usable, but one leg of the path is impaired.',
  unverified: 'No agent measurement yet — reachability is unconfirmed.',
  'ingress-down': 'Clients cannot reach this gateway. Its egress may still be fine.',
  'egress-down': 'The gateway is reachable but has no working path to the internet.',
  'no-egress': 'No egress is selectable, so this gateway fails closed.',
  disabled: 'Administratively disabled.',
};
