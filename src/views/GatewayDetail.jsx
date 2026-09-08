import { useState } from 'react';
import { api } from '../lib/api.js';
import { useResource, invalidate } from '../lib/useResource.js';
import { navigate, useBack } from '../lib/router.js';
import {
  Card, Section, Button, Row, Skeleton, ErrorState, StatusPill, Sheet, Field, CopyButton, EmptyState,
} from '../components/ui.jsx';
import { Icon } from '../components/Icon.jsx';
import { latency, relativeTime, absoluteTime, tone } from '../lib/format.js';

function AssignEgressSheet({ open, onClose, gatewayId, assigned, onDone }) {
  const { data: egresses } = useResource('egresses', api.egresses, { intervalMs: 60000, enabled: open });
  const [priority, setPriority] = useState(100);
  const [selected, setSelected] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const available = (egresses || []).filter((e) => !assigned.some((a) => a.id === e.id));

  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.assignEgress(gatewayId, { egressId: selected, priority: Number(priority) });
      invalidate(`gateway:${gatewayId}`);
      invalidate('routes');
      onDone?.();
      onClose();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet open={open} title="Assign egress path" onClose={onClose}>
      {available.length === 0 ? (
        <EmptyState
          icon="globe"
          title="No unassigned egress paths"
          body="Register an authorized egress first."
          action={<Button onClick={() => { onClose(); navigate('/egresses'); }}>Go to egress paths</Button>}
        />
      ) : (
        <form className="form" onSubmit={submit}>
          <Field label="Egress path">
            <select value={selected} onChange={(e) => setSelected(e.target.value)} required>
              <option value="" disabled>Select…</option>
              {available.map((e) => (
                <option key={e.id} value={e.id}>{e.name} · {e.kind} · {e.region}</option>
              ))}
            </select>
          </Field>
          <Field label="Priority on this gateway" hint="lower wins; equal ranks never flap">
            <input type="number" inputMode="numeric" min="1" max="1000" value={priority} onChange={(e) => setPriority(e.target.value)} />
          </Field>
          {error && <p className="form-error" role="alert">{error}</p>}
          <Button type="submit" loading={busy} icon="plus">Assign</Button>
        </form>
      )}
    </Sheet>
  );
}

export function GatewayDetail({ id }) {
  const back = useBack('/gateways');
  const { data, error, loading, refresh } = useResource(`gateway:${id}`, () => api.gateway(id), { intervalMs: 15000 });
  const [assigning, setAssigning] = useState(false);
  const [busy, setBusy] = useState(null);
  const [rotated, setRotated] = useState(null);

  const act = async (name, fn) => {
    setBusy(name);
    try {
      const result = await fn();
      invalidate(`gateway:${id}`);
      invalidate('gateways');
      invalidate('routes');
      await refresh();
      return result;
    } finally {
      setBusy(null);
    }
  };

  if (loading && !data) return <Skeleton rows={5} />;
  if (error && !data) return <ErrorState error={error} onRetry={refresh} />;
  if (!data) return null;

  return (
    <>
      <button type="button" className="back" onClick={back}><Icon name="back" size={18} /> Gateways</button>

      <Card className={`state-card state-${tone(data.ingress.status)}`}>
        <div className="state-head">
          <span className="state-label">{data.region}</span>
          <span className="state-name">{data.name}</span>
        </div>
        <div className="chip-row">
          <StatusPill status={data.ingress.status} label={`ingress ${data.ingress.status}`} />
          <StatusPill status={data.agent.status} label={`agent ${data.agent.status}`} />
          <span className={`chip chip-${data.config.inSync ? 'ok' : 'warn'}`}>
            config v{data.config.version}{data.config.inSync ? ' deployed' : ' pending'}
          </span>
        </div>
        {data.ingress.detail && <p className="state-body">{data.ingress.detail}</p>}
      </Card>

      <div className="action-grid">
        <Button icon="refresh" loading={busy === 'check'} onClick={() => act('check', () => api.checkGateway(id))}>
          Check now
        </Button>
        <Button
          variant="ghost"
          icon={data.enabled ? 'close' : 'check'}
          loading={busy === 'toggle'}
          onClick={() => act('toggle', () => api.updateGateway(id, { enabled: !data.enabled }))}
        >
          {data.enabled ? 'Disable' : 'Enable'}
        </Button>
      </div>

      <Section title="Endpoint">
        <Card>
          <Row label="Host" value={`${data.host}:${data.port}`} mono />
          <Row label="Protocol" value={`${data.protocol.toUpperCase()} over ${data.transport.toUpperCase()}`} />
          <Row label="TLS" value={data.tlsMode === 'none' ? 'none (plaintext)' : data.tlsMode} />
          {data.sni && <Row label="SNI" value={data.sni} mono />}
          <Row label="WebSocket path" value={data.wsPath} mono />
          {data.wsHost && <Row label="WebSocket host header" value={data.wsHost} mono />}
          <Row label="Xray binds" value={`${data.listenAddress}:${data.listenPort || data.port}`} mono />
          <Row label="Priority" value={data.priority} />
          <Row label="Latency" value={latency(data.ingress.latencyMs)} />
          <Row label="Last check" value={relativeTime(data.ingress.checkedAt)} />
        </Card>
      </Section>

      <Section
        title="Egress paths"
        hint="Measured from this gateway"
        action={<Button variant="ghost" icon="plus" onClick={() => setAssigning(true)}>Assign</Button>}
      >
        {data.egresses.length === 0 ? (
          <EmptyState
            icon="globe"
            title="No egress assigned"
            body="Without an authorized egress this gateway fails closed: it accepts nothing onward."
            action={<Button icon="plus" onClick={() => setAssigning(true)}>Assign egress</Button>}
          />
        ) : data.egresses.map((egress) => (
          <Card key={egress.id} className="list-card">
            <div className="list-main">
              <div className="list-title">
                <strong>{egress.name}</strong>
                {egress.active && <span className="chip chip-ok">active</span>}
                <StatusPill status={egress.pairStatus} label={egress.pairStatus} />
              </div>
              <div className="list-meta">
                <span>{egress.kind}</span>
                <span>priority {egress.assignedPriority}</span>
                <span>{latency(egress.pairLatencyMs)}</span>
              </div>
              {egress.pairDetail && <p className="detail-note">{egress.pairDetail}</p>}
            </div>
            <button
              type="button"
              className="icon-btn"
              aria-label={`Unassign ${egress.name}`}
              onClick={() => act('unassign', () => api.unassignEgress(id, egress.id))}
            >
              <Icon name="trash" size={18} />
            </button>
          </Card>
        ))}
      </Section>

      <Section title="Agent">
        <Card>
          <Row label="Status" value={data.agent.status} />
          <Row label="Agent version" value={data.agent.version || '—'} />
          <Row label="Xray version" value={data.agent.xrayVersion || '—'} />
          <Row label="Last seen" value={relativeTime(data.agent.lastSeenAt)} />
          <Row label="Key issued" value={data.agent.keyIssued ? `${data.agent.keyHint}… ${relativeTime(data.agent.keyIssuedAt)}` : 'never'} mono />
          <Row label="Config deployed" value={data.config.deployedVersion ? `v${data.config.deployedVersion} · ${absoluteTime(data.config.deployedAt)}` : 'never'} />
          {data.config.error && <p className="inline-error">{data.config.error}</p>}
        </Card>
        <div className="action-row">
          <Button
            variant="ghost"
            icon="key"
            loading={busy === 'key'}
            onClick={async () => {
              const result = await act('key', () => api.rotateAgentKey(id));
              setRotated(result.agentKey);
            }}
          >
            Rotate agent key
          </Button>
        </div>
      </Section>

      <Section title="Route history">
        {data.lastSwitch ? (
          <Card>
            <Row label="Last switch" value={relativeTime(data.lastSwitch.createdAt)} />
            <Row label="Reason" value={data.lastSwitch.reason} />
          </Card>
        ) : <Card className="quiet">No egress switch recorded.</Card>}
      </Section>

      <Section title="Recent checks">
        {data.recentChecks.length === 0 ? (
          <Card className="quiet">No checks recorded yet.</Card>
        ) : (
          <ul className="event-list">
            {data.recentChecks.slice(0, 10).map((check) => (
              <li key={check.id} className={`event event-${tone(check.status)}`}>
                <div className="event-main">
                  <span className="event-type">{check.kind} · {check.source}</span>
                  <p>{check.detail || check.status}</p>
                </div>
                <time>{relativeTime(check.createdAt)}</time>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <AssignEgressSheet
        open={assigning}
        onClose={() => setAssigning(false)}
        gatewayId={id}
        assigned={data.egresses}
        onDone={refresh}
      />

      <Sheet open={Boolean(rotated)} title="New agent key" onClose={() => setRotated(null)}>
        <div className="result">
          <p className="warn-note">
            Shown once. The previous key stopped working immediately — update the agent now
            or this gateway will stop receiving configuration.
          </p>
          <code className="token-box">{rotated}</code>
          <div className="action-row">
            <CopyButton value={rotated || ''} label="Copy agent key" />
            <Button variant="ghost" onClick={() => setRotated(null)}>Done</Button>
          </div>
        </div>
      </Sheet>
    </>
  );
}
