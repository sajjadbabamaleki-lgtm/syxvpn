import { useState } from 'react';
import { api } from '../lib/api.js';
import { useResource } from '../lib/useResource.js';
import { navigate } from '../lib/router.js';
import {
  Card, Section, Button, Metric, EmptyState, Skeleton, ErrorState, StaleBanner, StatusPill,
} from '../components/ui.jsx';
import { Icon } from '../components/Icon.jsx';
import { bytes, relativeTime, ROUTE_STATE_LABEL, ROUTE_STATE_HINT, tone } from '../lib/format.js';
import { NewSubscriberSheet } from './NewSubscriberSheet.jsx';

const STATE_COPY = {
  healthy: { title: 'Operational', body: 'Every enabled gateway has a working path to the internet.' },
  degraded: { title: 'Degraded', body: 'Some paths are impaired. Traffic is still flowing on at least one route.' },
  down: { title: 'Down', body: 'No gateway currently has a usable path. Subscribers cannot connect.' },
  unconfigured: { title: 'Not configured', body: 'No gateways registered yet.' },
};

export function Overview() {
  const { data, error, loading, stale, updatedAt, refresh } = useResource('overview', api.overview, { intervalMs: 15000 });
  const [creating, setCreating] = useState(false);
  const [checking, setChecking] = useState(false);

  const runHealthCheck = async () => {
    setChecking(true);
    try {
      const gateways = await api.gateways();
      await Promise.allSettled(gateways.map((g) => api.checkGateway(g.id)));
      await refresh();
    } finally {
      setChecking(false);
    }
  };

  if (loading && !data) return <Skeleton rows={5} />;
  if (error && !data) return <ErrorState error={error} onRetry={refresh} />;
  if (!data) return null;

  const copy = STATE_COPY[data.state] || STATE_COPY.degraded;
  const route = data.activeRoute;

  return (
    <>
      <StaleBanner stale={stale} updatedAt={updatedAt} error={error} />

      <Card className={`state-card state-${tone(data.state === 'unconfigured' ? 'unknown' : data.state)}`}>
        <div className="state-head">
          <span className="state-label">Network state</span>
          <span className="state-name">{copy.title}</span>
        </div>
        <p className="state-body">{copy.body}</p>
      </Card>

      <div className="metric-grid">
        <Metric
          label="Gateways online"
          value={`${data.gateways.online}/${data.gateways.enabled}`}
          sub={data.gateways.total === 0 ? 'none registered' : `${data.gateways.agentsOnline} agents reporting`}
          status={data.gateways.online > 0 ? 'online' : 'offline'}
        />
        <Metric
          label="Egress paths"
          value={`${data.egress.online}/${data.egress.enabled}`}
          sub={data.egress.unknown ? `${data.egress.unknown} unverified` : 'measured from gateways'}
          status={data.egress.online > 0 ? 'online' : data.egress.total ? 'offline' : 'unknown'}
        />
        <Metric
          label="Active users"
          value={data.subscribers.active}
          sub={`${data.subscribers.total} total`}
        />
        <Metric
          label="Traffic 24h"
          value={data.usage.measured ? bytes(data.usage.last24hBytes) : '—'}
          sub={data.usage.measured ? `${bytes(data.usage.last7dBytes)} in 7d` : 'no agent reports yet'}
        />
      </div>

      <Section title="Active route">
        {route ? (
          <Card className="route-card" onClick={() => navigate(`/gateways/${route.gatewayId}`)} role="button" tabIndex={0}>
            <div className="route-line">
              <div className="hop">
                <span className="hop-label">Client</span>
                <strong>{route.gatewayName}</strong>
                <StatusPill status={route.ingress.status} label={`ingress ${route.ingress.status}`} />
              </div>
              <Icon name="chevron" size={16} className="hop-arrow" />
              <div className="hop">
                <span className="hop-label">Egress</span>
                <strong>{route.egress?.name || 'none'}</strong>
                <StatusPill status={route.egress?.pairStatus || 'unknown'} label={`egress ${route.egress?.pairStatus || 'unknown'}`} />
              </div>
              <Icon name="chevron" size={16} className="hop-arrow" />
              <div className="hop">
                <span className="hop-label">Internet</span>
                <strong>{route.state === 'healthy' ? 'Reachable' : 'Unconfirmed'}</strong>
              </div>
            </div>
            <p className="route-hint">{ROUTE_STATE_HINT[route.state]}</p>
          </Card>
        ) : (
          <EmptyState
            icon="route"
            title="No route configured"
            body="Register a gateway and assign it an authorized egress path."
            action={<Button icon="plus" onClick={() => navigate('/gateways')}>Add gateway</Button>}
          />
        )}
      </Section>

      <Section title="Route health" hint={`${data.routes.healthy} healthy · ${data.routes.degraded} degraded · ${data.routes.ingressDown + data.routes.egressDown + data.routes.noEgress} failing`}>
        <div className="chip-row">
          {Object.entries({
            healthy: data.routes.healthy,
            degraded: data.routes.degraded,
            unverified: data.routes.unverified,
            'ingress-down': data.routes.ingressDown,
            'egress-down': data.routes.egressDown,
            'no-egress': data.routes.noEgress,
          }).filter(([, count]) => count > 0).map(([state, count]) => (
            <span key={state} className={`chip chip-${tone(state)}`}>
              {count} · {ROUTE_STATE_LABEL[state]}
            </span>
          ))}
          {data.routes.total === 0 && <span className="chip">No routes</span>}
        </div>
      </Section>

      <Section title="Recent alerts" action={<Button variant="ghost" onClick={() => navigate('/events')}>All events</Button>}>
        {data.alerts.length === 0 ? (
          <Card className="quiet">No warnings or failures recorded.</Card>
        ) : (
          <ul className="event-list">
            {data.alerts.slice(0, 5).map((event) => (
              <li key={event.id} className={`event event-${tone(event.severity)}`}>
                <div className="event-main">
                  <span className="event-type">{event.type}</span>
                  <p>{event.message}</p>
                </div>
                <time>{relativeTime(event.createdAt)}</time>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Quick actions">
        <div className="action-grid">
          <Button icon="plus" onClick={() => setCreating(true)}>New subscriber</Button>
          <Button variant="ghost" icon="gateway" onClick={() => navigate('/gateways')}>Add gateway</Button>
          <Button variant="ghost" icon="refresh" loading={checking} onClick={runHealthCheck}>Run health check</Button>
        </div>
      </Section>

      <NewSubscriberSheet open={creating} onClose={() => setCreating(false)} onCreated={refresh} />
    </>
  );
}
