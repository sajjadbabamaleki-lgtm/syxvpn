import { useState } from 'react';
import { api } from '../lib/api.js';
import { useResource } from '../lib/useResource.js';
import { Card, Section, Button, Row } from '../components/ui.jsx';
import { absoluteTime, relativeTime } from '../lib/format.js';

const size = (bytes) => {
  if (bytes == null) return '—';
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
};

/**
 * Snapshots of the database.
 *
 * The whole business is one SQLite file — subscribers, customers, orders, every
 * gateway's agent key, every REALITY private key — so this screen is the one
 * that decides whether a bad day is an incident or the end of the company. It
 * shows what exists rather than promising that something does.
 */
export function Backups() {
  const { data, meta, refresh, loading } = useResource('backups', api.backups, { intervalMs: 60000 });
  const [busy, setBusy] = useState(null);
  const [message, setMessage] = useState(null);

  const takeOne = async () => {
    setBusy('take');
    setMessage(null);
    try {
      const entry = await api.takeBackup();
      setMessage({ tone: 'ok', text: `Took ${entry.name} (${size(entry.bytes)}).` });
      await refresh();
    } catch (err) {
      setMessage({ tone: 'bad', text: err.message });
    } finally {
      setBusy(null);
    }
  };

  const download = async (name) => {
    setBusy(name);
    setMessage(null);
    try {
      await api.downloadBackup(name);
    } catch (err) {
      setMessage({ tone: 'bad', text: err.message });
    } finally {
      setBusy(null);
    }
  };

  const latest = data?.[0];

  return (
    <Section
      title="Backups"
      hint="Every subscriber, order and gateway key is in one file. These are the copies of it."
      action={<Button variant="ghost" icon="plus" loading={busy === 'take'} onClick={takeOne}>Take one now</Button>}
    >
      <Card>
        <Row label="Schedule" value={meta?.enabled ? `every ${meta.intervalHours}h, keeping ${meta.keep}` : 'off'} />
        <Row label="Written to" value={meta?.directory || '—'} mono />
        <Row
          label="Most recent"
          value={latest ? `${relativeTime(latest.createdAt)} · ${size(latest.bytes)}` : (loading ? '…' : 'none yet')}
        />
      </Card>

      {/* The mistake worth preventing: a snapshot beside the database survives a
          bad query and a dropped table, not a dead disk or a deleted volume. */}
      <p className="hint">
        Copy these off this machine. A snapshot on the same disk is not a backup —
        and it holds every credential in the fleet, so treat the copy like the
        database itself.
      </p>

      {message && (
        <p className={message.tone === 'ok' ? 'form-ok' : 'form-error'} role="alert">{message.text}</p>
      )}

      {data?.length > 0 && (
        <Card>
          {data.map((entry) => (
            <div className="list-card" key={entry.name} style={{ cursor: 'default' }}>
              <div className="list-main">
                <div className="list-title"><strong className="mono">{entry.name}</strong></div>
                <div className="list-meta">
                  <span>{absoluteTime(entry.createdAt)}</span>
                  <span>{size(entry.bytes)}</span>
                </div>
              </div>
              <div className="card-actions">
                <Button
                  variant="ghost"
                  icon="copy"
                  loading={busy === entry.name}
                  onClick={() => download(entry.name)}
                >
                  Download
                </Button>
              </div>
            </div>
          ))}
        </Card>
      )}
    </Section>
  );
}
