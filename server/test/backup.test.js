import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';
import { startTestServer } from './helpers.js';
import {
  takeBackup, listBackups, pruneBackups, isBackupName, backupPath, startBackups,
} from '../src/services/backup.js';
import { config } from '../src/config.js';

/** A configuration pointing at a directory this test owns and can delete. */
function sandbox(t, overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cvpn-backup-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { backup: { enabled: true, dir, intervalHours: 6, keep: 3, ...overrides } };
}

test('database snapshots', async (t) => {
  const ctx = await startTestServer();
  t.after(() => ctx.close());

  await t.test('a snapshot is a database that opens and holds the same rows', () => {
    const cfg = sandbox(t);
    ctx.db.prepare('INSERT INTO egresses (id,name,region,kind,created_at,updated_at) VALUES (?,?,?,?,?,?)')
      .run('eg_snap', 'Snapshot me', 'de', 'direct', Date.now(), Date.now());

    const entry = takeBackup(ctx.db, { cfg });
    assert.ok(entry.bytes > 0);

    // The point of the whole feature: what comes back is a working database
    // with the row in it, not a file that merely exists.
    const restored = new Database(backupPath(entry.name, cfg), { readonly: true });
    t.after(() => restored.close());
    assert.equal(restored.prepare('SELECT name FROM egresses WHERE id = ?').get('eg_snap').name, 'Snapshot me');
    assert.ok(restored.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table'").get().n > 5);
  });

  await t.test('it does not stop the control plane from writing', () => {
    const cfg = sandbox(t);
    takeBackup(ctx.db, { cfg });
    // VACUUM INTO runs in a read transaction; a copy that left the database
    // locked would take the service down every six hours.
    ctx.db.prepare('INSERT INTO egresses (id,name,region,kind,created_at,updated_at) VALUES (?,?,?,?,?,?)')
      .run('eg_after', 'Still writable', 'de', 'direct', Date.now(), Date.now());
    assert.ok(ctx.db.prepare('SELECT id FROM egresses WHERE id = ?').get('eg_after'));
  });

  await t.test('two snapshots in the same second do not collide', () => {
    const cfg = sandbox(t);
    const now = Date.UTC(2026, 8, 10, 4, 12, 33);
    takeBackup(ctx.db, { cfg, now });
    // The same second is the same name, so the second one overwrites rather
    // than failing: VACUUM INTO refuses an existing target, and a scheduled
    // backup must never throw because of a clock landing twice.
    takeBackup(ctx.db, { cfg, now });
    assert.equal(listBackups(cfg).length, 1);
  });

  await t.test('only the newest [keep] are kept, oldest first to go', () => {
    const cfg = sandbox(t);
    const base = Date.UTC(2026, 8, 10, 0, 0, 0);
    const names = [0, 1, 2, 3, 4].map((i) => takeBackup(ctx.db, { cfg, now: base + i * 3600_000 }).name);
    const left = listBackups(cfg).map((e) => e.name);
    assert.equal(left.length, 3, 'keep is 3');
    assert.deepEqual(left, [names[4], names[3], names[2]], 'newest first, oldest dropped');
    assert.ok(!fs.existsSync(backupPath(names[0], cfg)));
  });

  await t.test('a snapshot older than the retention window is still kept if it is all there is', () => {
    // Retention is by count, not age: a control plane down for a week must not
    // come back to an empty directory because its snapshots aged out.
    const cfg = sandbox(t, { keep: 5 });
    takeBackup(ctx.db, { cfg, now: Date.UTC(2020, 0, 1) });
    assert.equal(pruneBackups(cfg).length, 0);
    assert.equal(listBackups(cfg).length, 1);
  });

  await t.test('a half-written snapshot never appears as one', () => {
    const cfg = sandbox(t);
    // What a full disk or a killed container leaves behind.
    fs.writeFileSync(path.join(cfg.backup.dir, 'cvpn-20260101T000000Z.sqlite.partial'), 'truncated');
    assert.deepEqual(listBackups(cfg), [], 'a .partial is not restorable and is not listed');
  });

  await t.test('a directory that does not exist yet reads as no backups, not as an error', () => {
    const cfg = { backup: { enabled: true, dir: '/tmp/cvpn-backup-never-created-xyz', keep: 3, intervalHours: 6 } };
    assert.deepEqual(listBackups(cfg), []);
  });

  await t.test('an unwritable directory fails loudly instead of pretending', () => {
    const cfg = sandbox(t);
    fs.rmSync(cfg.backup.dir, { recursive: true, force: true });
    fs.writeFileSync(cfg.backup.dir, 'not a directory');
    assert.throws(() => takeBackup(ctx.db, { cfg }), /backup failed|ENOTDIR|EEXIST/);
  });

  await t.test('the scheduler survives a failing backup rather than taking the service with it', () => {
    const cfg = sandbox(t);
    fs.rmSync(cfg.backup.dir, { recursive: true, force: true });
    fs.writeFileSync(cfg.backup.dir, 'not a directory');
    const service = startBackups(ctx.db, cfg);
    t.after(() => service.stop());
    // A backup disk that filled up is a maintenance problem; turning it into an
    // outage would be the worse failure.
    assert.doesNotThrow(() => service.tick());
    const events = ctx.db.prepare("SELECT * FROM events WHERE type = 'backup.failed' ORDER BY id DESC").all();
    assert.ok(events.length >= 1);
    assert.equal(events[0].severity, 'critical');
  });

  await t.test('snapshots taken before the rename are still listed', () => {
    // A backup you cannot find is not a backup, and the ones from before a
    // rename are exactly the ones worth keeping.
    const cfg = sandbox(t);
    const entry = takeBackup(ctx.db, { cfg });
    fs.renameSync(backupPath(entry.name, cfg), backupPath('jordan-20250101T000000Z.sqlite', cfg));
    assert.deepEqual(listBackups(cfg).map((e) => e.name), ['jordan-20250101T000000Z.sqlite']);
  });

  await t.test('names this service did not write are not names it will serve', () => {
    assert.ok(isBackupName('sixvpn-20260910T041233Z.sqlite'));
    // Every prefix this service has written stays restorable: the snapshots
    // from before a rename are exactly the ones worth keeping.
    assert.ok(isBackupName('cvpn-20260910T041233Z.sqlite'), 'taken before the rename');
    assert.ok(isBackupName('jordan-20260910T041233Z.sqlite'), 'taken before the rename before that');
    for (const bad of [
      '../../etc/passwd',
      '..%2f..%2fcvpn.db',
      'cvpn.db',
      'cvpn-20260910T041233Z.sqlite.partial',
      'cvpn-2026Z.sqlite',
      '',
      'cvpn-20260910T041233Z.sqlite/../../x',
    ]) {
      assert.ok(!isBackupName(bad), bad);
    }
  });
});

test('the backup API', async (t) => {
  const ctx = await startTestServer();
  t.after(() => ctx.close());
  const token = await ctx.login();

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cvpn-backup-api-'));
  const original = { ...config.backup };
  Object.assign(config.backup, { enabled: true, dir, intervalHours: 6, keep: 3 });
  t.after(() => {
    Object.assign(config.backup, original);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  let name = null;

  await t.test('starts empty and says where snapshots go', async () => {
    const res = await ctx.request('GET', '/api/v1/backups', { token });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.data, []);
    assert.equal(res.body.meta.directory, dir);
    assert.match(res.body.meta.offsiteReminder, /not a backup/);
  });

  await t.test('an operator can take one on demand', async () => {
    const res = await ctx.request('POST', '/api/v1/backups', { token });
    assert.equal(res.status, 201);
    name = res.body.data.name;
    assert.ok(isBackupName(name));
    assert.ok(res.body.data.bytes > 0);

    const list = await ctx.request('GET', '/api/v1/backups', { token });
    assert.equal(list.body.data.length, 1);
    assert.equal(list.body.data[0].name, name);
  });

  await t.test('downloading one is recorded as the serious thing it is', async () => {
    const res = await ctx.request('GET', `/api/v1/backups/${name}`, { token });
    assert.equal(res.status, 200);
    // SQLite's file header, so what came back is the database and not an error
    // page with a 200 on it.
    assert.match(res.text.slice(0, 15), /^SQLite format 3/);
    assert.match(res.headers.get('content-disposition'), /attachment/);

    const event = ctx.db.prepare("SELECT * FROM events WHERE type = 'backup.downloaded' ORDER BY id DESC").get();
    assert.ok(event, 'a copy of every credential in the fleet left the machine');
    assert.equal(event.severity, 'critical');
    assert.match(event.message, /admin/);
  });

  await t.test('refuses a name that is a path', async () => {
    for (const bad of ['..%2f..%2fetc%2fpasswd', 'cvpn.db', 'nonexistent-20260101T000000Z.sqlite']) {
      const res = await ctx.request('GET', `/api/v1/backups/${bad}`, { token });
      assert.equal(res.status, 404, bad);
    }
  });

  await t.test('none of it is reachable without an admin session', async () => {
    for (const [method, url] of [['GET', '/api/v1/backups'], ['POST', '/api/v1/backups'], ['GET', `/api/v1/backups/${name}`]]) {
      const res = await ctx.request(method, url);
      assert.equal(res.status, 401, `${method} ${url}`);
    }
  });
});
