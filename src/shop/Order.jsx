import { useEffect, useState } from 'react';
import { shop } from '../lib/shopApi.js';
import { useResource, invalidate } from '../lib/useResource.js';
import { navigate, useBack } from '../lib/router.js';
import { Card, Button, Row, Skeleton, ErrorState, CopyButton } from '../components/ui.jsx';
import { Icon } from '../components/Icon.jsx';
import { Qr } from '../components/Qr.jsx';
import { bytes, relativeTime, absoluteTime } from '../lib/format.js';

const STATUS = {
  pending: {
    title: 'Waiting for your payment',
    body: 'Send the exact amount below. The order settles automatically once the transfer is confirmed on chain.',
    tone: 'idle',
  },
  paid: {
    title: 'Payment seen',
    body: 'The transfer was found on chain and is waiting for confirmations. Nothing else to do.',
    tone: 'idle',
  },
  fulfilled: {
    title: 'Paid and activated',
    body: 'Your subscription is ready.',
    tone: 'ok',
  },
  expired: {
    title: 'Order expired',
    body: 'No payment arrived in time. Start a new order — nothing was charged.',
    tone: 'bad',
  },
  cancelled: {
    title: 'Order cancelled',
    body: 'This order was cancelled.',
    tone: 'idle',
  },
};

/** TRON wallets understand this URI, so the QR opens a prefilled transfer. */
function tronUri(order) {
  return `tron:${order.payAddress}?contractAddress=${encodeURIComponent(
    'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
  )}&amount=${order.payAmountUsdt}`;
}

export function Order({ id }) {
  const back = useBack('/');
  const [cancelling, setCancelling] = useState(false);
  const { data, error, loading, refresh } = useResource(
    `shop:order:${id}`, () => shop.order(id),
    // Poll quickly while a payment is outstanding; the screen is the receipt.
    { intervalMs: 10000 },
  );

  useEffect(() => {
    if (data?.status === 'fulfilled') invalidate('shop:me');
  }, [data?.status]);

  if (loading && !data) return <Skeleton rows={4} />;
  if (error && !data) return <ErrorState error={error} onRetry={refresh} />;
  if (!data) return null;

  const status = STATUS[data.status] || STATUS.pending;
  const open = data.status === 'pending' || data.status === 'paid';

  return (
    <>
      <button type="button" className="back" onClick={back}><Icon name="back" size={18} /> Store</button>

      <Card className={`state-card state-${status.tone}`}>
        <div className="state-head">
          <span className="state-label">{data.planName}</span>
          <span className="state-name">{status.title}</span>
        </div>
        <p className="state-body">{status.body}</p>
      </Card>

      {open && (
        <>
          <Card className="pay">
            <div className="pay-amount">
              <span className="metric-label">Send exactly</span>
              <strong>{data.payAmountUsdt} <small>USDT</small></strong>
              <span className="pay-note">
                TRC-20 on TRON. The exact amount is how your payment is matched to this order —
                sending a different amount will not settle it automatically.
              </span>
            </div>
            <CopyButton value={String(data.payAmountUsdt)} label="Copy amount" />
          </Card>

          <Card className="pay">
            <span className="metric-label">To this address</span>
            <code className="token-box">{data.payAddress}</code>
            <div className="action-row">
              <CopyButton value={data.payAddress} label="Copy address" />
            </div>
            <div className="qr-wrap">
              <Qr value={tronUri(data)} size={200} label="TRON payment QR code" />
              <p className="detail-note">Scan with a TRON wallet, then check the amount before sending.</p>
            </div>
          </Card>

          <Card>
            <Row label="Status" value={data.status === 'paid' ? `seen, ${data.confirmations ?? 0} confirmations` : 'waiting'} />
            <Row label="Order expires" value={`${relativeTime(data.expiresAt)} · ${absoluteTime(data.expiresAt)}`} />
            <Row label="Plan" value={`${bytes(data.quotaBytes)} · ${data.durationDays} days`} />
            <Row label="Order id" value={data.id} mono />
          </Card>

          {data.status === 'pending' && (
            <Button
              variant="ghost"
              loading={cancelling}
              onClick={async () => {
                setCancelling(true);
                try {
                  await shop.cancelOrder(id);
                  await refresh();
                } finally {
                  setCancelling(false);
                }
              }}
            >
              Cancel this order
            </Button>
          )}
        </>
      )}

      {data.status === 'fulfilled' && (
        <>
          <Card>
            <Row label="Paid" value={absoluteTime(data.paidAt)} />
            <Row label="Amount" value={`${data.payAmountUsdt} USDT`} />
            {data.txHash && <Row label="Transaction" value={data.txHash} mono />}
            <Row label="Settled by" value={data.settledBy === 'chain' ? 'on-chain confirmation' : data.settledBy} />
          </Card>
          <Button icon="check" onClick={() => navigate('/account')}>Open my config</Button>
        </>
      )}

      {(data.status === 'expired' || data.status === 'cancelled') && (
        <Button onClick={() => navigate('/')}>Back to plans</Button>
      )}
    </>
  );
}
