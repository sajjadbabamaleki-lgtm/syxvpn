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
import { guestRoutes } from './routes/guest.js';
import { adminShopRoutes } from './routes/admin.shop.js';
import { publicRoutes, usableGatewaysFor } from './routes/public.js';
import { telegramRoutes, telegramSender } from './routes/telegram.js';
import { createAssistant } from './services/assistant.js';
import { useGatewaySelector } from './domain/assistant.js';

/**
 * @param assistant a support assistant, injected by tests so the bot can be
 *   driven without a network; built from the config otherwise.
 * @param sendMessage the bot's outbound transport, likewise.
 * @param anthropic the Claude client the assistant talks to.
 */
export function createApp({
  db, startedAt = Date.now(), cfg = config, watcher = null,
  assistant = null, sendMessage = null, anthropic = null,
}) {
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
    allowedHeaders: [
      'Content-Type', 'Authorization',
      'x-cvpn-gateway', 'x-cvpn-timestamp', 'x-cvpn-nonce', 'x-cvpn-signature',
      // An agent that has not been upgraded yet still signs with the old names.
      'x-jordan-gateway', 'x-jordan-timestamp', 'x-jordan-nonce', 'x-jordan-signature',
    ],
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

  // The support assistant answers from the same view of a subscriber's
  // gateways that the subscription endpoint serves, rather than a second
  // implementation of the rule that would drift from it.
  useGatewaySelector(usableGatewaysFor);
  if (cfg.assistant.enabled || assistant) {
    const send = sendMessage || telegramSender(cfg.assistant.telegram.botToken);
    app.use(telegramRoutes({
      db,
      assistant: assistant || createAssistant({ db, client: anthropic }),
      send,
    }));
  }

  app.use('/api/v1/auth', authRoutes({ db }));
  // Customer-facing storefront: its own session type, never admin credentials.
  app.use('/api/v1/shop', shopRoutes({ db }));
  // No credential of any kind: the switch works before the account does. Every
  // bound that makes that safe lives inside the router.
  app.use('/api/v1/guest', guestRoutes({ db }));
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
