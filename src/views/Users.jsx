import { useMemo, useState } from 'react';
import { api } from '../lib/api.js';
import { useResource } from '../lib/useResource.js';
import { navigate } from '../lib/router.js';
import {
  Card, Button, Skeleton, ErrorState, StaleBanner, EmptyState, Meter,
} from '../components/ui.jsx';
import { Icon } from '../components/Icon.jsx';
import { bytes, relativeTime, tone } from '../lib/format.js';
import { NewSubscriberSheet } from './NewSubscriberSheet.jsx';

const FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'active', label: 'Active' },
  { id: 'expired', label: 'Expired' },
  { id: 'exhausted', label: 'Over quota' },
  { id: 'disabled', label: 'Disabled' },
];

const STATE_LABEL = {
  active: 'active',
  expired: 'expired',
  disabled: 'disabled',
  'quota-exhausted': 'over quota',
};

function UserCard({ subscriber }) {
  const state = subscriber.entitlementReason;
  return (
    <Card className="list-card" role="button" tabIndex={0}
      onClick={() => navigate(`/admin/users/${subscriber.id}`)}
      onKeyDown={(e) => { if (e.key === 'Enter') navigate(`/admin/users/${subscriber.id}`); }}
    >
      <div className="list-main">
        <div className="list-title">
          <strong>{subscriber.name}</strong>
          <span className={`chip chip-${tone(state === 'active' ? 'online' : state === 'expired' || state === 'quota-exhausted' ? 'offline' : 'idle')}`}>
            {STATE_LABEL[state] || state}
          </span>
        </div>
        <div className="list-meta">
          <span>
            {subscriber.quotaBytes > 0
              ? `${bytes(subscriber.usedBytes)} / ${bytes(subscriber.quotaBytes)}`
              : `${bytes(subscriber.usedBytes)} · unmetered`}
          </span>
          <span>expires {relativeTime(subscriber.expiresAt)}</span>
        </div>
        {subscriber.quotaBytes > 0 && (
          <Meter
            fraction={subscriber.usedFraction}
            status={subscriber.usedFraction > 0.9 ? 'bad' : subscriber.usedFraction > 0.7 ? 'warn' : 'ok'}
          />
        )}
      </div>
      <Icon name="chevron" size={18} className="list-chevron" />
    </Card>
  );
}

export function Users() {
  const [filter, setFilter] = useState('all');
  const [query, setQuery] = useState('');
  const [creating, setCreating] = useState(false);

  const { data, error, loading, stale, updatedAt, refresh } = useResource(
    'subscribers', () => api.subscribers(), { intervalMs: 30000 },
  );

  const visible = useMemo(() => {
    const list = data || [];
    const needle = query.trim().toLowerCase();
    return list.filter((s) => {
      if (needle && !s.name.toLowerCase().includes(needle) && !s.id.toLowerCase().includes(needle)) return false;
      if (filter === 'all') return true;
      if (filter === 'active') return s.entitled;
      if (filter === 'expired') return s.entitlementReason === 'expired';
      if (filter === 'exhausted') return s.entitlementReason === 'quota-exhausted';
      if (filter === 'disabled') return s.entitlementReason === 'disabled';
      return true;
    });
  }, [data, filter, query]);

  return (
    <>
      <StaleBanner stale={stale} updatedAt={updatedAt} error={error} />
      <div className="toolbar">
        <div className="search">
          <Icon name="search" size={17} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search subscribers"
            aria-label="Search subscribers"
            autoCapitalize="none"
          />
        </div>
        <Button icon="plus" onClick={() => setCreating(true)}>New</Button>
      </div>

      <div className="filter-row" role="tablist">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            role="tab"
            aria-selected={filter === f.id}
            className={filter === f.id ? 'filter filter-active' : 'filter'}
            onClick={() => setFilter(f.id)}
          >
            {f.label}
          </button>
        ))}
      </div>

      {loading && !data && <Skeleton rows={4} />}
      {error && !data && <ErrorState error={error} onRetry={refresh} />}
      {data?.length === 0 && (
        <EmptyState
          icon="users"
          title="No subscribers"
          body="Create one to issue a subscription URL and a VLESS credential."
          action={<Button icon="plus" onClick={() => setCreating(true)}>New subscriber</Button>}
        />
      )}
      {data?.length > 0 && visible.length === 0 && (
        <EmptyState icon="search" title="No matches" body="No subscriber matches this filter." />
      )}
      {visible.map((subscriber) => <UserCard key={subscriber.id} subscriber={subscriber} />)}

      <NewSubscriberSheet open={creating} onClose={() => setCreating(false)} onCreated={refresh} />
    </>
  );
}
