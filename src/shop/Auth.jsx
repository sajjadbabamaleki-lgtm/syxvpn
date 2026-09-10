import { useState } from 'react';
import { shop } from '../lib/shopApi.js';
import { Button, Field } from '../components/ui.jsx';
import { Logo } from '../components/Logo.jsx';

/** One screen for both sign in and sign up; a phone keyboard is enough. */
export function Auth({ onDone }) {
  const [mode, setMode] = useState('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (mode === 'signin') await shop.signIn(email, password);
      else await shop.register(email, password);
      onDone();
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
        <Logo size={40} className="mark-logo" />
        <div>
          <h1>cVPN</h1>
          <p>{mode === 'signin' ? 'Sign in to your account' : 'Create an account'}</p>
        </div>
      </div>

      <form className="login-form" onSubmit={submit}>
        <Field label="Email">
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
            autoCapitalize="none"
            spellCheck="false"
            inputMode="email"
            required
          />
        </Field>
        <Field label="Password" hint={mode === 'register' ? 'at least 8 characters' : undefined}>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
            minLength={8}
            required
          />
        </Field>
        {error && <p className="form-error" role="alert">{error}</p>}
        <Button type="submit" loading={busy}>
          {mode === 'signin' ? 'Sign in' : 'Create account'}
        </Button>
      </form>

      <button
        type="button"
        className="link-btn"
        onClick={() => { setMode(mode === 'signin' ? 'register' : 'signin'); setError(null); }}
      >
        {mode === 'signin' ? 'No account yet? Create one' : 'Already have an account? Sign in'}
      </button>

      <p className="login-note">
        Your account holds one subscription. Buying again extends the same one, so the
        config already loaded in your app keeps working.
      </p>
    </div>
  );
}
