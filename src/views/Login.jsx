import { useState } from 'react';
import { api } from '../lib/api.js';
import { Button, Field } from '../components/ui.jsx';

export function Login({ onSignedIn }) {
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.signIn(username, password);
      onSignedIn();
    } catch (err) {
      setError(err.code === 'RATE_LIMITED'
        ? 'Too many attempts. Wait a minute and try again.'
        : err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login">
      <div className="login-brand">
        <div className="mark">J</div>
        <div>
          <h1>JORDAN</h1>
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
