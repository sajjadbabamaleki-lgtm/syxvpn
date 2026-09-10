import { logger } from '../logger.js';

export const EVENT = {
  GATEWAY_ONLINE: 'gateway.online',
  GATEWAY_OFFLINE: 'gateway.offline',
  GATEWAY_DEGRADED: 'gateway.degraded',
  GATEWAY_CREATED: 'gateway.created',
  GATEWAY_DELETED: 'gateway.deleted',
  AGENT_KEY_ROTATED: 'agent.key_rotated',
  AGENT_HEARTBEAT_MISSED: 'agent.heartbeat_missed',
  AGENT_RECOVERED: 'agent.recovered',
  CONFIG_DEPLOYED: 'config.deployed',
  CONFIG_REJECTED: 'config.rejected',
  EGRESS_ONLINE: 'egress.online',
  EGRESS_UNAVAILABLE: 'egress.unavailable',
  ROUTE_SWITCHED: 'route.switched',
  ROUTE_UNAVAILABLE: 'route.unavailable',
  SUBSCRIBER_CREATED: 'subscriber.created',
  SUBSCRIBER_DISABLED: 'subscriber.disabled',
  SUBSCRIBER_ENABLED: 'subscriber.enabled',
  SUBSCRIBER_EXPIRED: 'subscriber.expired',
  QUOTA_EXHAUSTED: 'subscriber.quota_exhausted',
  CREDENTIAL_ROTATED: 'subscriber.credential_rotated',
  TOKEN_ROTATED: 'subscriber.token_rotated',
  ADMIN_LOGIN_FAILED: 'admin.login_failed',
  BACKUP_TAKEN: 'backup.taken',
  BACKUP_FAILED: 'backup.failed',
  // Downloading a snapshot takes every credential in the fleet off the machine
  // in one file. It is recorded like the serious thing it is.
  BACKUP_DOWNLOADED: 'backup.downloaded',
};

export function recordEvent(db, { type, severity = 'info', targetType = null, targetId = null, message, data = null }) {
  const now = Date.now();
  db.prepare(
    'INSERT INTO events (type, severity, target_type, target_id, message, data, created_at) VALUES (?,?,?,?,?,?,?)',
  ).run(type, severity, targetType, targetId, message, data ? JSON.stringify(data) : null, now);
  if (severity !== 'info') logger.warn(`event ${type}`, { targetId, message });
  else logger.debug(`event ${type}`, { targetId, message });
}

export function listEvents(db, { limit = 50, severity, targetId, before } = {}) {
  const clauses = [];
  const params = [];
  if (severity) { clauses.push('severity = ?'); params.push(severity); }
  if (targetId) { clauses.push('target_id = ?'); params.push(targetId); }
  if (before) { clauses.push('created_at < ?'); params.push(before); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  params.push(Math.min(Number(limit) || 50, 200));
  return db.prepare(`SELECT * FROM events ${where} ORDER BY created_at DESC, id DESC LIMIT ?`).all(...params)
    .map((e) => ({
      id: e.id,
      type: e.type,
      severity: e.severity,
      targetType: e.target_type,
      targetId: e.target_id,
      message: e.message,
      data: e.data ? JSON.parse(e.data) : null,
      createdAt: new Date(e.created_at).toISOString(),
    }));
}

/** Keeps the event log bounded; called from the monitor loop. */
export function pruneEvents(db, keep = 5000) {
  db.prepare(
    'DELETE FROM events WHERE id NOT IN (SELECT id FROM events ORDER BY id DESC LIMIT ?)',
  ).run(keep);
}

export function pruneHealthChecks(db, keep = 5000) {
  db.prepare(
    'DELETE FROM health_checks WHERE id NOT IN (SELECT id FROM health_checks ORDER BY id DESC LIMIT ?)',
  ).run(keep);
}
