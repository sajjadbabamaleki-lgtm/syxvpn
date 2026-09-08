import { useState } from 'react';
import { api } from '../lib/api.js';
import { useResource } from '../lib/useResource.js';
import { useBack } from '../lib/router.js';
import { Card, Skeleton, ErrorState, StaleBanner, EmptyState } from '../components/ui.jsx';
import { Icon } from '../components/Icon.jsx';
import { relativeTime, tone } from '../lib/format.js';

const FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'critical', label: 'Failures' },
  { id: 'warning', label: 'Warnings' },
];

export function Events() {
  const back = useBack('/admin/more');
  const [filter, setFilter] = useState('all');
  const { data, error, loading, stale, updatedAt, refresh } = useResource(
    'events', () => api.events(100), { intervalMs: 20000 },
  );

  const visible = (data || []).filter((e) => filter === 'all' || e.severity === filter);

  return (
    <>
      <button type="button" className="back" onClick={back}><Icon name="back" size={18} /> More</button>
      <StaleBanner stale={stale} updatedAt={updatedAt} error={error} />

      <div className="filter-row" role="tablist">
        {FILTERS.map((f) => (
          <button key={f.id} type="button" role="tab" aria-selected={filter === f.id}
            className={filter === f.id ? 'filter filter-active' : 'filter'}
            onClick={() => setFilter(f.id)}
          >
            {f.label}
          </button>
        ))}
      </div>

      {loading && !data && <Skeleton rows={6} />}
      {error && !data && <ErrorState error={error} onRetry={refresh} />}
      {data && visible.length === 0 && (
        <EmptyState icon="check" title="Nothing recorded" body="No events match this filter." />
      )}

      {visible.length > 0 && (
        <Card className="event-card">
          <ul className="event-list">
            {visible.map((event) => (
              <li key={event.id} className={`event event-${tone(event.severity)}`}>
                <div className="event-main">
                  <span className="event-type">{event.type}</span>
                  <p>{event.message}</p>
                  {event.targetId && <span className="event-target mono">{event.targetId}</span>}
                </div>
                <time title={event.createdAt}>{relativeTime(event.createdAt)}</time>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </>
  );
}
