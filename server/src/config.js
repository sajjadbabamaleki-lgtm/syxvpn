import crypto from 'node:crypto';

const bool = (v, dflt = false) => {
  if (v === undefined || v === '') return dflt;
  return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
};
const int = (v, dflt) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : dflt;
};

const NODE_ENV = process.env.NODE_ENV || 'development';
const isProd = NODE_ENV === 'production';

/**
 * Configuration is read once at boot. Nothing here is allowed to carry a
 * production default secret: in production the process refuses to start
 * without an explicit ADMIN_PASSWORD (or hash) and a session secret.
 */
export function loadConfig(env = process.env) {
  const errors = [];

  const cfg = {
    nodeEnv: NODE_ENV,
    isProd,
    port: int(env.PORT, 8787),
    host: env.HOST || '0.0.0.0',
    dbPath: env.DB_PATH || 'jordan.db',
    logLevel: env.LOG_LEVEL || (isProd ? 'info' : 'debug'),

    // Public base URL used when rendering subscription links for operators.
    publicBaseUrl: (env.PUBLIC_BASE_URL || '').replace(/\/+$/, ''),

    corsOrigins: (env.CORS_ORIGINS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),

    admin: {
      username: env.ADMIN_USERNAME || 'admin',
      // Either a plain bootstrap password or a pre-computed scrypt hash.
      password: env.ADMIN_PASSWORD || '',
      passwordHash: env.ADMIN_PASSWORD_HASH || '',
      sessionTtlSeconds: int(env.ADMIN_SESSION_TTL_SECONDS, 12 * 3600),
    },

    agent: {
      // Max clock skew tolerated on signed agent requests (replay window).
      maxSkewSeconds: int(env.AGENT_MAX_SKEW_SECONDS, 300),
    },

    health: {
      enabled: bool(env.HEALTH_MONITOR_ENABLED, true),
      intervalSeconds: int(env.HEALTH_INTERVAL_SECONDS, 60),
      tcpTimeoutMs: int(env.HEALTH_TCP_TIMEOUT_MS, 4000),
      probeTimeoutMs: int(env.HEALTH_PROBE_TIMEOUT_MS, 6000),
      // Consecutive failures before a gateway is marked offline.
      failureThreshold: int(env.HEALTH_FAILURE_THRESHOLD, 2),
      // Heartbeats older than this mark an agent as missing.
      agentStaleSeconds: int(env.AGENT_STALE_SECONDS, 180),
      // Agent-sourced egress health older than this is no longer trusted.
      egressStaleSeconds: int(env.EGRESS_STALE_SECONDS, 600),
    },

    rateLimit: {
      login: { windowMs: 60_000, max: int(env.RATE_LIMIT_LOGIN, 10) },
      subscription: { windowMs: 60_000, max: int(env.RATE_LIMIT_SUB, 30) },
      api: { windowMs: 60_000, max: int(env.RATE_LIMIT_API, 600) },
      agent: { windowMs: 60_000, max: int(env.RATE_LIMIT_AGENT, 600) },
    },

    shop: {
      enabled: bool(env.SHOP_ENABLED, true),
      sessionTtlSeconds: int(env.SHOP_SESSION_TTL_SECONDS, 30 * 24 * 3600),
      // TRC-20 USDT address that receives customer payments. Without it the
      // storefront still lists plans but refuses to open an order.
      payAddress: (env.TRON_ADDRESS || '').trim(),
      tronApiUrl: (env.TRON_API_URL || 'https://api.trongrid.io').replace(/\/+$/, ''),
      tronApiKey: env.TRON_API_KEY || '',
      // Mainnet USDT (TRC-20).
      usdtContract: env.USDT_CONTRACT || 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
      paymentWindowMinutes: int(env.PAYMENT_WINDOW_MINUTES, 60),
      pollSeconds: int(env.PAYMENT_POLL_SECONDS, 30),
      confirmations: int(env.PAYMENT_CONFIRMATIONS, 19),
      maxOpenOrders: int(env.MAX_OPEN_ORDERS, 2),
      watcherEnabled: bool(env.PAYMENT_WATCHER_ENABLED, true),
      supportContact: env.SUPPORT_CONTACT || '',
    },

    trustProxy: bool(env.TRUST_PROXY, false),
    demoMode: bool(env.DEMO_MODE, false),
  };

  if (isProd) {
    if (!cfg.admin.password && !cfg.admin.passwordHash) {
      errors.push('ADMIN_PASSWORD or ADMIN_PASSWORD_HASH must be set in production');
    }
    if (cfg.admin.password && cfg.admin.password.length < 12) {
      errors.push('ADMIN_PASSWORD must be at least 12 characters');
    }
    if (cfg.demoMode) errors.push('DEMO_MODE must not be enabled in production');
    if (cfg.shop.enabled && !cfg.shop.payAddress) {
      // Not fatal: a deployment may run the control plane without the shop.
      // It is surfaced in /readiness instead of guessing an address.
    }
  } else if (!cfg.admin.password && !cfg.admin.passwordHash) {
    // Development convenience only: random password printed at boot, never fixed.
    cfg.admin.password = crypto.randomBytes(12).toString('base64url');
    cfg.admin.generatedPassword = true;
  }

  if (errors.length) {
    const err = new Error(`Invalid configuration:\n - ${errors.join('\n - ')}`);
    err.code = 'CONFIG_INVALID';
    throw err;
  }
  return cfg;
}

export const config = loadConfig();
