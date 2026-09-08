import { config } from './config.js';

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const threshold = LEVELS[config.logLevel] ?? LEVELS.info;

// Keys whose values must never reach a log line.
const SECRET_KEYS = new Set([
  'password', 'passwordHash', 'token', 'tokenHash', 'agentKey', 'agentKeyHash',
  'secret', 'authorization', 'signature', 'uuid', 'credential', 'privateKey',
  'egressSecret', 'egress_secret', 'sessionToken', 'subscriptionToken',
]);

/** Redacts secrets and truncates long values so logs stay safe to ship. */
export function redact(value, depth = 0) {
  if (value === null || value === undefined) return value;
  if (depth > 4) return '[deep]';
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => redact(v, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SECRET_KEYS.has(k) ? '[redacted]' : redact(v, depth + 1);
    }
    return out;
  }
  if (typeof value === 'string' && value.length > 512) return `${value.slice(0, 512)}…`;
  return value;
}

function emit(level, msg, fields) {
  if (LEVELS[level] > threshold) return;
  const line = { ts: new Date().toISOString(), level, msg, ...redact(fields || {}) };
  const out = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
  out.write(`${JSON.stringify(line)}\n`);
}

export const logger = {
  error: (msg, fields) => emit('error', msg, fields),
  warn: (msg, fields) => emit('warn', msg, fields),
  info: (msg, fields) => emit('info', msg, fields),
  debug: (msg, fields) => emit('debug', msg, fields),
};
