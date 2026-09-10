import { useState } from 'react';
import { api } from '../lib/api.js';
import { Card, Section, Button, Row, Field, CopyButton } from '../components/ui.jsx';
import { Qr } from '../components/Qr.jsx';

/**
 * Two-factor on the operator account.
 *
 * Enrolment is deliberately two steps: the secret is issued and stored dormant,
 * and only a code from the authenticator switches it on. A secret that was
 * mis-scanned therefore costs a retry rather than the fleet.
 *
 * The recovery codes come back once, from the confirm call, and are never
 * readable again — so this screen holds on to them until the operator says
 * they have been written down.
 */
export function TwoFactor({ state, onChanged }) {
  const [enrolment, setEnrolment] = useState(null);   // { secret, uri }
  const [recovery, setRecovery] = useState(null);     // string[] — shown once
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [offCode, setOffCode] = useState('');
  const [showOff, setShowOff] = useState(false);
  const [message, setMessage] = useState(null);
  const [busy, setBusy] = useState(false);

  const run = async (work) => {
    setBusy(true);
    setMessage(null);
    try {
      await work();
    } catch (err) {
      setMessage({ tone: 'bad', text: err.message });
    } finally {
      setBusy(false);
    }
  };

  const start = () => run(async () => {
    setEnrolment(await api.startTwoFactor());
    setCode('');
  });

  const confirm = (event) => {
    event.preventDefault();
    return run(async () => {
      const { recoveryCodes } = await api.confirmTwoFactor(code.trim());
      setRecovery(recoveryCodes);
      setEnrolment(null);
      setCode('');
      await onChanged();
    });
  };

  const disable = (event) => {
    event.preventDefault();
    return run(async () => {
      await api.disableTwoFactor(password, offCode.trim());
      setPassword('');
      setOffCode('');
      setShowOff(false);
      setMessage({ tone: 'ok', text: 'Two-factor is off. The password alone signs in again.' });
      await onChanged();
    });
  };

  // The one moment these exist in readable form.
  if (recovery) {
    return (
      <Section
        title="Write these down"
        hint="Eight recovery codes, each good once. This is the only time they are shown."
      >
        <Card>
          <ul className="code-list">
            {recovery.map((value) => <li key={value}>{value}</li>)}
          </ul>
          <div className="action-row">
            <CopyButton value={recovery.join('\n')} label="Copy all" />
            <Button icon="check" onClick={() => setRecovery(null)}>I have saved them</Button>
          </div>
        </Card>
        <p className="hint">
          Keep them somewhere that is not the phone holding the authenticator —
          they are what gets you back in when that phone is lost.
        </p>
      </Section>
    );
  }

  // Step two: a code proves the authenticator really holds the secret.
  if (enrolment) {
    return (
      <Section title="Scan this, then confirm" hint="Nothing changes until a code from the app arrives.">
        <Card>
          <div className="qr-wrap">
            <Qr value={enrolment.uri} size={200} label="Two-factor enrolment code" />
            <CopyButton value={enrolment.secret} label="Copy the secret" />
          </div>
          <Row label="Secret" value={enrolment.secret} mono />
          <form className="form" onSubmit={confirm}>
            <Field label="Code from the app" hint="six digits">
              <input
                value={code}
                onChange={(e) => setCode(e.target.value)}
                inputMode="numeric"
                autoComplete="one-time-code"
                required
              />
            </Field>
            {message && <p className={message.tone === 'ok' ? 'form-ok' : 'form-error'} role="alert">{message.text}</p>}
            <Button type="submit" loading={busy} icon="shield">Switch it on</Button>
          </form>
        </Card>
        <div className="action-row">
          <Button variant="ghost" onClick={() => { setEnrolment(null); setMessage(null); }}>Cancel</Button>
        </div>
      </Section>
    );
  }

  if (state?.enabled) {
    return (
      <Section title="Two-factor" hint="Sign-in asks for a one-time code as well as the password.">
        <Card>
          <Row label="Status" value="On" />
          <Row label="Recovery codes left" value={String(state.recoveryCodesLeft)} />
        </Card>
        {state.recoveryCodesLeft <= 2 && (
          <p className="hint">
            Few recovery codes left. Switching the factor off and on again issues a fresh set.
          </p>
        )}
        {message && <p className={message.tone === 'ok' ? 'form-ok' : 'form-error'} role="alert">{message.text}</p>}
        {showOff ? (
          <Card>
            <form className="form" onSubmit={disable}>
              <Field label="Password">
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="current-password"
                  required
                />
              </Field>
              <Field label="Code" hint="from the app, or a recovery code">
                <input
                  value={offCode}
                  onChange={(e) => setOffCode(e.target.value)}
                  autoComplete="one-time-code"
                  autoCapitalize="none"
                  spellCheck="false"
                  required
                />
              </Field>
              <Button type="submit" variant="danger" loading={busy} icon="alert">Switch it off</Button>
            </form>
          </Card>
        ) : (
          <div className="action-row">
            <Button variant="ghost" onClick={() => setShowOff(true)}>Switch it off</Button>
          </div>
        )}
      </Section>
    );
  }

  return (
    <Section
      title="Two-factor"
      hint="The password is the only thing between the internet and every gateway. This adds a second."
    >
      <Card>
        <Row label="Status" value={state?.enrolmentStarted ? 'Started, not confirmed' : 'Off'} />
      </Card>
      {message && <p className={message.tone === 'ok' ? 'form-ok' : 'form-error'} role="alert">{message.text}</p>}
      <div className="action-row">
        <Button loading={busy} icon="shield" onClick={start}>
          {state?.enrolmentStarted ? 'Start again' : 'Set it up'}
        </Button>
      </div>
    </Section>
  );
}
