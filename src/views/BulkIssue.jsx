import { useState } from 'react';
import { api } from '../lib/api.js';
import { invalidate } from '../lib/useResource.js';
import { Sheet, Button, Field, CopyButton, Card } from '../components/ui.jsx';
import { bytes } from '../lib/format.js';

/** Offers the result as a file without a round trip to the server. */
function download(filename, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Revoke on the next tick so the download has started.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const asText = (items) => items.map((i) => `${i.name}\n${i.subscriptionUrl}`).join('\n\n');
const asConfigs = (items) => items.flatMap((i) => i.profiles).join('\n');
const asCsv = (items) => [
  'name,subscription_url,quota_bytes,expires_at',
  ...items.map((i) => [i.name, i.subscriptionUrl, i.quotaBytes, i.expiresAt].join(',')),
].join('\n');

/**
 * Issues a run of subscriptions in one go — a day's worth of configs to hand
 * out. The links are shown once here and can be re-read later per subscriber.
 */
export function BulkIssueSheet({ open, onClose, onIssued }) {
  const [form, setForm] = useState({
    count: 100,
    namePrefix: `tg-${new Date().toISOString().slice(0, 10)}`,
    quotaGb: 20,
    days: 30,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);
  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  const close = () => { setResult(null); setError(null); onClose(); };

  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const data = await api.createBatch({
        count: Number(form.count),
        namePrefix: form.namePrefix.trim(),
        quotaGb: Number(form.quotaGb),
        days: Number(form.days),
      });
      setResult(data);
      invalidate('subscribers');
      invalidate('batches');
      onIssued?.();
    } catch (err) {
      setError(err.details ? err.details.map((d) => `${d.path}: ${d.message}`).join(' · ') : err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet open={open} title={result ? `Issued ${result.count} subscriptions` : 'Issue subscriptions in bulk'} onClose={close}>
      {result ? (
        <div className="result">
          <p className="warn-note">
            These links are shown once here. You can read any of them again later from the
            subscriber, but not the whole batch in one screen — export it now.
          </p>
          <Card className="quiet">
            <p>Batch <span className="mono">{result.batchId}</span></p>
            <p>
              {result.count} subscriptions ·{' '}
              {result.usableGateways > 0
                ? `${result.usableGateways} gateway${result.usableGateways === 1 ? '' : 's'} currently serving`
                : 'no gateway is currently usable, so the links carry no server yet'}
            </p>
          </Card>

          <div className="action-row">
            <CopyButton value={asText(result.items)} label="Copy all links" />
            <Button variant="ghost" onClick={() => download(`${result.batchId}.txt`, asText(result.items))}>
              Download .txt
            </Button>
            <Button variant="ghost" onClick={() => download(`${result.batchId}.csv`, asCsv(result.items))}>
              Download .csv
            </Button>
          </div>

          {result.items[0]?.profiles.length > 0 && (
            <div className="action-row">
              <CopyButton value={asConfigs(result.items)} label="Copy raw configs" />
              <Button variant="ghost" onClick={() => download(`${result.batchId}-configs.txt`, asConfigs(result.items))}>
                Download configs
              </Button>
            </div>
          )}

          <Card className="event-card">
            <ul className="event-list">
              {result.items.slice(0, 5).map((item) => (
                <li key={item.id} className="event">
                  <div className="event-main">
                    <span className="event-type">{item.name}</span>
                    <p className="mono break">{item.subscriptionUrl}</p>
                  </div>
                </li>
              ))}
            </ul>
            {result.items.length > 5 && (
              <p className="detail-note pad">…and {result.items.length - 5} more in the export.</p>
            )}
          </Card>

          <Button variant="ghost" onClick={close}>Done</Button>
        </div>
      ) : (
        <form className="form" onSubmit={submit}>
          <div className="form-grid">
            <Field label="How many" hint="up to 500 per run">
              <input type="number" inputMode="numeric" min="1" max="500" value={form.count} onChange={set('count')} required />
            </Field>
            <Field label="Name prefix" hint="numbered -001, -002…">
              <input value={form.namePrefix} onChange={set('namePrefix')} maxLength={40} required />
            </Field>
          </div>
          <div className="form-grid">
            <Field label="Data each (GB)" hint="0 = unmetered">
              <input type="number" inputMode="decimal" min="0" value={form.quotaGb} onChange={set('quotaGb')} />
            </Field>
            <Field label="Valid for (days)">
              <input type="number" inputMode="numeric" min="1" max="3650" value={form.days} onChange={set('days')} />
            </Field>
          </div>
          <Card className="quiet">
            <p>
              {form.count} × {form.quotaGb > 0 ? bytes(Number(form.quotaGb) * 1024 ** 3) : 'unmetered'} for {form.days} days.
              Each one is enforced separately: when its data runs out or it expires, that config
              stops working on the gateway within a minute.
            </p>
          </Card>
          {error && <p className="form-error" role="alert">{error}</p>}
          <Button type="submit" loading={busy} icon="plus">Issue {form.count} subscriptions</Button>
        </form>
      )}
    </Sheet>
  );
}
