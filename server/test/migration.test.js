import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { migrate } from '../src/db/index.js';
import { migrations } from '../src/db/migrations.js';
import { sha256 } from '../src/lib/crypto.js';

/** Recreates the 0.1 prototype schema exactly as it shipped. */
function legacyDatabase() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE subscribers(id TEXT PRIMARY KEY,name TEXT NOT NULL,token TEXT UNIQUE NOT NULL,
      quota_bytes INTEGER NOT NULL DEFAULT 10737418240,used_bytes INTEGER NOT NULL DEFAULT 0,
      expires_at TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE gateways(id TEXT PRIMARY KEY,name TEXT NOT NULL,region TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('gateway','egress')),host TEXT NOT NULL,port INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'unknown',latency_ms INTEGER,throughput_mbps INTEGER DEFAULT 0,
      last_check TEXT,priority INTEGER NOT NULL DEFAULT 100,tls INTEGER NOT NULL DEFAULT 0,
      sni TEXT,ws_path TEXT DEFAULT '/ws',ws_host TEXT);
    CREATE TABLE credentials(subscriber_id TEXT PRIMARY KEY,uuid TEXT UNIQUE NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE health_events(id INTEGER PRIMARY KEY AUTOINCREMENT,gateway_id TEXT,status TEXT,
      latency_ms INTEGER,checked_at TEXT);
    CREATE TABLE usage_events(id INTEGER PRIMARY KEY AUTOINCREMENT,subscriber_id TEXT,bytes INTEGER,
      source TEXT,created_at TEXT);
  `);
  return db;
}

test('migration from the 0.1 prototype schema', async (t) => {
  const db = legacyDatabase();
  db.prepare('INSERT INTO subscribers(id,name,token,quota_bytes,used_bytes,expires_at,status) VALUES (?,?,?,?,?,?,?)')
    .run('jr-1', 'Existing user', 'legacy-token-value-abc', 5368709120, 1024, '2030-01-01T00:00:00.000Z', 'active');
  db.prepare('INSERT INTO gateways(id,name,region,kind,host,port,tls,ws_path,priority) VALUES (?,?,?,?,?,?,?,?,?)')
    .run('gw-1', 'Old edge', 'tehran', 'gateway', 'edge.example.net', 8443, 1, '/ws2', 50);
  db.prepare('INSERT INTO gateways(id,name,region,kind,host,port) VALUES (?,?,?,?,?,?)')
    .run('eg-1', 'Old uplink', 'eu', 'egress', 'uplink.example.net', 443);
  db.prepare('INSERT INTO credentials(subscriber_id,uuid) VALUES (?,?)')
    .run('jr-1', 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');

  migrate(db);
  t.after(() => db.close());

  await t.test('splits the single node table into gateways and egresses', () => {
    const gateways = db.prepare('SELECT * FROM gateways').all();
    assert.equal(gateways.length, 1);
    assert.equal(gateways[0].id, 'gw-1');
    assert.equal(gateways[0].ws_path, '/ws2');
    // tls=1 in the prototype meant "a proxy in front terminates TLS".
    assert.equal(gateways[0].tls_mode, 'reverse-proxy');

    const egresses = db.prepare('SELECT * FROM egresses').all();
    assert.equal(egresses.length, 1);
    assert.equal(egresses[0].id, 'eg-1');
    assert.match(egresses[0].authorization_note, /verify authorization/);
  });

  await t.test('keeps existing subscription URLs working by hashing the token in place', () => {
    const row = db.prepare('SELECT * FROM subscribers WHERE id = ?').get('jr-1');
    assert.equal(row.token_hash, sha256('legacy-token-value-abc'));
    assert.equal(row.token_prefix, 'legacy');
    assert.equal(row.used_bytes, 1024);
    assert.equal(row.quota_bytes, 5368709120);
    assert.equal(new Date(row.expires_at).toISOString(), '2030-01-01T00:00:00.000Z');
  });

  await t.test('preserves issued credentials', () => {
    const credential = db.prepare('SELECT * FROM credentials WHERE subscriber_id = ?').get('jr-1');
    assert.equal(credential.uuid, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
    assert.equal(credential.state, 'active');
  });

  await t.test('drops the legacy tables once imported', () => {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
    assert.ok(!tables.some((n) => n.startsWith('legacy_')));
  });

  await t.test('is idempotent', () => {
    migrate(db);
    assert.equal(db.prepare('SELECT count(*) AS n FROM gateways').get().n, 1);
    assert.equal(db.prepare('SELECT count(*) AS n FROM subscribers').get().n, 1);
  });
});

test('a fresh database migrates cleanly', () => {
  const db = new Database(':memory:');
  migrate(db);
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
  for (const expected of ['admins', 'gateways', 'egresses', 'gateway_egress', 'subscribers', 'credentials', 'usage_counters', 'events']) {
    assert.ok(tables.includes(expected), `missing table ${expected}`);
  }
  db.close();
});

/**
 * Rebuilding the gateways table is the only way SQLite widens a CHECK, and it
 * runs against a database with real rows in it. What is being checked here is
 * the part that would be silent and unrecoverable: DROP TABLE fires the
 * children's ON DELETE CASCADE unless foreign keys are off, so getting this
 * wrong takes every egress assignment on every gateway with it.
 */
test('the gateway rebuild keeps the rows that hang off a gateway', async (t) => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');

  // Everything up to the rebuild, so the rows below are inserted into the old
  // shape and the migration under test is the only one left to run.
  const REBUILD = '005_gateway_reality';
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)');
  for (const m of migrations) {
    if (m.id === REBUILD) break;
    db.transaction(() => {
      m.up(db, { now: Date.now(), sha256 });
      db.prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?,?)').run(m.id, Date.now());
    })();
  }

  const now = Date.now();
  db.prepare(`INSERT INTO gateways (id,name,region,host,port,ws_path,tls_mode,priority,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run('gw-keep', 'Frankfurt', 'eu', 'gw1.example.net', 443, '/tunnel', 'reverse-proxy', 40, now, now);
  db.prepare('INSERT INTO egresses (id,name,region,kind,created_at,updated_at) VALUES (?,?,?,?,?,?)')
    .run('eg-keep', 'Direct', 'eu', 'direct', now, now);
  db.prepare('INSERT INTO gateway_egress (gateway_id,egress_id,created_at) VALUES (?,?,?)')
    .run('gw-keep', 'eg-keep', now);

  migrate(db);
  t.after(() => db.close());

  await t.test('the assignment survives the rebuild', () => {
    assert.equal(db.prepare('SELECT count(*) AS n FROM gateway_egress').get().n, 1);
    assert.equal(db.prepare('SELECT count(*) AS n FROM gateways').get().n, 1);
  });

  await t.test('every column comes across in its own place', () => {
    const row = db.prepare('SELECT * FROM gateways WHERE id = ?').get('gw-keep');
    assert.equal(row.name, 'Frankfurt');
    assert.equal(row.host, 'gw1.example.net');
    assert.equal(row.port, 443);
    assert.equal(row.ws_path, '/tunnel');
    assert.equal(row.tls_mode, 'reverse-proxy');
    assert.equal(row.priority, 40);
    assert.equal(row.transport, 'ws');
    // The new columns exist and are empty, which is what a WebSocket gateway is.
    assert.equal(row.reality_private_key, null);
    assert.equal(row.reality_fingerprint, 'chrome');
  });

  await t.test('reality is now a transport the constraint allows, and nonsense is not', () => {
    db.prepare('UPDATE gateways SET transport = ? WHERE id = ?').run('reality', 'gw-keep');
    assert.throws(
      () => db.prepare('UPDATE gateways SET transport = ? WHERE id = ?').run('carrier-pigeon', 'gw-keep'),
      /CHECK constraint/,
    );
  });

  await t.test('foreign keys are back on afterwards', () => {
    assert.equal(db.pragma('foreign_keys', { simple: true }), 1);
    assert.throws(
      () => db.prepare('INSERT INTO gateway_egress (gateway_id,egress_id,created_at) VALUES (?,?,?)')
        .run('gw-missing', 'eg-keep', Date.now()),
      /FOREIGN KEY/,
    );
  });
});
