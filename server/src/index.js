import { config } from './config.js';
import { logger } from './logger.js';
import { openDatabase } from './db/index.js';
import { ensureBootstrapAdmin } from './auth/admin.js';
import { createApp } from './app.js';
import { startMonitor } from './services/monitor.js';
import { createPaymentWatcher } from './services/payments.js';
import { startBackups } from './services/backup.js';
import { createAnthropic } from './services/anthropic.js';

const startedAt = Date.now();
const db = openDatabase(config.dbPath);
ensureBootstrapAdmin(db);

const watcher = config.shop.enabled ? createPaymentWatcher(db) : null;
const anthropic = config.assistant.enabled ? createAnthropic() : null;
const app = createApp({ db, startedAt, watcher, anthropic });
const monitor = config.health.enabled ? startMonitor(db) : null;
const backups = config.backup.enabled ? startBackups(db) : null;
watcher?.start();

const server = app.listen(config.port, config.host, () => {
  logger.info('sixvpn control plane listening', {
    port: config.port,
    host: config.host,
    env: config.nodeEnv,
    healthMonitor: Boolean(monitor),
    backups: backups ? `every ${config.backup.intervalHours}h into ${config.backup.dir}` : 'off',
    assistant: config.assistant.enabled ? config.assistant.model : 'off',
  });
});

function shutdown(signal) {
  logger.info('shutting down', { signal });
  monitor?.stop();
  watcher?.stop();
  backups?.stop();
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 8000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
