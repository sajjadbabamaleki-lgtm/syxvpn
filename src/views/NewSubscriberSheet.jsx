import { useState } from 'react';
import { api } from '../lib/api.js';
import { invalidate } from '../lib/useResource.js';
import { Sheet, Button, Field, CopyButton } from '../components/ui.jsx';

/**
 * Creating a subscriber returns the subscription URL exactly once — the control
 * plane only stores its hash — so the sheet stays open until it is copied.
 */
export function NewSubscriberSheet({ open, onClose, onCreated }) {
  const [name, setName] = useState('');
  const [quotaGb, setQuotaGb] = useState(20);
  const [days, setDays] = useState(30);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);

  const close = () => {
    setResult(null);
    setName('');
    setError(null);
    onClose();
  };

  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const created = await api.createSubscriber({
        name: name.trim(),
        quotaGb: Number(quotaGb),
        days: Number(days),
      });
      setResult(created);
      invalidate('subscribers');
      invalidate('overview');
      onCreated?.();
    } catch (err) {
      setError(err.details ? `${err.message}: ${err.details.map((d) => `${d.path} ${d.message}`).join(', ')}` : err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet open={open} title={result ? 'Subscriber created' : 'New subscriber'} onClose={close}>
      {result ? (
        <div className="result">
          <p className="result-name">{result.name}</p>
          <p className="warn-note">
            This URL is shown once. The control plane stores only its hash and cannot show it again —
            rotate the token if it is lost.
          </p>
          <code className="token-box">{result.subscriptionUrl}</code>
          <div className="action-row">
            <CopyButton value={result.subscriptionUrl} label="Copy subscription URL" />
            <Button variant="ghost" onClick={close}>Done</Button>
          </div>
        </div>
      ) : (
        <form onSubmit={submit} className="form">
          <Field label="Name or label">
            <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={64} placeholder="e.g. field team 3" />
          </Field>
          <div className="form-grid">
            <Field label="Quota (GB)" hint="0 = unmetered">
              <input type="number" inputMode="numeric" min="0" max="102400" value={quotaGb} onChange={(e) => setQuotaGb(e.target.value)} />
            </Field>
            <Field label="Valid for (days)">
              <input type="number" inputMode="numeric" min="1" max="3650" value={days} onChange={(e) => setDays(e.target.value)} />
            </Field>
          </div>
          {error && <p className="form-error" role="alert">{error}</p>}
          <Button type="submit" loading={busy} icon="plus">Create subscriber</Button>
        </form>
      )}
    </Sheet>
  );
}
