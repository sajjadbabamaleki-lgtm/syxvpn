import { useState } from 'react';
import { shop, customer } from '../lib/shopApi.js';
import { useResource, invalidate } from '../lib/useResource.js';
import { navigate } from '../lib/router.js';
import { Card, Button, Skeleton, ErrorState, EmptyState, StaleBanner } from '../components/ui.jsx';
import { Icon } from '../components/Icon.jsx';
import { bytes, relativeTime } from '../lib/format.js';

function PlanCard({ plan, onBuy, busy, canBuy }) {
  return (
    <Card className="plan">
      <div className="plan-head">
        <div>
          <strong>{plan.name}</strong>
          {plan.description && <p className="plan-desc">{plan.description}</p>}
        </div>
        <div className="plan-price">
          <span>{plan.priceUsdt}</span>
          <small>USDT</small>
        </div>
      </div>
      <div className="plan-specs">
        <span><Icon name="signal" size={15} /> {plan.quotaBytes > 0 ? bytes(plan.quotaBytes) : 'Unmetered'}</span>
        <span><Icon name="clock" size={15} /> {plan.durationDays} days</span>
      </div>
      <Button onClick={() => onBuy(plan)} loading={busy} disabled={!canBuy}>
        {canBuy ? 'Buy with USDT' : 'Payments unavailable'}
      </Button>
    </Card>
  );
}

export function Store() {
  const signedIn = Boolean(customer.current);
  const plans = useResource('shop:plans', shop.plans, { intervalMs: 300000 });
  const shopConfig = useResource('shop:config', shop.config, { intervalMs: 300000 });
  const account = useResource('shop:me', shop.me, { intervalMs: 30000, enabled: signedIn });
  const [busyPlan, setBusyPlan] = useState(null);
  const [error, setError] = useState(null);

  const payments = shopConfig.data?.payment;
  const canBuy = Boolean(payments?.configured);
  const openOrder = (account.data?.orders || []).find((o) => o.status === 'pending' || o.status === 'paid');

  const buy = async (plan) => {
    setError(null);
    if (!signedIn) { navigate('/signin'); return; }
    setBusyPlan(plan.id);
    try {
      const order = await shop.createOrder(plan.id);
      invalidate('shop:me');
      navigate(`/order/${order.id}`);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyPlan(null);
    }
  };

  return (
    <>
      <StaleBanner stale={plans.stale} updatedAt={plans.updatedAt} error={plans.error} />

      {openOrder && (
        <Card className="notice" role="button" tabIndex={0}
          onClick={() => navigate(`/order/${openOrder.id}`)}
          onKeyDown={(e) => { if (e.key === 'Enter') navigate(`/order/${openOrder.id}`); }}
        >
          <div>
            <strong>Payment waiting</strong>
            <p>
              {openOrder.payAmountUsdt} USDT for {openOrder.planName}
              {openOrder.status === 'paid'
                ? ' — seen on chain, waiting for confirmations'
                : ` — expires ${relativeTime(openOrder.expiresAt)}`}
            </p>
          </div>
          <Icon name="chevron" size={18} />
        </Card>
      )}

      {!canBuy && shopConfig.data && (
        <Card className="notice notice-warn">
          <div>
            <strong>Payments are not set up yet</strong>
            <p>
              This deployment has no USDT address configured, so orders cannot be opened.
              {shopConfig.data.supportContact ? ` Contact ${shopConfig.data.supportContact}.` : ''}
            </p>
          </div>
        </Card>
      )}

      {plans.loading && !plans.data && <Skeleton rows={3} />}
      {plans.error && !plans.data && <ErrorState error={plans.error} onRetry={plans.refresh} />}
      {plans.data?.length === 0 && (
        <EmptyState icon="alert" title="Nothing on sale yet" body="No plans have been published." />
      )}

      {error && <p className="form-error" role="alert">{error}</p>}

      {plans.data?.map((plan) => (
        <PlanCard key={plan.id} plan={plan} onBuy={buy} busy={busyPlan === plan.id} canBuy={canBuy} />
      ))}

      {plans.data?.length > 0 && (
        <Card className="quiet">
          <p>
            Payment is USDT on the TRON network (TRC-20). You send the exact amount shown on the
            next screen; the order settles by itself once the transfer has enough confirmations.
            Nothing is unlocked before that.
          </p>
        </Card>
      )}
    </>
  );
}
