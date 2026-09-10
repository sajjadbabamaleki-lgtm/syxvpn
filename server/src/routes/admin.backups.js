import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import { ok, created } from '../lib/respond.js';
import { badRequest, notFound } from '../lib/errors.js';
import { config } from '../config.js';
import { EVENT, recordEvent } from '../domain/events.js';
import { listBackups, takeBackup, backupPath, isBackupName } from '../services/backup.js';

const iso = (ms) => (ms == null ? null : new Date(ms).toISOString());

const view = (entry) => ({
  name: entry.name,
  bytes: entry.bytes,
  createdAt: iso(entry.createdAt),
});

export function adminBackupRoutes({ db }) {
  const router = Router();

  router.get('/backups', (_req, res) => {
    const entries = listBackups();
    return ok(res, entries.map(view), {
      enabled: config.backup.enabled,
      directory: config.backup.dir,
      intervalHours: config.backup.intervalHours,
      keep: config.backup.keep,
      // Said out loud because it is the part operators get wrong: this is a
      // path on the control-plane host, and a snapshot that never leaves that
      // host does not survive the host.
      offsiteReminder: 'copy these off this machine — a snapshot on the same disk is not a backup',
    });
  });

  router.post('/backups', (req, res, next) => {
    try {
      const entry = takeBackup(db, { reason: `manual:${req.admin.username}` });
      return created(res, view(entry));
    } catch (err) {
      // A full or unwritable disk is the usual cause, and the operator asking
      // for the backup is exactly who needs to hear it.
      return next(badRequest(err.message));
    }
  });

  /**
   * Downloads one snapshot.
   *
   * This hands over every gateway agent key, every REALITY private key and the
   * sealed copy of every subscription token in a single file. It is admin-only,
   * it is recorded as a critical event, and the name is matched against the
   * shape this service writes rather than joined from what was asked for —
   * `../../etc/shadow` is a name, too.
   */
  router.get('/backups/:name', (req, res, next) => {
    const { name } = req.params;
    if (!isBackupName(name)) return next(notFound('Backup'));
    // Absolute, because sendFile takes nothing else, and BACKUP_DIR may be
    // relative to wherever the process was started.
    const file = path.resolve(backupPath(name));
    if (!fs.existsSync(file)) return next(notFound('Backup'));

    recordEvent(db, {
      type: EVENT.BACKUP_DOWNLOADED,
      severity: 'critical',
      message: `${req.admin.username} downloaded the database snapshot ${name}`,
      data: { name },
    });
    res.setHeader('content-type', 'application/vnd.sqlite3');
    res.setHeader('content-disposition', `attachment; filename="${name}"`);
    return res.sendFile(file, (err) => {
      if (err && !res.headersSent) next(err);
    });
  });

  return router;
}
