/**
 * Ordered, forward-only migrations. Every timestamp column is epoch milliseconds
 * (INTEGER) so ordering and arithmetic never depend on SQLite date parsing.
 */

const SCHEMA_V1 = `
CREATE TABLE admins (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_login_at INTEGER
);

CREATE TABLE admin_sessions (
  token_hash TEXT PRIMARY KEY,
  admin_id TEXT NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL,
  user_agent TEXT
);
CREATE INDEX idx_admin_sessions_expiry ON admin_sessions(expires_at);

CREATE TABLE gateways (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  region TEXT NOT NULL,
  host TEXT NOT NULL,
  port INTEGER NOT NULL,
  protocol TEXT NOT NULL DEFAULT 'vless' CHECK (protocol IN ('vless')),
  transport TEXT NOT NULL DEFAULT 'ws' CHECK (transport IN ('ws')),
  tls_mode TEXT NOT NULL DEFAULT 'none' CHECK (tls_mode IN ('none','reverse-proxy','xray')),
  sni TEXT,
  ws_path TEXT NOT NULL DEFAULT '/ws',
  ws_host TEXT,
  listen_address TEXT NOT NULL DEFAULT '0.0.0.0',
  listen_port INTEGER,
  tls_cert_path TEXT,
  tls_key_path TEXT,
  priority INTEGER NOT NULL DEFAULT 100,
  enabled INTEGER NOT NULL DEFAULT 1,
  block_private_ranges INTEGER NOT NULL DEFAULT 1,
  agent_key_enc TEXT,
  agent_key_hint TEXT,
  agent_key_created_at INTEGER,
  ingress_status TEXT NOT NULL DEFAULT 'unknown'
    CHECK (ingress_status IN ('unknown','online','degraded','offline')),
  ingress_latency_ms INTEGER,
  ingress_checked_at INTEGER,
  ingress_fail_count INTEGER NOT NULL DEFAULT 0,
  ingress_detail TEXT,
  agent_status TEXT NOT NULL DEFAULT 'never-seen'
    CHECK (agent_status IN ('never-seen','online','stale')),
  agent_version TEXT,
  xray_version TEXT,
  agent_last_seen_at INTEGER,
  config_version INTEGER NOT NULL DEFAULT 1,
  deployed_config_version INTEGER,
  deployed_at INTEGER,
  deploy_error TEXT,
  active_egress_id TEXT,
  active_egress_since INTEGER,
  active_egress_reason TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_gateways_priority ON gateways(priority, name);

CREATE TABLE egresses (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  region TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('direct','socks','vless')),
  host TEXT,
  port INTEGER,
  bind_address TEXT,
  username TEXT,
  secret TEXT,
  tls INTEGER NOT NULL DEFAULT 0,
  sni TEXT,
  transport TEXT NOT NULL DEFAULT 'tcp' CHECK (transport IN ('tcp','ws')),
  ws_path TEXT,
  probe_url TEXT,
  priority INTEGER NOT NULL DEFAULT 100,
  weight INTEGER NOT NULL DEFAULT 1,
  enabled INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'unknown'
    CHECK (status IN ('unknown','online','degraded','offline')),
  latency_ms INTEGER,
  checked_at INTEGER,
  checked_by TEXT,
  detail TEXT,
  authorization_note TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Egress health is only meaningful *from a specific gateway*: an egress can be
-- usable from gateway A and unreachable from gateway B.
CREATE TABLE gateway_egress (
  gateway_id TEXT NOT NULL REFERENCES gateways(id) ON DELETE CASCADE,
  egress_id TEXT NOT NULL REFERENCES egresses(id) ON DELETE CASCADE,
  priority INTEGER NOT NULL DEFAULT 100,
  status TEXT NOT NULL DEFAULT 'unknown'
    CHECK (status IN ('unknown','online','degraded','offline')),
  latency_ms INTEGER,
  checked_at INTEGER,
  fail_count INTEGER NOT NULL DEFAULT 0,
  detail TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (gateway_id, egress_id)
);

CREATE TABLE route_switches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  gateway_id TEXT NOT NULL REFERENCES gateways(id) ON DELETE CASCADE,
  from_egress_id TEXT,
  to_egress_id TEXT,
  reason TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_route_switches_gw ON route_switches(gateway_id, created_at DESC);

CREATE TABLE health_checks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  target_type TEXT NOT NULL CHECK (target_type IN ('gateway','egress')),
  target_id TEXT NOT NULL,
  gateway_id TEXT,
  check_kind TEXT NOT NULL CHECK (check_kind IN ('tcp','http','e2e')),
  status TEXT NOT NULL,
  latency_ms INTEGER,
  detail TEXT,
  source TEXT NOT NULL CHECK (source IN ('control-plane','agent')),
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_health_target ON health_checks(target_type, target_id, created_at DESC);

CREATE TABLE subscribers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  token_prefix TEXT NOT NULL,
  quota_bytes INTEGER NOT NULL,
  used_bytes INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  note TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_fetch_at INTEGER,
  fetch_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_subscribers_status ON subscribers(status, expires_at);

CREATE TABLE credentials (
  id TEXT PRIMARY KEY,
  subscriber_id TEXT NOT NULL REFERENCES subscribers(id) ON DELETE CASCADE,
  uuid TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active','retiring','revoked')),
  created_at INTEGER NOT NULL,
  retired_at INTEGER,
  revoked_at INTEGER
);
CREATE INDEX idx_credentials_sub ON credentials(subscriber_id, state);

-- Deduplication record: one row per accepted agent usage report.
CREATE TABLE usage_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  gateway_id TEXT NOT NULL,
  report_id TEXT NOT NULL,
  received_at INTEGER NOT NULL,
  accepted_bytes INTEGER NOT NULL DEFAULT 0,
  counter_count INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX idx_usage_reports_unique ON usage_reports(gateway_id, report_id);

-- Last cumulative value seen per (gateway, credential, direction). Deltas are
-- derived from this, so replays and restarts cannot double count.
CREATE TABLE usage_counters (
  gateway_id TEXT NOT NULL,
  credential_id TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('uplink','downlink')),
  last_cumulative INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (gateway_id, credential_id, direction)
);

CREATE TABLE usage_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subscriber_id TEXT NOT NULL,
  gateway_id TEXT NOT NULL,
  credential_id TEXT,
  direction TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_usage_events_sub ON usage_events(subscriber_id, created_at DESC);

CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('info','warning','critical')),
  target_type TEXT,
  target_id TEXT,
  message TEXT NOT NULL,
  data TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_events_created ON events(created_at DESC);

CREATE TABLE agent_nonces (
  nonce TEXT PRIMARY KEY,
  gateway_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX idx_agent_nonces_expiry ON agent_nonces(expires_at);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
`;


const SCHEMA_V2_STOREFRONT = `
-- Storefront: customers buy a plan with USDT and receive a subscription.

CREATE TABLE customers (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','blocked')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_login_at INTEGER
);

CREATE TABLE customer_sessions (
  token_hash TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL,
  user_agent TEXT
);
CREATE INDEX idx_customer_sessions_expiry ON customer_sessions(expires_at);

-- Prices are stored in micro-USDT (1 USDT = 1000000), matching TRC-20 decimals,
-- so no floating point ever touches a balance.
CREATE TABLE plans (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  quota_bytes INTEGER NOT NULL,
  duration_days INTEGER NOT NULL,
  price_micro INTEGER NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 100,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE orders (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  plan_id TEXT NOT NULL REFERENCES plans(id),
  plan_name TEXT NOT NULL,
  quota_bytes INTEGER NOT NULL,
  duration_days INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','paid','fulfilled','expired','cancelled')),
  price_micro INTEGER NOT NULL,
  -- Each open order is given a unique amount so an incoming transfer can be
  -- matched to exactly one order without per-order deposit addresses.
  pay_amount_micro INTEGER NOT NULL,
  pay_address TEXT NOT NULL,
  chain TEXT NOT NULL DEFAULT 'tron',
  asset TEXT NOT NULL DEFAULT 'USDT-TRC20',
  tx_hash TEXT,
  from_address TEXT,
  confirmations INTEGER,
  settled_by TEXT,
  subscriber_id TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  paid_at INTEGER,
  fulfilled_at INTEGER
);
CREATE INDEX idx_orders_customer ON orders(customer_id, created_at DESC);
CREATE INDEX idx_orders_open ON orders(status, expires_at);
CREATE UNIQUE INDEX idx_orders_tx ON orders(tx_hash) WHERE tx_hash IS NOT NULL;
`;

/**
 * The 0.1 prototype stored gateways and egress nodes in one table and kept
 * subscription tokens in plaintext. Existing rows are preserved: tokens are
 * hashed in place so already-distributed subscription URLs keep working.
 */
function importLegacy(db, now, sha256) {
  const tables = new Set(
    db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name),
  );
  if (!tables.has('legacy_gateways') && !tables.has('legacy_subscribers')) return;

  if (tables.has('legacy_gateways')) {
    for (const g of db.prepare('SELECT * FROM legacy_gateways').all()) {
      if (g.kind === 'egress') {
        db.prepare(
          `INSERT INTO egresses (id,name,region,kind,host,port,priority,weight,enabled,status,latency_ms,created_at,updated_at,authorization_note)
           VALUES (?,?,?,'direct',?,?,?,1,1,'unknown',NULL,?,?,'imported from 0.1 prototype; verify authorization')`,
        ).run(g.id, g.name, g.region, g.host, g.port, g.priority ?? 100, now, now);
      } else {
        db.prepare(
          `INSERT INTO gateways (id,name,region,host,port,tls_mode,sni,ws_path,ws_host,priority,enabled,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,1,?,?)`,
        ).run(
          g.id, g.name, g.region, g.host, g.port,
          g.tls ? 'reverse-proxy' : 'none',
          g.sni || null, g.ws_path || '/ws', g.ws_host || null,
          g.priority ?? 100, now, now,
        );
      }
    }
  }

  if (tables.has('legacy_subscribers')) {
    for (const s of db.prepare('SELECT * FROM legacy_subscribers').all()) {
      const raw = String(s.expires_at || '');
      const expires = Date.parse(/[Zz]|[+-]\d\d:?\d\d$/.test(raw) ? raw : `${raw.replace(' ', 'T')}Z`);
      db.prepare(
        `INSERT INTO subscribers (id,name,token_hash,token_prefix,quota_bytes,used_bytes,expires_at,status,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        s.id, s.name, sha256(s.token), String(s.token).slice(0, 6),
        s.quota_bytes, s.used_bytes || 0,
        Number.isFinite(expires) ? expires : now + 30 * 86400000,
        s.status === 'disabled' ? 'disabled' : 'active', now, now,
      );
    }
  }

  if (tables.has('legacy_credentials')) {
    for (const c of db.prepare('SELECT * FROM legacy_credentials').all()) {
      const exists = db.prepare('SELECT 1 FROM subscribers WHERE id=?').get(c.subscriber_id);
      if (!exists) continue;
      db.prepare(
        `INSERT OR IGNORE INTO credentials (id,subscriber_id,uuid,state,created_at) VALUES (?,?,?,'active',?)`,
      ).run(`cr_${c.subscriber_id}`, c.subscriber_id, c.uuid, now);
    }
  }

  for (const t of ['legacy_credentials', 'legacy_usage_events', 'legacy_health_events', 'legacy_subscribers', 'legacy_gateways']) {
    if (tables.has(t)) db.exec(`DROP TABLE ${t}`);
  }
}

export const migrations = [
  {
    id: '001_control_plane_core',
    up(db, ctx) {
      const tables = new Set(
        db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name),
      );
      // Detect the 0.1 prototype schema (single gateways table with a kind column).
      const legacy =
        tables.has('gateways') &&
        db.prepare('PRAGMA table_info(gateways)').all().some((c) => c.name === 'kind');
      if (legacy) {
        for (const t of ['gateways', 'subscribers', 'credentials', 'usage_events', 'health_events']) {
          if (tables.has(t)) db.exec(`ALTER TABLE ${t} RENAME TO legacy_${t}`);
        }
      }
      db.exec(SCHEMA_V1);
      if (legacy) importLegacy(db, ctx.now, ctx.sha256);
    },
  },
  {
    id: '002_storefront',
    up(db) {
      db.exec(SCHEMA_V2_STOREFRONT);
      // A subscriber may now belong to a customer who bought it.
      db.exec('ALTER TABLE subscribers ADD COLUMN customer_id TEXT');
      // The storefront has to show a buyer their subscription URL again on every
      // visit, so the token is kept encrypted (not only hashed). The hash stays
      // the lookup key; the sealed copy is readable only with SECRET_KEY.
      db.exec('ALTER TABLE subscribers ADD COLUMN token_enc TEXT');
      db.exec('CREATE INDEX idx_subscribers_customer ON subscribers(customer_id)');
    },
  },
  {
    id: '003_subscriber_batches',
    up(db) {
      // Configs are often issued in batches (a day's worth to hand out), and an
      // operator needs to find, export and revoke a batch as a unit.
      db.exec('ALTER TABLE subscribers ADD COLUMN batch_id TEXT');
      db.exec('CREATE INDEX idx_subscribers_batch ON subscribers(batch_id, created_at)');
    },
  },
  {
    id: '004_admin_two_factor',
    up(db) {
      // The admin password is the only thing between the internet and every
      // gateway, subscriber and credential in the fleet. A second factor is
      // opt-in per admin: requiring it of an account with no enrolled device
      // would lock the fleet out of itself.
      db.exec('ALTER TABLE admins ADD COLUMN totp_secret TEXT');
      db.exec('ALTER TABLE admins ADD COLUMN totp_confirmed_at INTEGER');
      // The counter of the last code accepted. A code is valid for its whole
      // step, so without this, one read over a shoulder works again seconds
      // later.
      db.exec('ALTER TABLE admins ADD COLUMN totp_last_counter INTEGER');
      // Recovery codes are hashed like any other credential: shown once when
      // two-factor is switched on, each usable once, and the reason losing a
      // phone is not losing the fleet.
      db.exec(`CREATE TABLE admin_recovery_codes (
        code_hash TEXT PRIMARY KEY,
        admin_id TEXT NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL,
        used_at INTEGER
      )`);
      db.exec('CREATE INDEX idx_recovery_admin ON admin_recovery_codes(admin_id)');
    },
  },
  {
    id: '005_gateway_reality',
    // A table rebuild: SQLite has no way to widen a CHECK constraint, and
    // `transport` was written when WebSocket was the only thing a gateway
    // could speak. The recipe needs foreign keys off around it — DROP TABLE
    // fires ON DELETE CASCADE on the children otherwise, and that would take
    // every egress assignment and route switch with it.
    foreignKeysOff: true,
    up(db) {
      db.exec(`CREATE TABLE gateways_new (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        region TEXT NOT NULL,
        host TEXT NOT NULL,
        port INTEGER NOT NULL,
        protocol TEXT NOT NULL DEFAULT 'vless' CHECK (protocol IN ('vless')),
        transport TEXT NOT NULL DEFAULT 'ws' CHECK (transport IN ('ws','reality')),
        tls_mode TEXT NOT NULL DEFAULT 'none' CHECK (tls_mode IN ('none','reverse-proxy','xray')),
        sni TEXT,
        ws_path TEXT NOT NULL DEFAULT '/ws',
        ws_host TEXT,
        listen_address TEXT NOT NULL DEFAULT '0.0.0.0',
        listen_port INTEGER,
        tls_cert_path TEXT,
        tls_key_path TEXT,
        -- REALITY: the site whose handshake the gateway borrows, the names a
        -- client may claim, the X25519 pair, and the short IDs that separate a
        -- subscriber from someone who gets forwarded to the borrowed site.
        reality_dest TEXT,
        reality_server_names TEXT,
        reality_private_key TEXT,
        reality_public_key TEXT,
        reality_short_ids TEXT,
        reality_fingerprint TEXT NOT NULL DEFAULT 'chrome',
        priority INTEGER NOT NULL DEFAULT 100,
        enabled INTEGER NOT NULL DEFAULT 1,
        block_private_ranges INTEGER NOT NULL DEFAULT 1,
        agent_key_enc TEXT,
        agent_key_hint TEXT,
        agent_key_created_at INTEGER,
        ingress_status TEXT NOT NULL DEFAULT 'unknown'
          CHECK (ingress_status IN ('unknown','online','degraded','offline')),
        ingress_latency_ms INTEGER,
        ingress_checked_at INTEGER,
        ingress_fail_count INTEGER NOT NULL DEFAULT 0,
        ingress_detail TEXT,
        agent_status TEXT NOT NULL DEFAULT 'never-seen'
          CHECK (agent_status IN ('never-seen','online','stale')),
        agent_version TEXT,
        xray_version TEXT,
        agent_last_seen_at INTEGER,
        config_version INTEGER NOT NULL DEFAULT 1,
        deployed_config_version INTEGER,
        deployed_at INTEGER,
        deploy_error TEXT,
        active_egress_id TEXT,
        active_egress_since INTEGER,
        active_egress_reason TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`);
      // Named columns on both sides: the new ones sit in the middle, and a
      // positional INSERT ... SELECT * would put ws_host into reality_dest.
      const columns = [
        'id', 'name', 'region', 'host', 'port', 'protocol', 'transport', 'tls_mode', 'sni',
        'ws_path', 'ws_host', 'listen_address', 'listen_port', 'tls_cert_path', 'tls_key_path',
        'priority', 'enabled', 'block_private_ranges', 'agent_key_enc', 'agent_key_hint',
        'agent_key_created_at', 'ingress_status', 'ingress_latency_ms', 'ingress_checked_at',
        'ingress_fail_count', 'ingress_detail', 'agent_status', 'agent_version', 'xray_version',
        'agent_last_seen_at', 'config_version', 'deployed_config_version', 'deployed_at',
        'deploy_error', 'active_egress_id', 'active_egress_since', 'active_egress_reason',
        'created_at', 'updated_at',
      ].join(', ');
      db.exec(`INSERT INTO gateways_new (${columns}) SELECT ${columns} FROM gateways`);
      db.exec('DROP TABLE gateways');
      db.exec('ALTER TABLE gateways_new RENAME TO gateways');
      db.exec('CREATE INDEX idx_gateways_priority ON gateways(priority, name)');
      // A REALITY gateway is checked with a TLS handshake rather than a
      // WebSocket upgrade — there is no HTTP on that port at all — and the
      // kinds a health check may have were fixed when there was.
      db.exec(`CREATE TABLE health_checks_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        target_type TEXT NOT NULL CHECK (target_type IN ('gateway','egress')),
        target_id TEXT NOT NULL,
        gateway_id TEXT,
        check_kind TEXT NOT NULL CHECK (check_kind IN ('tcp','http','tls','e2e')),
        status TEXT NOT NULL,
        latency_ms INTEGER,
        detail TEXT,
        source TEXT NOT NULL CHECK (source IN ('control-plane','agent')),
        created_at INTEGER NOT NULL
      )`);
      db.exec(`INSERT INTO health_checks_new
        (id,target_type,target_id,gateway_id,check_kind,status,latency_ms,detail,source,created_at)
        SELECT id,target_type,target_id,gateway_id,check_kind,status,latency_ms,detail,source,created_at
        FROM health_checks`);
      db.exec('DROP TABLE health_checks');
      db.exec('ALTER TABLE health_checks_new RENAME TO health_checks');
      db.exec('CREATE INDEX idx_health_target ON health_checks(target_type, target_id, created_at DESC)');

      const orphans = db.pragma('foreign_key_check');
      if (orphans.length) throw new Error(`gateway rebuild left ${orphans.length} orphaned rows`);
    },
  },
  {
    id: '006_two_products',
    up(db) {
      // The VPN tab and the Configs tab are two products sold separately, and
      // until now a customer had one subscription that both read. Buying a
      // Configs plan topped up the quota the VPN tab was spending.
      //
      // 'all' is not a product anybody sells. It is what every existing
      // subscription becomes, because those were sold before the split and
      // taking half of one away from somebody who paid for it is not a
      // migration. An operator can also grant it deliberately.
      db.exec(`ALTER TABLE subscribers ADD COLUMN product TEXT NOT NULL DEFAULT 'all'`);
      db.exec('CREATE INDEX idx_subscribers_customer_product ON subscribers(customer_id, product)');

      // What a plan sells, and how it is priced.
      //   vpn      — the managed servers, one button, pick a country
      //   configs  — the config list, to use here or carry to another client
      db.exec(`ALTER TABLE plans ADD COLUMN product TEXT NOT NULL DEFAULT 'vpn'`);
      // duration — 1, 3, 6 or 12 months
      // volume   — a gigabyte at a time, settled by hand, and often not on sale
      db.exec(`ALTER TABLE plans ADD COLUMN billing TEXT NOT NULL DEFAULT 'duration'`);

      // Which product an order was for. The plan carries it, but a plan can be
      // edited or deleted after the sale, and an order is a record of what was
      // actually bought.
      db.exec(`ALTER TABLE orders ADD COLUMN product TEXT NOT NULL DEFAULT 'vpn'`);
      db.exec(`UPDATE orders SET product = 'all'`);
    },
  },
  {
    id: '007_adaptive_inbounds',
    up(db) {
      // A gateway has always had exactly one way in, named by its own columns.
      // One way in is one thing to block: a censor who learns the shape of a
      // VLESS-over-WebSocket connection has learned the shape of the whole
      // fleet, and there is nothing for a client to fall back to.
      //
      // These are *additional* ways into the same gateway, each on its own
      // port, each a different protocol. The gateway's own columns are
      // untouched and the inbound they describe keeps being generated exactly
      // as before: this table can be empty, and then nothing anywhere changes.
      db.exec(`CREATE TABLE gateway_inbounds (
        id TEXT PRIMARY KEY,
        gateway_id TEXT NOT NULL REFERENCES gateways(id) ON DELETE CASCADE,
        -- shadowsocks: 2022-blake3, no certificate, nothing to buy or burn
        -- trojan:      real TLS, so only on a gateway that holds a certificate
        -- reality:     a second borrowed handshake, on its own port and site
        kind TEXT NOT NULL CHECK (kind IN ('shadowsocks','trojan','reality')),
        port INTEGER NOT NULL,
        listen_address TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        -- shadowsocks
        method TEXT,
        server_key TEXT,
        -- reality, per inbound: a second inbound borrowing the same site as the
        -- first would be the same fingerprint twice and worth nothing.
        reality_dest TEXT,
        reality_server_names TEXT,
        reality_short_ids TEXT,
        reality_private_key TEXT,
        reality_public_key TEXT,
        reality_fingerprint TEXT,
        -- what the control plane last measured about this port
        status TEXT NOT NULL DEFAULT 'unknown',
        latency_ms INTEGER,
        checked_at INTEGER,
        fail_count INTEGER NOT NULL DEFAULT 0,
        detail TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE (gateway_id, port)
      )`);
      db.exec('CREATE INDEX idx_gateway_inbounds_gateway ON gateway_inbounds(gateway_id, enabled)');

      // Health checks can now be about a port rather than about a gateway, and
      // the kinds were fixed when they could not be. Rebuilt rather than
      // altered: SQLite cannot widen a CHECK in place.
      db.exec(`CREATE TABLE health_checks_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        target_type TEXT NOT NULL CHECK (target_type IN ('gateway','egress','inbound')),
        target_id TEXT NOT NULL,
        gateway_id TEXT,
        check_kind TEXT NOT NULL CHECK (check_kind IN ('tcp','http','tls','e2e')),
        status TEXT NOT NULL,
        latency_ms INTEGER,
        detail TEXT,
        source TEXT NOT NULL CHECK (source IN ('control-plane','agent')),
        created_at INTEGER NOT NULL
      )`);
      db.exec(`INSERT INTO health_checks_new
        (id,target_type,target_id,gateway_id,check_kind,status,latency_ms,detail,source,created_at)
        SELECT id,target_type,target_id,gateway_id,check_kind,status,latency_ms,detail,source,created_at
        FROM health_checks`);
      db.exec('DROP TABLE health_checks');
      db.exec('ALTER TABLE health_checks_new RENAME TO health_checks');
      db.exec('CREATE INDEX idx_health_target ON health_checks(target_type, target_id, created_at DESC)');

      const orphans = db.pragma('foreign_key_check');
      if (orphans.length) throw new Error(`inbound migration left ${orphans.length} orphaned rows`);
    },
  },
  {
    id: '008_assistant',
    up(db) {
      // Support that answers at three in the morning.
      //
      // One row per conversation, and `state` is the whole handoff mechanism:
      // while it is 'bot' the assistant answers, and once it is 'human' the
      // assistant stops answering that chat entirely until an operator hands it
      // back. A person who has asked for a human and keeps getting a machine is
      // worse off than one who was told to wait.
      db.exec(`CREATE TABLE assistant_chats (
        id TEXT PRIMARY KEY,
        channel TEXT NOT NULL CHECK (channel IN ('telegram')),
        channel_chat_id TEXT NOT NULL,
        -- Null until the person links their account. An unlinked chat can still
        -- ask what is on sale; it just has no account to look into.
        customer_id TEXT REFERENCES customers(id) ON DELETE SET NULL,
        state TEXT NOT NULL DEFAULT 'bot' CHECK (state IN ('bot','human')),
        handoff_reason TEXT,
        handoff_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE (channel, channel_chat_id)
      )`);
      db.exec('CREATE INDEX idx_assistant_chats_state ON assistant_chats(state, updated_at DESC)');

      // The transcript. It is what an operator reads when a chat reaches them,
      // and it is what the assistant reads to know what was already said.
      db.exec(`CREATE TABLE assistant_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id TEXT NOT NULL REFERENCES assistant_chats(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK (role IN ('user','assistant','operator','system')),
        body TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )`);
      db.exec('CREATE INDEX idx_assistant_messages_chat ON assistant_messages(chat_id, id)');

      // How a Telegram chat proves whose account it is.
      //
      // The code is issued to a signed-in session on the storefront and typed
      // into the bot. A password never travels through a chat app, and a code
      // that has been used or has expired opens nothing.
      db.exec(`CREATE TABLE link_codes (
        code TEXT PRIMARY KEY,
        customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        used_at INTEGER
      )`);
      db.exec('CREATE INDEX idx_link_codes_customer ON link_codes(customer_id, expires_at)');

      const orphans = db.pragma('foreign_key_check');
      if (orphans.length) throw new Error(`assistant migration left ${orphans.length} orphaned rows`);
    },
  },
  {
    id: '009_email_codes',
    up(db) {
      // The code that proves an address is reachable by the person typing it.
      //
      // Keyed by address rather than by account: it is asked for before anyone
      // knows whether there is an account, which is the whole point — the app
      // asks for one address, one password and one code, and the control plane
      // works out which of sign-in and registration that was. There is at most
      // one live code per address; a resend replaces it rather than leaving two
      // codes that both open the same door.
      //
      // Only the hash is kept. A code is a credential for as long as it lives,
      // and a backup of this table should not be a list of them.
      db.exec(`CREATE TABLE email_codes (
        email TEXT PRIMARY KEY,
        code_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        -- Guessing is bounded here, not by the HTTP rate limiter: six digits
        -- fall to a patient attacker spread thinly across many addresses.
        attempts INTEGER NOT NULL DEFAULT 0
      )`);
      db.exec('CREATE INDEX idx_email_codes_expiry ON email_codes(expires_at)');
    },
  },
  {
    id: '010_gateway_xhttp',
    // WebSocket is an HTTP/1.1 upgrade, and on the networks this serves that
    // shape is now reset on sight: the same phone's browser completes a
    // WebSocket handshake to the same address over HTTP/2 while the tunnel's
    // own connection is cut mid-dial, by the network rather than by either
    // end. XHTTP carries the tunnel as ordinary HTTP/2 requests instead, which
    // is the traffic that still passes — and is what Xray-core itself now
    // tells operators to move to, in a warning printed on every start.
    //
    // A table rebuild, because SQLite cannot widen a CHECK constraint, and
    // with foreign keys off for the same reason as 005: DROP TABLE would
    // cascade into every egress assignment.
    foreignKeysOff: true,
    up(db) {
      db.exec(`CREATE TABLE gateways_x (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        region TEXT NOT NULL,
        host TEXT NOT NULL,
        port INTEGER NOT NULL,
        protocol TEXT NOT NULL DEFAULT 'vless' CHECK (protocol IN ('vless')),
        transport TEXT NOT NULL DEFAULT 'ws' CHECK (transport IN ('ws','reality','xhttp')),
        tls_mode TEXT NOT NULL DEFAULT 'none' CHECK (tls_mode IN ('none','reverse-proxy','xray')),
        sni TEXT,
        ws_path TEXT NOT NULL DEFAULT '/ws',
        ws_host TEXT,
        listen_address TEXT NOT NULL DEFAULT '0.0.0.0',
        listen_port INTEGER,
        tls_cert_path TEXT,
        tls_key_path TEXT,
        reality_dest TEXT,
        reality_server_names TEXT,
        reality_private_key TEXT,
        reality_public_key TEXT,
        reality_short_ids TEXT,
        reality_fingerprint TEXT NOT NULL DEFAULT 'chrome',
        priority INTEGER NOT NULL DEFAULT 100,
        enabled INTEGER NOT NULL DEFAULT 1,
        block_private_ranges INTEGER NOT NULL DEFAULT 1,
        agent_key_enc TEXT,
        agent_key_hint TEXT,
        agent_key_created_at INTEGER,
        ingress_status TEXT NOT NULL DEFAULT 'unknown'
          CHECK (ingress_status IN ('unknown','online','degraded','offline')),
        ingress_latency_ms INTEGER,
        ingress_checked_at INTEGER,
        ingress_fail_count INTEGER NOT NULL DEFAULT 0,
        ingress_detail TEXT,
        agent_status TEXT NOT NULL DEFAULT 'never-seen'
          CHECK (agent_status IN ('never-seen','online','stale')),
        agent_version TEXT,
        xray_version TEXT,
        agent_last_seen_at INTEGER,
        config_version INTEGER NOT NULL DEFAULT 1,
        deployed_config_version INTEGER,
        deployed_at INTEGER,
        deploy_error TEXT,
        active_egress_id TEXT,
        active_egress_since INTEGER,
        active_egress_reason TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`);
      const columns = [
        'id', 'name', 'region', 'host', 'port', 'protocol', 'transport', 'tls_mode', 'sni',
        'ws_path', 'ws_host', 'listen_address', 'listen_port', 'tls_cert_path', 'tls_key_path',
        'reality_dest', 'reality_server_names', 'reality_private_key', 'reality_public_key',
        'reality_short_ids', 'reality_fingerprint',
        'priority', 'enabled', 'block_private_ranges', 'agent_key_enc', 'agent_key_hint',
        'agent_key_created_at', 'ingress_status', 'ingress_latency_ms', 'ingress_checked_at',
        'ingress_fail_count', 'ingress_detail', 'agent_status', 'agent_version', 'xray_version',
        'agent_last_seen_at', 'config_version', 'deployed_config_version', 'deployed_at',
        'deploy_error', 'active_egress_id', 'active_egress_since', 'active_egress_reason',
        'created_at', 'updated_at',
      ].join(', ');
      db.exec(`INSERT INTO gateways_x (${columns}) SELECT ${columns} FROM gateways`);
      db.exec('DROP TABLE gateways');
      db.exec('ALTER TABLE gateways_x RENAME TO gateways');
      db.exec('CREATE INDEX idx_gateways_priority ON gateways(priority, name)');
    },
  },
];
