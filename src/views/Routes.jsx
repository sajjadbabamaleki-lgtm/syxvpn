import { useState } from 'react';
import { api } from '../lib/api.js';
import { useResource, invalidate } from '../lib/useResource.js';
import { navigate } from '../lib/router.js';
import {
  Card, Button, Skeleton, ErrorState, StaleBanner, StatusPill, EmptyState,
} from '../components/ui.jsx';
import { Icon } from '../components/Icon.jsx';
import { latency, relativeTime, ROUTE_STATE_LABEL, ROUTE_STATE_HINT, tone } from '../lib/format.js';

/**
 * A route is ingress + egress. The two fail independently, so each card shows
 * both legs explicitly rather than collapsing them into one "status".
 */
function RouteCard({ route }) {
  return (
    <Card className={`route-item route-${tone(route.state)}`}>
      <button
        type="button"
        className="route-item-head"
        onClick={() => navigate(`/gateways/${route.gatewayId}`)}
      >
        <div>
          <strong>{route.gatewayName}</strong>
          <span className="list-meta-inline">{route.region}</span>
        </div>
        <span className={`chip chip-${tone(route.state)}`}>{ROUTE_STATE_LABEL[route.state]}</span>
      </button>

      <div className="path">
        <div className="path-node">
          <span className="path-label">Ingress</span>
          <StatusPill status={route.ingress.status} label={route.ingress.status} />
          <span className="path-detail">{latency(route.ingress.latencyMs)}</span>
        </div>
        <Icon name="chevron" size={15} className="path-arrow" />
        <div className="path-node">
          <span className="path-label">Egress</span>
          {route.egress
            ? <StatusPill status={route.egress.pairStatus} label={route.egress.name} />
            : <span className="chip chip-bad">none</span>}
          <span className="path-detail">{route.egress ? latency(route.egress.pairLatencyMs) : 'fails closed'}</span>
        </div>
        <Icon name="chevron" size={15} className="path-arrow" />
        <div className="path-node">
          <span className="path-label">Internet</span>
          <span className={`chip chip-${route.state === 'healthy' ? 'ok' : 'idle'}`}>
            {route.state === 'healthy' ? 'confirmed' : 'unconfirmed'}
          </span>
        </div>
      </div>

      <p className="route-hint">{ROUTE_STATE_HINT[route.state]}</p>

      <div className="route-foot">
        <span>{route.backups.length} backup{route.backups.length === 1 ? '' : 's'}</span>
        {route.lastSwitch && <span>switched {relativeTime(route.lastSwitch.createdAt)}</span>}
        {!route.configInSync && <span className="tone-warn">config pending</span>}
      </div>

      {route.selectionReason && <p className="detail-note">Selection: {route.selectionReason}</p>}

      {route.backups.length > 0 && (
        <ul className="backup-list">
          {route.backups.map((backup) => (
            <li key={backup.id}>
              <StatusPill status={backup.pairStatus} label={backup.pairStatus} />
              <span>{backup.name}</span>
              <span className="mono">p{backup.assignedPriority}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

export function Routes() {
  const { data, error, loading, stale, updatedAt, refresh } = useResource(
    'routes', async () => api.routes(), { intervalMs: 15000 },
  );
  const [busy, setBusy] = useState(false);

  const reevaluate = async () => {
    setBusy(true);
    try {
      await api.reevaluateRoutes();
      invalidate('routes');
      invalidate('overview');
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <StaleBanner stale={stale} updatedAt={updatedAt} error={error} />
      <div className="toolbar">
        <Button variant="ghost" icon="refresh" loading={busy} onClick={reevaluate}>Re-evaluate routes</Button>
      </div>

      {loading && !data && <Skeleton rows={3} />}
      {error && !data && <ErrorState error={error} onRetry={refresh} />}
      {data?.length === 0 && (
        <EmptyState
          icon="route"
          title="No routes"
          body="A route appears once a gateway is registered. Assign an authorized egress to make it usable."
          action={<Button icon="plus" onClick={() => navigate('/gateways')}>Add gateway</Button>}
        />
      )}
      {data?.map((route) => <RouteCard key={route.gatewayId} route={route} />)}
    </>
  );
}
