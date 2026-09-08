import { config } from './config.js';
import { logger } from './logger.js';
import { openDatabase } from './db/index.js';
import { ensureBootstrapAdmin } from './auth/admin.js';
import { createApp } from './app.js';
import { startMonitor } from './services/monitor.js';

const startedAt = Date.now();
const db = openDatabase(config.dbPath);
ensureBootstrapAdmin(db);

const app = createApp({ db, startedAt });
const monitor = config.health.enabled ? startMonitor(db) : null;

const server = app.listen(config.port, config.host, () => {
  logger.info('jordan control plane listening', {
    port: config.port,
    host: config.host,
    env: config.nodeEnv,
    healthMonitor: Boolean(monitor),
  });
});

function shutdown(signal) {
  logger.info('shutting down', { signal });
  monitor?.stop();
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 8000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
