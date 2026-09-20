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
    dbPath: env.DB_PATH || 'cvpn.db',
    logLevel: env.LOG_LEVEL || (isProd ? 'info' : 'debug'),
    // What the gateways' own Xray logs at. Deliberately separate from the
    // control plane's level: this one reaches every gateway's disk.
    xrayLogLevel: ['debug', 'info', 'warning', 'error', 'none'].includes(env.XRAY_LOG_LEVEL)
      ? env.XRAY_LOG_LEVEL : 'warning',

    // Public base URL used when rendering subscription links for operators.
    publicBaseUrl: (env.PUBLIC_BASE_URL || '').replace(/\/+$/, ''),

    corsOrigins: (env.CORS_ORIGINS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),

    /**
     * Snapshots of the database. On by default: the cost of one is a few
     * hundred kilobytes, and the cost of not having one is the paying customer
     * list. BACKUP_DIR should be a host path that gets copied off the machine —
     * a snapshot beside the database survives a bad query, not a dead disk.
     */
    backup: {
      enabled: bool(env.BACKUP_ENABLED, true),
      dir: env.BACKUP_DIR || 'backups',
      intervalHours: int(env.BACKUP_INTERVAL_HOURS, 6),
      keep: Math.max(1, int(env.BACKUP_KEEP, 28)),
    },

    /**
     * How many gateways one subscriber is told about. 0 means all of them,
     * which is what this was before there was a setting: one leaked
     * configuration mapped the whole fleet. Below this many usable gateways it
     * makes no difference — it starts to matter once there are more.
     */
    fleet: {
      gatewaysPerSubscriber: Math.max(0, int(env.SUBSCRIBER_GATEWAYS, 4)),
    },

    admin: {
      username: env.ADMIN_USERNAME || 'admin',
      // Either a plain bootstrap password or a pre-computed scrypt hash.
      password: env.ADMIN_PASSWORD || '',
      passwordHash: env.ADMIN_PASSWORD_HASH || '',
      sessionTtlSeconds: int(env.ADMIN_SESSION_TTL_SECONDS, 12 * 3600),
      // The name an authenticator app shows beside the code.
      totpIssuer: env.ADMIN_TOTP_ISSUER || 'SyxVPN',
    },

    agent: {
      // Max clock skew tolerated on signed agent requests (replay window).
      maxSkewSeconds: int(env.AGENT_MAX_SKEW_SECONDS, 300),
    },

    /**
     * The support assistant and the bot it answers through.
     *
     * Off by default and off entirely without an API key: a deployment that has
     * not been given one must not start a support channel that cannot answer.
     */
    assistant: {
      enabled: bool(env.ASSISTANT_ENABLED, false) && Boolean((env.ANTHROPIC_API_KEY || '').trim()),
      model: env.ASSISTANT_MODEL || 'claude-opus-5',
      /**
       * How hard the model thinks per reply.
       *
       * A support chat is latency-sensitive and its questions are not hard; the
       * depth that earns its cost on a coding task costs seconds here for
       * nothing. Raise it if the answers start reading as shallow.
       */
      effort: env.ASSISTANT_EFFORT || 'medium',
      telegram: {
        botToken: (env.TELEGRAM_BOT_TOKEN || '').trim(),
        // Secret path segment *and* header on the webhook. A URL reaches logs
        // and proxies; a header does not.
        webhookSecret: (env.TELEGRAM_WEBHOOK_SECRET || '').trim(),
        // Where handovers are announced and where an operator answers from.
        operatorChatId: (env.TELEGRAM_OPERATOR_CHAT_ID || '').trim(),
        // The bot's public @name. Only the storefront needs it, to send a
        // customer to the chat their link code is for.
        botUsername: (env.TELEGRAM_BOT_USERNAME || '').trim().replace(/^@/, ''),
      },
    },

    // Additional inbound protocols per gateway. Off by default: the fleet has
    // to be able to take this build without taking the feature, and turning it
    // on is a decision with a date and a person attached to it.
    //
    // `enabled` gates generation, serving and probing alike, so off means the
    // control plane produces exactly what it produced before the feature —
    // rows in the table and all. `rolloutPercent` is the second dial: which
    // share of subscribers are told that the extra doors exist.
    adaptiveInbounds: {
      enabled: bool(env.ADAPTIVE_INBOUNDS, false),
      rolloutPercent: int(env.ADAPTIVE_INBOUNDS_PERCENT, 0),
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
      /**
       * Whether the by-the-gigabyte plans are on sale.
       *
       * They are settled by hand, so there are stretches where nobody is there
       * to settle one — and a plan that cannot be fulfilled should not be on
       * the shelf. Off by default: selling something nobody is watching is
       * worse than not selling it.
       */
      volumeSales: bool(env.SHOP_VOLUME_SALES, false),
      // The ceiling on a single by-the-gigabyte order. A size picker with no
      // ceiling is an invitation to open a six-figure order by holding a
      // button down.
      maxOrderUnits: int(env.SHOP_MAX_ORDER_UNITS, 100),
      /**
       * Addresses that get the VPN product without buying it.
       *
       * The operators' own accounts, and anyone else the owner decides to
       * carry: they sign in like everybody else and the control plane gives
       * them a subscription on the way in. It is deliberately not something
       * the app can ask for — an app that could grant itself a plan is a plan
       * anybody can have by editing a field.
       *
       * Set SHOP_COMPED_EMAILS to replace the list; an empty value switches
       * it off entirely.
       */
      compedEmails: (env.SHOP_COMPED_EMAILS ?? 'sajjadbabamaleki@gmail.com,fazialighob@gmail.com')
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean),
      // How long a comped subscription runs before it is renewed on the next
      // sign-in. Long enough that it never lapses under somebody, short enough
      // that removing an address from the list actually takes effect.
      compedDays: int(env.SHOP_COMPED_DAYS, 365),
      /**
       * The free trial every new account is given once, on its first sign-in.
       *
       * A customer on the networks this serves cannot be asked to pay before
       * finding out whether the tunnel comes up at all — from where they are,
       * that is a real question, and most of what they have been sold before
       * did not work. The trial answers it with the product rather than a
       * promise.
       *
       * Metered and dated, both enforced at the gateway: an exhausted or
       * lapsed subscription drops out of `entitledCredentials` and its
       * credential stops being deployed. Small on purpose — it is a
       * demonstration, not a plan.
       *
       * SHOP_TRIAL_DAYS=0 switches it off, and no account gets one afterwards.
       * Changing the numbers does not touch a trial already granted.
       */
      trialDays: int(env.SHOP_TRIAL_DAYS, 3),
      trialGb: int(env.SHOP_TRIAL_GB, 1),
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

    /**
     * What somebody gets for pressing the switch, with no account at all.
     *
     * The shortest honest answer to "does this even work from here": a few
     * minutes of the real thing, now, with nothing typed. Everything about it
     * is small on purpose — it is a demonstration, and the account is what
     * comes next.
     *
     * The per-device count is a speed bump, not a lock: the identifier it
     * counts against is the app's own, and clearing the app's data makes a new
     * one. `leasesPerDay` is the number that actually bounds the cost, because
     * it holds however many devices there are. Multiply it by `sessionMb` for
     * the worst the giveaway can spend in a day.
     */
    guest: {
      enabled: bool(env.GUEST_ENABLED, true),
      sessionMinutes: int(env.GUEST_SESSION_MINUTES, 3),
      sessionsPerDevice: int(env.GUEST_SESSIONS_PER_DEVICE, 5),
      // Per session, and deliberately far above what three minutes uses: it is
      // the ceiling that stops a session that ignores its clock, not the
      // allowance somebody is meant to feel.
      sessionMb: int(env.GUEST_SESSION_MB, 100),
      leasesPerDay: int(env.GUEST_LEASES_PER_DAY, 200),
    },

    /**
     * The relay that carries sign-in codes.
     *
     * Nothing is sent until SMTP_HOST and MAIL_FROM are both set: an app that
     * opens a code field for a code nobody is sending is worse than one that
     * says the feature is off. Port 465 is implicit TLS and 587 is STARTTLS;
     * both are encrypted, and plaintext SMTP is not offered.
     *
     * With a Gmail account, SMTP_USER is the address and SMTP_PASS is an app
     * password — not the account password, which Google refuses here.
     */
    mail: {
      host: (env.SMTP_HOST || '').trim(),
      port: int(env.SMTP_PORT, 465),
      secure: bool(env.SMTP_SECURE, int(env.SMTP_PORT, 465) === 465),
      user: (env.SMTP_USER || '').trim(),
      pass: env.SMTP_PASS || '',
      // What the recipient sees in the From line. A display name is allowed:
      // SYX VPN <no-reply@syxvpn.pro>.
      from: (env.MAIL_FROM || '').trim(),
      codeTtlMs: 10 * 60 * 1000,
      /**
       * Whether a code is required, and not merely checked when given.
       *
       * The app always sends one, and a code that is sent is always verified.
       * This is about the callers that send none — the web storefront, and any
       * older build still out there. Turn it on once everything in the field
       * asks for a code, and no route in without one remains.
       */
      requireCode: bool(env.AUTH_REQUIRE_EMAIL_CODE, false),
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
