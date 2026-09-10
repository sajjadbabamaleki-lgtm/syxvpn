import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { migrations } from './migrations.js';
import { sha256 } from '../lib/crypto.js';
import { logger } from '../logger.js';

export function openDatabase(dbPath) {
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
  }
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  migrate(db);
  return db;
}

export function migrate(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)`);
  const applied = new Set(db.prepare('SELECT id FROM schema_migrations').all().map((r) => r.id));
  for (const m of migrations) {
    if (applied.has(m.id)) continue;
    const run = db.transaction(() => {
      m.up(db, { now: Date.now(), sha256 });
      db.prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?,?)').run(m.id, Date.now());
    });
    // Rebuilding a table is the only way SQLite changes a CHECK constraint, and
    // it needs foreign keys off: DROP TABLE runs the ON DELETE CASCADE of every
    // child otherwise. The pragma is a no-op inside a transaction, so it has to
    // be set out here — the migration itself is still all-or-nothing.
    if (!m.foreignKeysOff) {
      run();
    } else {
      db.pragma('foreign_keys = OFF');
      try {
        run();
      } finally {
        db.pragma('foreign_keys = ON');
      }
    }
    logger.info('migration applied', { migration: m.id });
  }
}
