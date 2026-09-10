import { useState } from 'react';
import { api } from '../lib/api.js';
import { useResource, invalidate } from '../lib/useResource.js';
import { navigate } from '../lib/router.js';
import {
  Card, Button, EmptyState, Skeleton, ErrorState, StaleBanner, StatusPill, Sheet, Field, CopyButton,
} from '../components/ui.jsx';
import { Icon } from '../components/Icon.jsx';
import { latency, relativeTime } from '../lib/format.js';

function GatewayCard({ gateway }) {
  return (
    <Card className="list-card" role="button" tabIndex={0}
      onClick={() => navigate(`/admin/gateways/${gateway.id}`)}
      onKeyDown={(e) => { if (e.key === 'Enter') navigate(`/admin/gateways/${gateway.id}`); }}
    >
      <div className="list-main">
        <div className="list-title">
          <strong>{gateway.name}</strong>
          <StatusPill status={gateway.ingress.status} label={gateway.ingress.status} />
        </div>
        <div className="list-meta">
          <span>{gateway.region}</span>
          <span className="mono">{gateway.host}:{gateway.port}</span>
          <span>{gateway.transport === 'reality' ? 'reality' : (gateway.tls ? gateway.tlsMode : 'no TLS')}</span>
        </div>
        <div className="list-meta">
          <span>{latency(gateway.ingress.latencyMs)}</span>
          <span>checked {relativeTime(gateway.ingress.checkedAt)}</span>
          <span className={gateway.agent.status === 'online' ? 'tone-ok' : 'tone-warn'}>
            agent {gateway.agent.status}
          </span>
        </div>
        {!gateway.config.inSync && (
          <p className="inline-warn">
            <Icon name="alert" size={14} /> config v{gateway.config.version} not deployed
            {gateway.config.deployedVersion ? ` (running v${gateway.config.deployedVersion})` : ''}
          </p>
        )}
      </div>
      <Icon name="chevron" size={18} className="list-chevron" />
    </Card>
  );
}

function AddGatewaySheet({ open, onClose, onCreated }) {
  const [form, setForm] = useState({
    name: '', region: '', host: '', port: 443, transport: 'reality', tlsMode: 'reverse-proxy',
    listenPort: 10001, wsPath: '/ws', sni: '', priority: 100,
    realityDest: 'www.microsoft.com:443',
  });
  const reality = form.transport === 'reality';
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [created, setCreated] = useState(null);

  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  const close = () => { setCreated(null); setError(null); onClose(); };

  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const body = {
        name: form.name.trim(),
        region: form.region.trim(),
        host: form.host.trim(),
        port: Number(form.port),
        transport: form.transport,
        priority: Number(form.priority),
        // A REALITY gateway is the public listener and carries its own TLS, so
        // none of the reverse-proxy fields apply to it. The key pair and short
        // IDs come back from the control plane; there is nothing to type.
        ...(reality ? {
          tlsMode: 'none',
          realityDest: form.realityDest.trim(),
        } : {
          tlsMode: form.tlsMode,
          wsPath: form.wsPath.trim() || '/ws',
          ...(form.sni.trim() ? { sni: form.sni.trim() } : {}),
          ...(form.tlsMode === 'reverse-proxy'
            ? { listenPort: Number(form.listenPort), listenAddress: '127.0.0.1' }
            : {}),
        }),
      };
      const gateway = await api.createGateway(body);
      setCreated(gateway);
      invalidate('gateways');
      invalidate('overview');
      onCreated?.();
    } catch (err) {
      setError(err.details ? err.details.map((d) => `${d.path}: ${d.message}`).join(' · ') : err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet open={open} title={created ? 'Gateway registered' : 'Register gateway'} onClose={close}>
      {created ? (
        <div className="result">
          <p className="result-name">{created.name}</p>
          <p className="warn-note">
            The agent key is shown once. Put it in the gateway agent&apos;s
            <code> JORDAN_AGENT_KEY</code> and keep it out of shell history.
          </p>
          <code className="token-box">{created.agentKey}</code>
          <CopyButton value={created.agentKey} label="Copy agent key" />
          <code className="token-box">JORDAN_GATEWAY_ID={created.id}</code>
          <div className="action-row">
            <CopyButton value={created.id} label="Copy gateway id" />
            <Button variant="ghost" onClick={close}>Done</Button>
          </div>
        </div>
      ) : (
        <form className="form" onSubmit={submit}>
          <Field label="Name"><input value={form.name} onChange={set('name')} required maxLength={64} /></Field>
          <Field label="Region"><input value={form.region} onChange={set('region')} required placeholder="e.g. tehran-edge" /></Field>
          <div className="form-grid">
            <Field label="Public host" hint="hostname or IP clients dial">
              <input value={form.host} onChange={set('host')} required autoCapitalize="none" spellCheck="false" />
            </Field>
            <Field label="Port">
              <input type="number" inputMode="numeric" min="1" max="65535" value={form.port} onChange={set('port')} required />
            </Field>
          </div>
          <Field label="How clients reach it">
            <select value={form.transport} onChange={set('transport')}>
              <option value="reality">REALITY — borrows a real site&apos;s TLS (recommended)</option>
              <option value="ws">WebSocket behind a reverse proxy</option>
            </select>
          </Field>
          {reality ? (
            <>
              <Field
                label="Borrowed site"
                hint="host:port. Its handshake is what a censor sees, and anyone who is not a subscriber is forwarded there."
              >
                <input
                  value={form.realityDest}
                  onChange={set('realityDest')}
                  required
                  autoCapitalize="none"
                  spellCheck="false"
                  placeholder="www.microsoft.com:443"
                />
              </Field>
              <p className="hint">
                Pick a site that speaks TLS 1.3 and HTTP/2, is not blocked where your
                subscribers are, and is not yours. The key pair and short IDs are
                issued here — nothing to run on the box.
              </p>
              <Field label="Priority" hint="lower wins">
                <input type="number" inputMode="numeric" min="1" max="1000" value={form.priority} onChange={set('priority')} />
              </Field>
            </>
          ) : (
            <>
              <Field label="TLS" hint="Jordan will not advertise TLS a gateway cannot actually serve">
                <select value={form.tlsMode} onChange={set('tlsMode')}>
                  <option value="reverse-proxy">Terminated by a reverse proxy (recommended)</option>
                  <option value="none">None — plaintext WebSocket</option>
                </select>
              </Field>
              {form.tlsMode === 'reverse-proxy' && (
                <div className="form-grid">
                  <Field label="Xray loopback port" hint="what the proxy forwards to">
                    <input type="number" inputMode="numeric" value={form.listenPort} onChange={set('listenPort')} required />
                  </Field>
                  <Field label="SNI / TLS host">
                    <input value={form.sni} onChange={set('sni')} autoCapitalize="none" spellCheck="false" />
                  </Field>
                </div>
              )}
              <div className="form-grid">
                <Field label="WebSocket path"><input value={form.wsPath} onChange={set('wsPath')} /></Field>
                <Field label="Priority" hint="lower wins">
                  <input type="number" inputMode="numeric" min="1" max="1000" value={form.priority} onChange={set('priority')} />
                </Field>
              </div>
            </>
          )}
          {error && <p className="form-error" role="alert">{error}</p>}
          <Button type="submit" loading={busy} icon="plus">Register gateway</Button>
        </form>
      )}
    </Sheet>
  );
}

export function Gateways() {
  const { data, error, loading, stale, updatedAt, refresh } = useResource('gateways', api.gateways, { intervalMs: 20000 });
  const [adding, setAdding] = useState(false);
  const [checking, setChecking] = useState(false);

  const checkAll = async () => {
    setChecking(true);
    try {
      await Promise.allSettled((data || []).map((g) => api.checkGateway(g.id)));
      await refresh();
    } finally {
      setChecking(false);
    }
  };

  return (
    <>
      <StaleBanner stale={stale} updatedAt={updatedAt} error={error} />
      <div className="toolbar">
        <Button icon="plus" onClick={() => setAdding(true)}>Add gateway</Button>
        <Button variant="ghost" icon="refresh" loading={checking} onClick={checkAll} disabled={!data?.length}>
          Check all
        </Button>
      </div>

      {loading && !data && <Skeleton rows={3} />}
      {error && !data && <ErrorState error={error} onRetry={refresh} />}
      {data?.length === 0 && (
        <EmptyState
          icon="gateway"
          title="No gateways registered"
          body="A gateway is the address clients dial. Register one, then run its agent to deploy configuration."
          action={<Button icon="plus" onClick={() => setAdding(true)}>Add gateway</Button>}
        />
      )}
      {data?.map((gateway) => <GatewayCard key={gateway.id} gateway={gateway} />)}

      <AddGatewaySheet open={adding} onClose={() => setAdding(false)} onCreated={refresh} />
    </>
  );
}
