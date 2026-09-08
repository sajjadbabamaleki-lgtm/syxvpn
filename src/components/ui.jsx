import { useEffect, useRef, useState } from 'react';
import { Icon } from './Icon.jsx';
import { tone } from '../lib/format.js';

export function StatusDot({ status, size = 8 }) {
  return <span className={`dot dot-${tone(status)}`} style={{ width: size, height: size }} aria-hidden="true" />;
}

export function StatusPill({ status, label }) {
  return (
    <span className={`pill pill-${tone(status)}`}>
      <StatusDot status={status} size={6} />
      <span className="pill-label">{label || status}</span>
    </span>
  );
}

export function Card({ children, className = '', ...rest }) {
  return <div className={`card ${className}`} {...rest}>{children}</div>;
}

export function Section({ title, action, children, hint }) {
  return (
    <section className="section">
      {(title || action) && (
        <header className="section-head">
          <div>
            <h2>{title}</h2>
            {hint && <p className="hint">{hint}</p>}
          </div>
          {action}
        </header>
      )}
      {children}
    </section>
  );
}

export function Button({ variant = 'primary', icon, children, loading, ...rest }) {
  return (
    <button type="button" className={`btn btn-${variant}`} disabled={loading || rest.disabled} {...rest}>
      {icon && <Icon name={icon} size={17} />}
      {loading ? 'Working…' : children}
    </button>
  );
}

export function EmptyState({ icon = 'alert', title, body, action }) {
  return (
    <div className="empty">
      <Icon name={icon} size={26} />
      <h3>{title}</h3>
      {body && <p>{body}</p>}
      {action}
    </div>
  );
}

export function Skeleton({ rows = 3 }) {
  return (
    <div className="skeleton" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => <div key={i} className="skeleton-row" />)}
    </div>
  );
}

export function ErrorState({ error, onRetry }) {
  const offline = error?.code === 'NETWORK';
  return (
    <div className="empty empty-error">
      <Icon name="alert" size={26} />
      <h3>{offline ? 'Control plane unreachable' : 'Request failed'}</h3>
      <p>{error?.message || 'Unknown error'}</p>
      {onRetry && <Button variant="ghost" icon="refresh" onClick={onRetry}>Retry</Button>}
    </div>
  );
}

export function StaleBanner({ stale, updatedAt, error }) {
  if (!stale) return null;
  return (
    <div className="stale" role="status">
      <Icon name="clock" size={15} />
      <span>
        Showing last known data
        {updatedAt ? ` from ${new Date(updatedAt).toLocaleTimeString()}` : ''}
        {error?.code === 'NETWORK' ? ' — control plane unreachable' : ''}
      </span>
    </div>
  );
}

export function CopyButton({ value, label = 'Copy', className = '' }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      // Clipboard API needs a secure context; fall back to a selectable prompt.
      window.prompt('Copy this value', value);
    }
    setCopied(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1600);
  };

  return (
    <button type="button" className={`btn btn-ghost ${className}`} onClick={copy}>
      <Icon name={copied ? 'check' : 'copy'} size={16} />
      {copied ? 'Copied' : label}
    </button>
  );
}

export function Field({ label, hint, children, error }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && !error && <span className="field-hint">{hint}</span>}
      {error && <span className="field-error">{error}</span>}
    </label>
  );
}

export function Sheet({ open, title, onClose, children, footer }) {
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="sheet-backdrop" onClick={onClose} role="presentation">
      <div className="sheet" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label={title}>
        <header className="sheet-head">
          <h2>{title}</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
            <Icon name="close" size={20} />
          </button>
        </header>
        <div className="sheet-body">{children}</div>
        {footer && <footer className="sheet-foot">{footer}</footer>}
      </div>
    </div>
  );
}

export function Metric({ label, value, sub, status }) {
  return (
    <div className="metric">
      <span className="metric-label">{label}</span>
      <strong className={status ? `metric-value tone-${tone(status)}` : 'metric-value'}>{value}</strong>
      {sub && <span className="metric-sub">{sub}</span>}
    </div>
  );
}

export function Row({ label, value, mono }) {
  return (
    <div className="row">
      <span className="row-label">{label}</span>
      <span className={mono ? 'row-value mono' : 'row-value'}>{value}</span>
    </div>
  );
}

export function Meter({ fraction, status = 'ok' }) {
  const pct = Math.max(0, Math.min(1, fraction || 0)) * 100;
  return (
    <div className="meter" role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}>
      <div className={`meter-fill tone-bg-${status}`} style={{ width: `${pct}%` }} />
    </div>
  );
}
