import { useState } from 'react';
import { api } from '../lib/api.js';
import { useResource, invalidate } from '../lib/useResource.js';
import { useBack } from '../lib/router.js';
import {
  Card, Button, Skeleton, ErrorState, EmptyState, StaleBanner, Row,
} from '../components/ui.jsx';
import { Icon } from '../components/Icon.jsx';
import { relativeTime, absoluteTime, tone } from '../lib/format.js';

const FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'pending', label: 'Waiting' },
  { id: 'paid', label: 'Confirming' },
  { id: 'fulfilled', label: 'Paid' },
  { id: 'expired', label: 'Expired' },
];

const STATUS_TONE = {
  pending: 'warning', paid: 'warning', fulfilled: 'online', expired: 'offline', cancelled: 'unknown',
};

export function Orders() {
  const back = useBack('/admin/more');
  const [filter, setFilter] = useState('all');
  const { data, error, loading, stale, updatedAt, refresh, meta } = useResource(
    `orders:${filter}`,
    () => api.orders(filter === 'all' ? '' : `?status=${filter}`),
    { intervalMs: 20000 },
  );
  const [busy, setBusy] = useState(null);
  const [scan, setScan] = useState(null);

  return (
    <>
      <button type="button" className="back" onClick={back}><Icon name="back" size={18} /> More</button>
      <StaleBanner stale={stale} updatedAt={updatedAt} error={error} />

      <div className="toolbar">
        <Button
          variant="ghost"
          icon="refresh"
          loading={busy === 'scan'}
          onClick={async () => {
            setBusy('scan');
            try {
              setScan(await api.scanPayments());
              invalidate('orders');
              await refresh();
            } catch (err) {
              setScan({ error: err.message });
            } finally {
              setBusy(null);
            }
          }}
        >
          Scan chain now
        </Button>
      </div>

      {scan && (
        <Card className="quiet">
          {scan.error
            ? <p className="tone-bad">{scan.error}</p>
            : <p>Checked {scan.checked ?? 0} transfers · matched {scan.matched ?? 0} · settled {scan.settled ?? 0} · awaiting confirmations {scan.pendingConfirmation ?? 0}</p>}
        </Card>
      )}

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

      {loading && !data && <Skeleton rows={4} />}
      {error && !data && <ErrorState error={error} onRetry={refresh} />}
      {data?.length === 0 && <EmptyState icon="alert" title="No orders" body="Nothing has been ordered in this range." />}

      {data?.map((order) => (
        <Card key={order.id} className="list-card">
          <div className="list-main">
            <div className="list-title">
              <strong>{order.planName}</strong>
              <span className={`chip chip-${tone(STATUS_TONE[order.status])}`}>{order.status}</span>
            </div>
            <div className="list-meta">
              <span>{order.payAmountUsdt} USDT</span>
              <span>{relativeTime(order.createdAt)}</span>
              {order.settledBy && <span>{order.settledBy}</span>}
            </div>
            <Row label="Customer" value={order.customerId} mono />
            {order.txHash && <Row label="Tx" value={order.txHash} mono />}
            {order.status === 'fulfilled' && <Row label="Fulfilled" value={absoluteTime(order.fulfilledAt)} />}
          </div>
          {(order.status === 'pending' || order.status === 'paid') && (
            <button
              type="button"
              className="icon-btn"
              aria-label="Settle manually"
              onClick={async () => {
                if (!window.confirm('Settle this order by hand? Use only when you have verified the payment yourself. It is recorded as settled by you, not by the chain.')) return;
                setBusy(order.id);
                try {
                  await api.settleOrder(order.id, { note: 'verified manually' });
                  invalidate('orders');
                  await refresh();
                } finally {
                  setBusy(null);
                }
              }}
            >
              <Icon name="check" size={18} />
            </button>
          )}
        </Card>
      ))}

      {meta?.totals && (
        <Card className="quiet">
          {Object.entries(meta.totals).map(([status, value]) => (
            <Row key={status} label={status} value={`${value.count} · ${value.usdt} USDT`} />
          ))}
        </Card>
      )}
    </>
  );
}
