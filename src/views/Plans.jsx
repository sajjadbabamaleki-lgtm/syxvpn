import { useState } from 'react';
import { api } from '../lib/api.js';
import { useResource, invalidate } from '../lib/useResource.js';
import { useBack } from '../lib/router.js';
import {
  Card, Button, Skeleton, ErrorState, EmptyState, Sheet, Field, StaleBanner,
} from '../components/ui.jsx';
import { Icon } from '../components/Icon.jsx';
import { bytes } from '../lib/format.js';

function PlanSheet({ open, plan, onClose, onSaved }) {
  const [form, setForm] = useState(() => ({
    name: plan?.name || '',
    description: plan?.description || '',
    quotaGb: plan ? Math.round((plan.quotaBytes / 1024 ** 3) * 100) / 100 : 50,
    durationDays: plan?.durationDays || 30,
    priceUsdt: plan?.priceUsdt || 5,
    sortOrder: plan?.sortOrder ?? 100,
  }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const body = {
        name: form.name.trim(),
        description: form.description.trim() || null,
        quotaGb: Number(form.quotaGb),
        durationDays: Number(form.durationDays),
        priceUsdt: Number(form.priceUsdt),
        sortOrder: Number(form.sortOrder),
      };
      if (plan) await api.updatePlan(plan.id, body);
      else await api.createPlan(body);
      invalidate('plans');
      onSaved();
      onClose();
    } catch (err) {
      setError(err.details ? err.details.map((d) => `${d.path}: ${d.message}`).join(' · ') : err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet open={open} title={plan ? 'Edit plan' : 'New plan'} onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <Field label="Name"><input value={form.name} onChange={set('name')} required maxLength={64} /></Field>
        <Field label="Description" hint="one line shown on the plan card">
          <input value={form.description} onChange={set('description')} maxLength={300} />
        </Field>
        <div className="form-grid">
          <Field label="Data (GB)" hint="0 = unmetered">
            <input type="number" inputMode="decimal" min="0" value={form.quotaGb} onChange={set('quotaGb')} />
          </Field>
          <Field label="Days">
            <input type="number" inputMode="numeric" min="1" value={form.durationDays} onChange={set('durationDays')} />
          </Field>
        </div>
        <div className="form-grid">
          <Field label="Price (USDT)">
            <input type="number" inputMode="decimal" min="0.01" step="0.01" value={form.priceUsdt} onChange={set('priceUsdt')} />
          </Field>
          <Field label="Sort order" hint="lower first">
            <input type="number" inputMode="numeric" min="0" value={form.sortOrder} onChange={set('sortOrder')} />
          </Field>
        </div>
        {error && <p className="form-error" role="alert">{error}</p>}
        <Button type="submit" loading={busy} icon="check">{plan ? 'Save plan' : 'Create plan'}</Button>
      </form>
    </Sheet>
  );
}

export function Plans() {
  const back = useBack('/admin/more');
  const { data, error, loading, stale, updatedAt, refresh } = useResource('plans', api.plans, { intervalMs: 60000 });
  const [editing, setEditing] = useState(null);
  const [creating, setCreating] = useState(false);

  return (
    <>
      <button type="button" className="back" onClick={back}><Icon name="back" size={18} /> More</button>
      <StaleBanner stale={stale} updatedAt={updatedAt} error={error} />

      <div className="toolbar">
        <Button icon="plus" onClick={() => setCreating(true)}>New plan</Button>
      </div>

      {loading && !data && <Skeleton rows={3} />}
      {error && !data && <ErrorState error={error} onRetry={refresh} />}
      {data?.length === 0 && (
        <EmptyState
          icon="plus"
          title="No plans"
          body="Customers cannot buy anything until a plan is published."
          action={<Button icon="plus" onClick={() => setCreating(true)}>New plan</Button>}
        />
      )}

      {data?.map((plan) => (
        <Card key={plan.id} className="list-card">
          <div className="list-main">
            <div className="list-title">
              <strong>{plan.name}</strong>
              <span className={`chip chip-${plan.enabled ? 'ok' : 'idle'}`}>{plan.enabled ? 'on sale' : 'hidden'}</span>
            </div>
            <div className="list-meta">
              <span>{plan.priceUsdt} USDT</span>
              <span>{plan.quotaBytes > 0 ? bytes(plan.quotaBytes) : 'unmetered'}</span>
              <span>{plan.durationDays} days</span>
            </div>
            {plan.description && <p className="detail-note">{plan.description}</p>}
          </div>
          <div className="card-actions">
            <button type="button" className="icon-btn" aria-label="Edit" onClick={() => setEditing(plan)}>
              <Icon name="settings" size={18} />
            </button>
            <button type="button" className="icon-btn" aria-label={plan.enabled ? 'Hide' : 'Publish'}
              onClick={async () => { await api.updatePlan(plan.id, { enabled: !plan.enabled }); invalidate('plans'); refresh(); }}
            >
              <Icon name={plan.enabled ? 'close' : 'check'} size={18} />
            </button>
            <button type="button" className="icon-btn" aria-label="Delete"
              onClick={async () => {
                if (!window.confirm(`Delete ${plan.name}? Existing orders keep their own copy of the terms.`)) return;
                await api.deletePlan(plan.id);
                invalidate('plans');
                refresh();
              }}
            >
              <Icon name="trash" size={18} />
            </button>
          </div>
        </Card>
      ))}

      {creating && <PlanSheet open onClose={() => setCreating(false)} onSaved={refresh} />}
      {editing && <PlanSheet open plan={editing} onClose={() => setEditing(null)} onSaved={refresh} />}
    </>
  );
}
