import { useState } from 'react';
import { api, auth } from '../lib/api.js';
import { useResource } from '../lib/useResource.js';
import { useBack } from '../lib/router.js';
import { Card, Section, Button, Row, Field } from '../components/ui.jsx';
import { Icon } from '../components/Icon.jsx';
import { TwoFactor } from './TwoFactor.jsx';
import { absoluteTime, relativeTime } from '../lib/format.js';

export function Settings({ onSignedOut }) {
  const back = useBack('/admin/more');
  const session = auth.current;
  const { data: health } = useResource('control-plane-health', api.health, { intervalMs: 30000 });
  // It changes rarely, and every change to it is made from this screen, so it
  // is refreshed on demand; the interval is only there to catch a change made
  // from another browser.
  const { data: twoFactor, refresh: refreshTwoFactor } =
    useResource('admin-two-factor', api.twoFactor, { intervalMs: 60000 });
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [message, setMessage] = useState(null);
  const [busy, setBusy] = useState(false);

  const changePassword = async (event) => {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      await api.changePassword(current, next);
      setMessage({ tone: 'ok', text: 'Password changed. All sessions were revoked — sign in again.' });
      setCurrent('');
      setNext('');
      setTimeout(() => { auth.signOut(); onSignedOut(); }, 1500);
    } catch (err) {
      setMessage({ tone: 'bad', text: err.message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button type="button" className="back" onClick={back}><Icon name="back" size={18} /> More</button>

      <Section title="Session">
        <Card>
          <Row label="Operator" value={session?.admin?.username || '—'} />
          <Row label="Expires" value={session ? `${absoluteTime(session.expiresAt)} · ${relativeTime(session.expiresAt)}` : '—'} />
        </Card>
        <div className="action-row">
          <Button variant="ghost" icon="logout" onClick={async () => { await api.signOut(); onSignedOut(); }}>
            Sign out
          </Button>
        </div>
      </Section>

      <Section title="Control plane">
        <Card>
          <Row label="Version" value={health?.version || '—'} />
          <Row label="Uptime" value={health ? `${Math.round(health.uptimeSeconds / 60)} min` : '—'} />
          <Row label="API base" value={import.meta.env.VITE_API_URL || 'same origin'} mono />
        </Card>
      </Section>

      <TwoFactor state={twoFactor} onChanged={refreshTwoFactor} />

      <Section title="Change password" hint="Changing it signs out every session, including this one.">
        <Card>
          <form className="form" onSubmit={changePassword}>
            <Field label="Current password">
              <input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} required autoComplete="current-password" />
            </Field>
            <Field label="New password" hint="at least 12 characters">
              <input type="password" value={next} onChange={(e) => setNext(e.target.value)} required minLength={12} autoComplete="new-password" />
            </Field>
            {message && <p className={message.tone === 'ok' ? 'form-ok' : 'form-error'} role="alert">{message.text}</p>}
            <Button type="submit" loading={busy} icon="shield">Change password</Button>
          </form>
        </Card>
      </Section>
    </>
  );
}
