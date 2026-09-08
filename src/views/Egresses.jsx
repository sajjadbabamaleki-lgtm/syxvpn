import { useState } from 'react';
import { api } from '../lib/api.js';
import { useResource, invalidate } from '../lib/useResource.js';
import { useBack } from '../lib/router.js';
import {
  Card, Button, Skeleton, ErrorState, StaleBanner, StatusPill, EmptyState, Sheet, Field,
} from '../components/ui.jsx';
import { Icon } from '../components/Icon.jsx';
import { latency, relativeTime } from '../lib/format.js';

const KIND_HINT = {
  direct: 'Leaves from the gateway host itself. Use bind address to pick an authorized uplink.',
  socks: 'Forwards through an authorized SOCKS5 proxy you control.',
  vless: 'Forwards through an authorized upstream VLESS server you control.',
};

function AddEgressSheet({ open, onClose, onCreated }) {
  const [form, setForm] = useState({
    name: '', region: '', kind: 'direct', host: '', port: 443, bindAddress: '',
    username: '', secret: '', tls: false, sni: '', transport: 'tcp', wsPath: '',
    probeUrl: '', priority: 100, weight: 1, authorizationNote: '',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));

  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const body = {
        name: form.name.trim(),
        region: form.region.trim(),
        kind: form.kind,
        priority: Number(form.priority),
        weight: Number(form.weight),
        ...(form.probeUrl.trim() ? { probeUrl: form.probeUrl.trim() } : {}),
        ...(form.authorizationNote.trim() ? { authorizationNote: form.authorizationNote.trim() } : {}),
      };
      if (form.kind === 'direct') {
        if (form.bindAddress.trim()) body.bindAddress = form.bindAddress.trim();
      } else {
        body.host = form.host.trim();
        body.port = Number(form.port);
        if (form.username.trim()) body.username = form.username.trim();
        if (form.secret) body.secret = form.secret;
      }
      if (form.kind === 'vless') {
        body.tls = Boolean(form.tls);
        body.transport = form.transport;
        if (form.sni.trim()) body.sni = form.sni.trim();
        if (form.transport === 'ws' && form.wsPath.trim()) body.wsPath = form.wsPath.trim();
      }
      await api.createEgress(body);
      invalidate('egresses');
      invalidate('routes');
      onCreated?.();
      onClose();
    } catch (err) {
      setError(err.details ? err.details.map((d) => `${d.path}: ${d.message}`).join(' · ') : err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet open={open} title="Register egress path" onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <p className="warn-note">
          Only register connectivity you are authorized to use. Jordan will not help you obtain
          access you do not have.
        </p>
        <Field label="Name"><input value={form.name} onChange={set('name')} required maxLength={64} /></Field>
        <Field label="Region"><input value={form.region} onChange={set('region')} required /></Field>
        <Field label="Kind" hint={KIND_HINT[form.kind]}>
          <select value={form.kind} onChange={set('kind')}>
            <option value="direct">Direct — the gateway&apos;s own uplink</option>
            <option value="socks">SOCKS5 upstream</option>
            <option value="vless">VLESS upstream</option>
          </select>
        </Field>

        {form.kind === 'direct' ? (
          <Field label="Bind address" hint="optional; source address of the authorized uplink">
            <input value={form.bindAddress} onChange={set('bindAddress')} placeholder="203.0.113.9" autoCapitalize="none" spellCheck="false" />
          </Field>
        ) : (
          <>
            <div className="form-grid">
              <Field label="Host"><input value={form.host} onChange={set('host')} required autoCapitalize="none" spellCheck="false" /></Field>
              <Field label="Port"><input type="number" inputMode="numeric" min="1" max="65535" value={form.port} onChange={set('port')} required /></Field>
            </div>
            <div className="form-grid">
              <Field label={form.kind === 'vless' ? 'User id (uuid)' : 'Username'}>
                <input value={form.kind === 'vless' ? form.secret : form.username}
                  onChange={form.kind === 'vless' ? set('secret') : set('username')}
                  autoCapitalize="none" spellCheck="false" />
              </Field>
              {form.kind === 'socks' && (
                <Field label="Password"><input type="password" value={form.secret} onChange={set('secret')} /></Field>
              )}
            </div>
          </>
        )}

        {form.kind === 'vless' && (
          <div className="form-grid">
            <Field label="Transport">
              <select value={form.transport} onChange={set('transport')}>
                <option value="tcp">TCP</option>
                <option value="ws">WebSocket</option>
              </select>
            </Field>
            <Field label="SNI"><input value={form.sni} onChange={set('sni')} autoCapitalize="none" spellCheck="false" /></Field>
          </div>
        )}

        <Field label="Probe URL" hint="fetched through this path to prove it really reaches the internet">
          <input value={form.probeUrl} onChange={set('probeUrl')} placeholder="http://connectivitycheck.gstatic.com/generate_204" autoCapitalize="none" spellCheck="false" />
        </Field>
        <div className="form-grid">
          <Field label="Priority" hint="lower wins"><input type="number" inputMode="numeric" min="1" max="1000" value={form.priority} onChange={set('priority')} /></Field>
          <Field label="Weight" hint="higher wins at equal priority"><input type="number" inputMode="numeric" min="1" max="1000" value={form.weight} onChange={set('weight')} /></Field>
        </div>
        <Field label="Authorization note" hint="who authorized this path, and under what agreement">
          <input value={form.authorizationNote} onChange={set('authorizationNote')} maxLength={500} />
        </Field>

        {error && <p className="form-error" role="alert">{error}</p>}
        <Button type="submit" loading={busy} icon="plus">Register egress</Button>
      </form>
    </Sheet>
  );
}

export function Egresses() {
  const back = useBack('/admin/more');
  const { data, error, loading, stale, updatedAt, refresh } = useResource('egresses', api.egresses, { intervalMs: 30000 });
  const [adding, setAdding] = useState(false);

  return (
    <>
      <button type="button" className="back" onClick={back}><Icon name="back" size={18} /> More</button>
      <StaleBanner stale={stale} updatedAt={updatedAt} error={error} />

      <div className="toolbar">
        <Button icon="plus" onClick={() => setAdding(true)}>Add egress</Button>
      </div>

      {loading && !data && <Skeleton rows={3} />}
      {error && !data && <ErrorState error={error} onRetry={refresh} />}
      {data?.length === 0 && (
        <EmptyState
          icon="globe"
          title="No egress paths"
          body="An egress is how a gateway reaches the internet. Without one, gateways fail closed."
          action={<Button icon="plus" onClick={() => setAdding(true)}>Add egress</Button>}
        />
      )}

      {data?.map((egress) => (
        <Card key={egress.id} className="list-card">
          <div className="list-main">
            <div className="list-title">
              <strong>{egress.name}</strong>
              <StatusPill status={egress.status} label={egress.status} />
            </div>
            <div className="list-meta">
              <span>{egress.kind}</span>
              <span>{egress.region}</span>
              {egress.host && <span className="mono">{egress.host}:{egress.port}</span>}
              {egress.bindAddress && <span className="mono">via {egress.bindAddress}</span>}
            </div>
            <div className="list-meta">
              <span>priority {egress.priority}</span>
              <span>{latency(egress.latencyMs)}</span>
              <span>{egress.assignedGateways} gateway{egress.assignedGateways === 1 ? '' : 's'}</span>
              {egress.activeOn > 0 && <span className="tone-ok">active on {egress.activeOn}</span>}
            </div>
            <div className="list-meta">
              <span>checked {relativeTime(egress.checkedAt)}</span>
              {!egress.enabled && <span className="tone-warn">disabled</span>}
            </div>
            {egress.detail && <p className="detail-note">{egress.detail}</p>}
            {egress.authorizationNote && <p className="detail-note">Authorization: {egress.authorizationNote}</p>}
          </div>
          <div className="card-actions">
            <button type="button" className="icon-btn" aria-label={egress.enabled ? 'Disable' : 'Enable'}
              onClick={async () => { await api.updateEgress(egress.id, { enabled: !egress.enabled }); invalidate('egresses'); refresh(); }}
            >
              <Icon name={egress.enabled ? 'close' : 'check'} size={18} />
            </button>
            <button type="button" className="icon-btn" aria-label="Delete"
              onClick={async () => {
                if (!window.confirm(`Delete ${egress.name}? Gateways using it will re-select or fail closed.`)) return;
                await api.deleteEgress(egress.id);
                invalidate('egresses');
                refresh();
              }}
            >
              <Icon name="trash" size={18} />
            </button>
          </div>
        </Card>
      ))}

      <AddEgressSheet open={adding} onClose={() => setAdding(false)} onCreated={refresh} />
    </>
  );
}
