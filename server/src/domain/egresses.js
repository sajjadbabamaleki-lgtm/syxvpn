import { newId } from '../lib/crypto.js';
import { seal, open as openSecret } from '../lib/secretbox.js';
import { recordEvent } from './events.js';
import { reevaluateGateway } from './routing.js';

const SECRET_KINDS = new Set(['socks', 'vless']);

export function listEgresses(db) {
  return db.prepare('SELECT * FROM egresses ORDER BY priority, name').all();
}

export function getEgress(db, id) {
  return db.prepare('SELECT * FROM egresses WHERE id = ?').get(id) || null;
}

/** Returns the egress row with its credential decrypted — agents only. */
export function getEgressWithSecret(db, id) {
  const row = getEgress(db, id);
  if (!row) return null;
  return { ...row, secret: row.secret ? openSecret(row.secret) : null };
}

export function decryptSecrets(rows) {
  return rows.map((r) => ({ ...r, secret: r.secret ? openSecret(r.secret) : null }));
}

export function createEgress(db, input) {
  const now = Date.now();
  const id = newId('eg');
  db.prepare(`INSERT INTO egresses
      (id,name,region,kind,host,port,bind_address,username,secret,tls,sni,transport,ws_path,probe_url,
       priority,weight,enabled,authorization_note,created_at,updated_at)
      VALUES (@id,@name,@region,@kind,@host,@port,@bindAddress,@username,@secret,@tls,@sni,@transport,@wsPath,@probeUrl,
              @priority,@weight,@enabled,@authorizationNote,@now,@now)`)
    .run({
      id,
      name: input.name,
      region: input.region,
      kind: input.kind,
      host: input.host ?? null,
      port: input.port ?? null,
      bindAddress: input.bindAddress ?? null,
      username: input.username ?? null,
      secret: input.secret && SECRET_KINDS.has(input.kind) ? seal(input.secret) : null,
      tls: input.tls ? 1 : 0,
      sni: input.sni ?? null,
      transport: input.transport ?? 'tcp',
      wsPath: input.wsPath ?? null,
      probeUrl: input.probeUrl ?? null,
      priority: input.priority ?? 100,
      weight: input.weight ?? 1,
      enabled: input.enabled === false ? 0 : 1,
      authorizationNote: input.authorizationNote ?? null,
      now,
    });
  recordEvent(db, {
    type: 'egress.created', targetType: 'egress', targetId: id,
    message: `Egress ${input.name} registered (${input.kind})`,
  });
  return getEgress(db, id);
}

const PATCH_COLUMNS = {
  name: 'name', region: 'region', host: 'host', port: 'port', bindAddress: 'bind_address',
  username: 'username', tls: 'tls', sni: 'sni', transport: 'transport', wsPath: 'ws_path',
  probeUrl: 'probe_url', priority: 'priority', weight: 'weight', enabled: 'enabled',
  authorizationNote: 'authorization_note',
};

export function updateEgress(db, id, patch) {
  const current = getEgress(db, id);
  if (!current) return null;
  const fields = [];
  const params = [];
  for (const [key, column] of Object.entries(PATCH_COLUMNS)) {
    if (patch[key] === undefined) continue;
    let value = patch[key];
    if (typeof value === 'boolean') value = value ? 1 : 0;
    fields.push(`${column} = ?`);
    params.push(value);
  }
  if (patch.secret !== undefined) {
    fields.push('secret = ?');
    params.push(patch.secret ? seal(patch.secret) : null);
  }
  if (!fields.length) return current;
  params.push(Date.now(), id);
  db.prepare(`UPDATE egresses SET ${fields.join(', ')}, updated_at = ? WHERE id = ?`).run(...params);

  // Disabling or reprioritising an egress can change every route that uses it.
  for (const row of db.prepare('SELECT gateway_id FROM gateway_egress WHERE egress_id = ?').all(id)) {
    reevaluateGateway(db, row.gateway_id, 'egress-updated');
  }
  return getEgress(db, id);
}

export function deleteEgress(db, id) {
  const egress = getEgress(db, id);
  if (!egress) return false;
  const gateways = db.prepare('SELECT gateway_id FROM gateway_egress WHERE egress_id = ?').all(id);
  db.prepare('DELETE FROM egresses WHERE id = ?').run(id);
  recordEvent(db, {
    type: 'egress.deleted', severity: 'warning', targetType: 'egress', targetId: id,
    message: `Egress ${egress.name} removed`,
  });
  for (const row of gateways) reevaluateGateway(db, row.gateway_id, 'egress-deleted');
  return true;
}

export function assignEgress(db, gatewayId, egressId, priority = 100) {
  db.prepare(`INSERT INTO gateway_egress (gateway_id,egress_id,priority,status,created_at)
      VALUES (?,?,?, 'unknown', ?)
      ON CONFLICT(gateway_id,egress_id) DO UPDATE SET priority = excluded.priority`)
    .run(gatewayId, egressId, priority, Date.now());
  return reevaluateGateway(db, gatewayId, 'egress-assigned');
}

export function unassignEgress(db, gatewayId, egressId) {
  const info = db.prepare('DELETE FROM gateway_egress WHERE gateway_id=? AND egress_id=?').run(gatewayId, egressId);
  reevaluateGateway(db, gatewayId, 'egress-unassigned');
  return info.changes > 0;
}
