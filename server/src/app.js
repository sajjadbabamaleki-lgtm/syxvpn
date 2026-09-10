import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { config } from './config.js';
import { logger } from './logger.js';
import { ApiError } from './lib/errors.js';
import { fail } from './lib/respond.js';
import { createRateLimiter, clientIp } from './lib/ratelimit.js';
import { requireAdmin } from './auth/admin.js';
import { metaRoutes } from './routes/meta.js';
import { authRoutes } from './routes/auth.js';
import { adminGatewayRoutes } from './routes/admin.gateways.js';
import { adminEgressRoutes } from './routes/admin.egresses.js';
import { adminSubscriberRoutes } from './routes/admin.subscribers.js';
import { adminNetworkRoutes } from './routes/admin.network.js';
import { adminBackupRoutes } from './routes/admin.backups.js';
import { adminObservabilityRoutes } from './routes/admin.observability.js';
import { agentRoutes } from './routes/agent.js';
import { shopRoutes } from './routes/shop.js';
import { adminShopRoutes } from './routes/admin.shop.js';
import { publicRoutes } from './routes/public.js';

export function createApp({ db, startedAt = Date.now(), cfg = config, watcher = null }) {
  const app = express();
  app.disable('x-powered-by');
  if (cfg.trustProxy) app.set('trust proxy', 1);

  app.use(helmet({
    contentSecurityPolicy: false, // API only; the SPA is served separately.
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  }));

  app.use(cors({
    origin: cfg.corsOrigins.length ? cfg.corsOrigins : true,
    credentials: false,
    // The dashboard sends a bearer token; agents send signed headers.
    allowedHeaders: ['Content-Type', 'Authorization', 'x-jordan-gateway', 'x-jordan-timestamp', 'x-jordan-nonce', 'x-jordan-signature'],
    exposedHeaders: ['RateLimit-Limit', 'RateLimit-Remaining', 'RateLimit-Reset', 'Subscription-Userinfo'],
  }));

  app.use(express.json({
    limit: '256kb',
    // The raw body is required to verify gateway-agent request signatures.
    verify: (req, _res, buf) => { req.rawBody = buf.toString('utf8'); },
  }));

  app.use((req, res, next) => {
    const started = process.hrtime.bigint();
    res.on('finish', () => {
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      // Subscription tokens must never appear in logs.
      const path = req.originalUrl.startsWith('/sub/') ? '/sub/[token]' : req.originalUrl.split('?')[0];
      logger.debug('request', { method: req.method, path, status: res.statusCode, ms: Math.round(ms) });
    });
    next();
  });

  app.use(metaRoutes({ db, startedAt }));
  app.use(publicRoutes({ db }));

  app.use('/api/v1/auth', authRoutes({ db }));
  // Customer-facing storefront: its own session type, never admin credentials.
  app.use('/api/v1/shop', shopRoutes({ db }));
  app.use('/api/v1/agent', agentRoutes({ db }));

  const admin = express.Router();
  admin.use(createRateLimiter({ ...cfg.rateLimit.api, keyFn: (req) => `api:${clientIp(req)}` }));
  admin.use(requireAdmin(db));
  admin.use('/gateways', adminGatewayRoutes({ db }));
  admin.use('/egresses', adminEgressRoutes({ db }));
  admin.use('/subscribers', adminSubscriberRoutes({ db }));
  admin.use(adminNetworkRoutes({ db, startedAt }));
  admin.use(adminBackupRoutes({ db }));
  admin.use(adminObservabilityRoutes({ db }));
  admin.use(adminShopRoutes({ db, watcher }));
  app.use('/api/v1', admin);

  app.use((req, res) => fail(res, 404, 'NOT_FOUND', `No route for ${req.method} ${req.path}`));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    if (err instanceof ApiError) {
      return fail(res, err.status, err.code, err.message, err.details);
    }
    if (err?.type === 'entity.parse.failed') {
      return fail(res, 400, 'MALFORMED_JSON', 'Request body is not valid JSON');
    }
    if (err?.type === 'entity.too.large') {
      return fail(res, 413, 'PAYLOAD_TOO_LARGE', 'Request body too large');
    }
    logger.error('unhandled error', { message: err?.message, stack: err?.stack?.split('\n').slice(0, 4).join(' | ') });
    return fail(res, 500, 'INTERNAL', 'Internal error');
  });

  return app;
}
