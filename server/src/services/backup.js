import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { EVENT, recordEvent } from '../domain/events.js';

/**
 * Snapshots of the database, because there were none.
 *
 * Everything this business is made of lives in one SQLite file: subscribers,
 * customers, orders, every gateway's agent key, every REALITY private key, and
 * the sealed copies of subscription tokens. One `rm`, one corrupted page, one
 * deleted Docker volume, and there is no version of the paying customer list
 * anywhere. That is not a risk anybody chose; it is one nobody looked at.
 *
 * `VACUUM INTO` is the mechanism rather than copying the file. SQLite runs it
 * inside a read transaction, so the copy is consistent even while the control
 * plane is writing — copying `jordan.db` by hand while WAL has uncommitted
 * pages produces a file that opens and is quietly missing the last minutes.
 * It also compacts, so a snapshot is smaller than the live database.
 *
 * A snapshot on the same disk is not a backup: it survives a bad DELETE and a
 * dropped table, not a dead disk. BACKUP_DIR is meant to be a host path that is
 * copied off the machine — see docs/DEPLOYMENT.md.
 */

/** `jordan-20260910T041233Z.sqlite` — sortable, and unambiguous across zones. */
const NAME_SHAPE = /^jordan-\d{8}T\d{6}Z\.sqlite$/;

const stamp = (when) => new Date(when).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');

/** Only files this service wrote. Guards the download route against traversal. */
export const isBackupName = (name) => NAME_SHAPE.test(name);

export function listBackups(cfg = config) {
  let entries;
  try {
    entries = fs.readdirSync(cfg.backup.dir);
  } catch {
    // No directory yet is not an error: it means no backup has been taken.
    return [];
  }
  return entries
    .filter(isBackupName)
    .map((name) => {
      const stats = fs.statSync(path.join(cfg.backup.dir, name));
      return { name, bytes: stats.size, createdAt: stats.mtimeMs };
    })
    .sort((a, b) => b.createdAt - a.createdAt);
}

export const backupPath = (name, cfg = config) => path.join(cfg.backup.dir, name);

/**
 * Deletes the oldest snapshots beyond [keep].
 *
 * Retention is by count rather than by age on purpose: a control plane that has
 * been down for a week should still have its last snapshots when it comes back,
 * and an age rule would have thrown them away while nothing was there to make
 * new ones.
 */
export function pruneBackups(cfg = config) {
  const stale = listBackups(cfg).slice(cfg.backup.keep);
  for (const entry of stale) {
    try {
      fs.unlinkSync(backupPath(entry.name, cfg));
    } catch (err) {
      logger.warn('could not remove an old backup', { name: entry.name, message: err.message });
    }
  }
  return stale.map((entry) => entry.name);
}

/**
 * Takes one snapshot. Returns it, or throws with a reason worth reading.
 *
 * The write goes to a temporary name and is renamed into place, so a snapshot
 * interrupted half-written — a full disk, a killed container — never appears in
 * the listing as something restorable.
 */
export function takeBackup(db, { cfg = config, now = Date.now(), reason = 'scheduled' } = {}) {
  fs.mkdirSync(cfg.backup.dir, { recursive: true });
  const name = `jordan-${stamp(now)}.sqlite`;
  const target = backupPath(name, cfg);
  const partial = `${target}.partial`;
  try {
    fs.rmSync(partial, { force: true });
    // Bound as a literal, not a parameter: VACUUM INTO takes an expression that
    // SQLite evaluates before the statement is prepared, so a placeholder here
    // fails. The path is built from a timestamp and configuration, never input.
    db.prepare(`VACUUM INTO '${partial.replace(/'/g, "''")}'`).run();
    fs.renameSync(partial, target);
  } catch (err) {
    fs.rmSync(partial, { force: true });
    throw new Error(`backup failed: ${err.message}`);
  }
  const bytes = fs.statSync(target).size;
  const pruned = pruneBackups(cfg);
  recordEvent(db, {
    type: EVENT.BACKUP_TAKEN,
    message: `Database snapshot ${name} (${Math.round(bytes / 1024)} KB)`,
    data: { name, bytes, reason, pruned: pruned.length },
  });
  logger.info('database snapshot taken', { name, bytes, reason, pruned: pruned.length });
  return { name, bytes, createdAt: now };
}

/**
 * Runs snapshots on a schedule.
 *
 * A failure is logged and recorded, never thrown: a control plane that stops
 * serving customers because a backup disk filled up has turned a maintenance
 * problem into an outage.
 */
export function startBackups(db, cfg = config) {
  let timer = null;
  let running = false;

  const tick = () => {
    if (running) return;
    running = true;
    try {
      takeBackup(db, { cfg });
    } catch (err) {
      logger.error('scheduled backup failed', { message: err.message });
      recordEvent(db, {
        type: EVENT.BACKUP_FAILED,
        severity: 'critical',
        message: `Database snapshot failed: ${err.message}`,
      });
    } finally {
      running = false;
    }
  };

  const everyMs = Math.max(1, cfg.backup.intervalHours) * 3600 * 1000;
  timer = setInterval(tick, everyMs);
  timer.unref?.();
  // One shortly after boot, so a fresh deployment is covered from the first
  // minute rather than from the first interval.
  const kickoff = setTimeout(tick, 5000);
  kickoff.unref?.();

  return {
    tick,
    stop() {
      clearInterval(timer);
      clearTimeout(kickoff);
    },
  };
}
