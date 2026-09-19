import { useState } from 'react';
import { api } from '../lib/api.js';
import { invalidate } from '../lib/useResource.js';
import { Sheet, Button, Field, CopyButton } from '../components/ui.jsx';
import { Qr } from '../components/Qr.jsx';

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
        <Handover result={result} onDone={close} />
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

/**
 * What the operator hands over, on the screen that made it.
 *
 * Two things leave here and they are not interchangeable. The subscription
 * link is the one worth selling: it is read again every time the customer's
 * app refreshes, so a gateway added or replaced later reaches them without
 * anybody being asked to paste anything. A config line is a copy of today's
 * gateway, frozen — but it is the only thing some client apps accept, and
 * refusing to show it here would mean the sale finishes somewhere else.
 *
 * The QR is the import path that works everywhere, including apps with no URL
 * scheme of their own, so it shows whichever of the two is selected rather
 * than sitting under one of them.
 */
function Handover({ result, onDone }) {
  const profiles = result.profiles || [];
  const [showing, setShowing] = useState('link');
  const current = showing === 'link' ? result.subscriptionUrl : profiles[showing]?.uri;

  return (
    <div className="result">
      <p className="result-name">{result.name}</p>
      <p className="warn-note">
        This link is shown once. The control plane stores only its hash and cannot show it again —
        rotate the token if it is lost.
      </p>

      <div className="action-row">
        <Button
          variant={showing === 'link' ? 'primary' : 'ghost'}
          onClick={() => setShowing('link')}
        >
          Subscription link
        </Button>
        {profiles.map((profile, index) => (
          <Button
            // The line, not the gateway: a gateway can offer more than one
            // door, and keying on its id gave two buttons the same key.
            key={profile.uri}
            variant={showing === index ? 'primary' : 'ghost'}
            onClick={() => setShowing(index)}
          >
            {/* Which door, not just which server. Four buttons reading gw1,
                gw1, gw2, gw2 are four configs a person cannot tell apart —
                and the whole reason the second one exists is that it is the
                one some client apps can open. */}
            {profile.protocol ? `${profile.gatewayName} · ${profile.protocol}` : profile.gatewayName}
          </Button>
        ))}
      </div>

      {current && (
        <div className="qr-wrap">
          <Qr value={current} size={220} label={showing === 'link' ? 'Subscription link' : 'Config'} />
        </div>
      )}
      {current && <code className="token-box">{current}</code>}

      {profiles.length === 0 && (
        <p className="warn-note">
          No gateway can serve this subscriber yet, so there is no config to hand over — only the
          link, which starts working the moment one comes online.
        </p>
      )}

      <div className="action-row">
        {current && <CopyButton value={current} label={showing === 'link' ? 'Copy link' : 'Copy config'} />}
        {profiles.length > 1 && (
          <CopyButton value={profiles.map((p) => p.uri).join('\n')} label="Copy all configs" />
        )}
        <Button variant="ghost" onClick={onDone}>Done</Button>
      </div>
    </div>
  );
}
