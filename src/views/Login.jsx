import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api.js';
import { Button, Field } from '../components/ui.jsx';
import { Logo } from '../components/Logo.jsx';

export function Login({ onSignedIn }) {
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  // The account has a second factor. Learned from the server on the first
  // attempt rather than assumed: the console has no way to know before then,
  // and asking everyone for a code they do not have would be worse.
  const [needsCode, setNeedsCode] = useState(false);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const codeInput = useRef(null);

  useEffect(() => { if (needsCode) codeInput.current?.focus(); }, [needsCode]);

  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.signIn(username, password, needsCode ? code : undefined);
      onSignedIn();
    } catch (err) {
      if (err.code === 'TOTP_REQUIRED') {
        setNeedsCode(true);
        setCode('');
      } else if (err.code === 'RATE_LIMITED') {
        setError('Too many attempts. Wait a minute and try again.');
      } else if (needsCode) {
        // The password got this far, so what failed is the code — and a code
        // is only ever good once, so the next attempt needs the next one.
        setError('That code did not match. Try the next one your app shows.');
        setCode('');
      } else {
        setError(err.message);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login">
      <div className="login-brand">
        <Logo size={40} className="mark-logo" />
        <div>
          <h1>SixVPN</h1>
          <p>Control plane</p>
        </div>
      </div>

      <form className="login-form" onSubmit={submit}>
        <Field label="Operator">
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            autoCapitalize="none"
            spellCheck="false"
            required
          />
        </Field>
        <Field label="Password">
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
          />
        </Field>
        {needsCode && (
          <Field label="One-time code" hint="from your authenticator app, or a recovery code">
            <input
              ref={codeInput}
              value={code}
              onChange={(e) => setCode(e.target.value)}
              inputMode="text"
              autoComplete="one-time-code"
              autoCapitalize="none"
              spellCheck="false"
              required
            />
          </Field>
        )}
        {error && <p className="form-error" role="alert">{error}</p>}
        <Button type="submit" loading={busy} icon="shield">Sign in</Button>
      </form>

      <p className="login-note">
        Sessions expire automatically. Management, gateway and subscriber data are
        never served without authentication.
      </p>
    </div>
  );
}
