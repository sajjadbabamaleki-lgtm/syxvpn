import { useState } from 'react';
import { api } from '../lib/api.js';
import { useResource, invalidate } from '../lib/useResource.js';
import { useBack } from '../lib/router.js';
import {
  Card, Section, Button, Row, Skeleton, ErrorState, Sheet, Field, CopyButton, Meter,
} from '../components/ui.jsx';
import { Icon } from '../components/Icon.jsx';
import { bytes, relativeTime, absoluteTime, tone } from '../lib/format.js';

const REASON_COPY = {
  active: 'Entitled. Profiles are served and the credential is deployed.',
  expired: 'Expired. The subscription URL returns nothing and the credential is removed from every gateway.',
  disabled: 'Disabled by an operator. No profiles are served.',
  'quota-exhausted': 'Quota exhausted. The credential is removed from the data plane until quota is raised.',
};

export function UserDetail({ id }) {
  const back = useBack('/admin/users');
  const { data, error, loading, refresh } = useResource(`subscriber:${id}`, () => api.subscriber(id), { intervalMs: 20000 });
  const [busy, setBusy] = useState(null);
  const [secret, setSecret] = useState(null);
  const [editing, setEditing] = useState(false);

  const act = async (name, fn) => {
    setBusy(name);
    try {
      const result = await fn();
      invalidate(`subscriber:${id}`);
      invalidate('subscribers');
      invalidate('overview');
      await refresh();
      return result;
    } finally {
      setBusy(null);
    }
  };

  if (loading && !data) return <Skeleton rows={5} />;
  if (error && !data) return <ErrorState error={error} onRetry={refresh} />;
  if (!data) return null;

  const fraction = data.quotaBytes > 0 ? data.usedFraction : 0;

  return (
    <>
      <button type="button" className="back" onClick={back}><Icon name="back" size={18} /> Users</button>

      <Card className={`state-card state-${tone(data.entitled ? 'online' : 'offline')}`}>
        <div className="state-head">
          <span className="state-label">Subscriber</span>
          <span className="state-name">{data.name}</span>
        </div>
        <p className="state-body">{REASON_COPY[data.entitlementReason] || data.entitlementReason}</p>
      </Card>

      <Section title="Quota">
        <Card>
          <Row label="Used" value={bytes(data.usedBytes)} />
          <Row label="Quota" value={data.quotaBytes > 0 ? bytes(data.quotaBytes) : 'unmetered'} />
          {data.quotaBytes > 0 && (
            <>
              <Row label="Remaining" value={bytes(data.remainingBytes)} />
              <Meter fraction={fraction} status={fraction > 0.9 ? 'bad' : fraction > 0.7 ? 'warn' : 'ok'} />
            </>
          )}
          <Row label="Expires" value={`${absoluteTime(data.expiresAt)} · ${relativeTime(data.expiresAt)}`} />
          <Row label="Created" value={absoluteTime(data.createdAt)} />
          <Row label="Subscription fetched" value={data.fetchCount ? `${data.fetchCount}× · last ${relativeTime(data.lastFetchAt)}` : 'never'} />
        </Card>
      </Section>

      <div className="action-grid">
        <Button icon="settings" onClick={() => setEditing(true)}>Edit</Button>
        <Button
          variant="ghost"
          loading={busy === 'status'}
          icon={data.status === 'active' ? 'close' : 'check'}
          onClick={() => act('status', () => api.updateSubscriber(id, { status: data.status === 'active' ? 'disabled' : 'active' }))}
        >
          {data.status === 'active' ? 'Disable' : 'Enable'}
        </Button>
        <Button
          variant="ghost"
          icon="clock"
          loading={busy === 'extend'}
          onClick={() => act('extend', () => api.updateSubscriber(id, { extendDays: 30 }))}
        >
          Extend 30d
        </Button>
      </div>

      <Section title="Subscription" hint="Reading the link is recorded in the event log.">
        <Card>
          <Row label="Token prefix" value={`${data.tokenPrefix}…`} mono />
          <Row label="Credentials" value={data.credentials.map((c) => `${c.state} ${c.uuidHint}`).join(' · ') || 'none'} mono />
        </Card>
        <div className="action-row">
          <Button
            variant="ghost"
            icon="copy"
            loading={busy === 'reveal'}
            onClick={async () => {
              setBusy('reveal');
              try {
                const revealed = await api.revealSubscription(id);
                setSecret({
                  title: 'Subscription link',
                  value: revealed.subscriptionUrl,
                  extra: revealed.profiles.map((p) => p.uri).join('\n'),
                  // Said here because otherwise it reads as a bug: a fleet of
                  // twelve, and this subscriber has four configs.
                  note: `Send this to the subscriber. Rotate it if it leaks — ${revealed.profiles.length === 1 ? 'the gateway' : `the ${revealed.profiles.length} gateways`} below ${revealed.profiles.length === 1 ? 'is' : 'are'} theirs alone, so a leak burns ${revealed.profiles.length === 1 ? 'it' : 'those'} and not the fleet.`,
                });
              } finally {
                setBusy(null);
              }
            }}
          >
            Show link
          </Button>
          <Button
            variant="ghost"
            icon="key"
            loading={busy === 'token'}
            onClick={async () => {
              const result = await act('token', () => api.rotateToken(id));
              setSecret({ title: 'New subscription URL', value: result.subscriptionUrl, note: 'The previous URL stopped working immediately.' });
            }}
          >
            Rotate subscription URL
          </Button>
          <Button
            variant="ghost"
            icon="shield"
            loading={busy === 'credential'}
            onClick={async () => {
              await act('credential', () => api.rotateCredential(id, 30));
              setSecret({
                title: 'Credential rotated',
                value: null,
                note: 'A new VLESS credential was issued. The previous one stays deployed for 30 minutes so an active session is not cut, then it is revoked. The subscriber must refresh their subscription to pick up the new one.',
              });
            }}
          >
            Rotate credential
          </Button>
        </div>
      </Section>

      <Section title="Recent usage" hint="Reported by gateway agents from Xray per-user counters">
        {data.recentUsage.length === 0 ? (
          <Card className="quiet">No usage recorded yet.</Card>
        ) : (
          <ul className="event-list">
            {data.recentUsage.slice(0, 10).map((entry, index) => (
              <li key={`${entry.at}-${entry.direction}-${index}`} className="event">
                <div className="event-main">
                  <span className="event-type">{entry.direction} · {entry.gatewayId}</span>
                  <p>{bytes(entry.bytes)}</p>
                </div>
                <time>{relativeTime(entry.at)}</time>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Danger zone">
        <Button
          variant="danger"
          icon="trash"
          loading={busy === 'delete'}
          onClick={async () => {
            if (!window.confirm(`Delete ${data.name}? Their subscription URL and credentials stop working immediately.`)) return;
            await act('delete', () => api.deleteSubscriber(id));
            back();
          }}
        >
          Delete subscriber
        </Button>
      </Section>

      <EditSheet open={editing} onClose={() => setEditing(false)} subscriber={data} onSaved={() => act('edit', async () => {})} />

      <Sheet open={Boolean(secret)} title={secret?.title || ''} onClose={() => setSecret(null)}>
        <div className="result">
          <p className="warn-note">{secret?.note}</p>
          {secret?.value && <code className="token-box">{secret.value}</code>}
          <div className="action-row">
            {secret?.value && <CopyButton value={secret.value} label="Copy link" />}
            {secret?.extra && <CopyButton value={secret.extra} label="Copy config" />}
            <Button variant="ghost" onClick={() => setSecret(null)}>Done</Button>
          </div>
          {secret?.extra && <code className="token-box">{secret.extra}</code>}
        </div>
      </Sheet>
    </>
  );
}

function EditSheet({ open, onClose, subscriber, onSaved }) {
  const [name, setName] = useState(subscriber.name);
  const [quotaGb, setQuotaGb] = useState(Math.round((subscriber.quotaBytes / 1024 ** 3) * 100) / 100);
  const [expiresAt, setExpiresAt] = useState(subscriber.expiresAt.slice(0, 10));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.updateSubscriber(subscriber.id, {
        name,
        quotaGb: Number(quotaGb),
        expiresAt: new Date(`${expiresAt}T23:59:59Z`).toISOString(),
      });
      await onSaved();
      onClose();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet open={open} title="Edit subscriber" onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <Field label="Name"><input value={name} onChange={(e) => setName(e.target.value)} maxLength={64} required /></Field>
        <div className="form-grid">
          <Field label="Quota (GB)" hint="0 = unmetered">
            <input type="number" inputMode="decimal" min="0" value={quotaGb} onChange={(e) => setQuotaGb(e.target.value)} />
          </Field>
          <Field label="Expires">
            <input type="date" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} required />
          </Field>
        </div>
        {error && <p className="form-error" role="alert">{error}</p>}
        <Button type="submit" loading={busy} icon="check">Save</Button>
      </form>
    </Sheet>
  );
}
