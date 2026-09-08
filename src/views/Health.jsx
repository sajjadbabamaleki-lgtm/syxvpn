import { api } from '../lib/api.js';
import { useResource } from '../lib/useResource.js';
import { useBack } from '../lib/router.js';
import { Card, Section, Skeleton, ErrorState, StaleBanner, EmptyState } from '../components/ui.jsx';
import { Icon } from '../components/Icon.jsx';
import { latency, relativeTime, tone } from '../lib/format.js';

const SOURCE_HINT = {
  'control-plane': 'measured by the control plane — can a client reach the gateway',
  agent: 'measured by the gateway agent — can the gateway reach the internet',
};

export function Health() {
  const back = useBack('/more');
  const { data, error, loading, stale, updatedAt, refresh } = useResource(
    'health-checks', () => api.healthChecks('?limit=100'), { intervalMs: 20000 },
  );

  const ingress = (data || []).filter((c) => c.source === 'control-plane');
  const egress = (data || []).filter((c) => c.source === 'agent');

  const list = (checks) => (
    <ul className="event-list">
      {checks.slice(0, 40).map((check) => (
        <li key={check.id} className={`event event-${tone(check.status)}`}>
          <div className="event-main">
            <span className="event-type">{check.kind} · {check.targetId}</span>
            <p>{check.detail || check.status}</p>
          </div>
          <div className="event-side">
            <span>{latency(check.latencyMs)}</span>
            <time>{relativeTime(check.createdAt)}</time>
          </div>
        </li>
      ))}
    </ul>
  );

  return (
    <>
      <button type="button" className="back" onClick={back}><Icon name="back" size={18} /> More</button>
      <StaleBanner stale={stale} updatedAt={updatedAt} error={error} />

      {loading && !data && <Skeleton rows={6} />}
      {error && !data && <ErrorState error={error} onRetry={refresh} />}

      {data && (
        <>
          <Section title="Ingress reachability" hint={SOURCE_HINT['control-plane']}>
            {ingress.length ? <Card className="event-card">{list(ingress)}</Card>
              : <EmptyState icon="activity" title="No ingress checks yet" body="Register a gateway to start probing." />}
          </Section>
          <Section title="Egress reachability" hint={SOURCE_HINT.agent}>
            {egress.length ? <Card className="event-card">{list(egress)}</Card>
              : <EmptyState icon="globe" title="No egress measurements" body="Egress health can only be measured by a running gateway agent." />}
          </Section>
        </>
      )}
    </>
  );
}
