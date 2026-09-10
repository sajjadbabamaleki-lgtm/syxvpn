# Security model

## Trust boundaries

| Actor | Authenticates with | Can reach |
| --- | --- | --- |
| Operator | username + password → bearer session | everything under `/api/v1` except `/api/v1/shop/*` |
| Customer | email + password → bearer session | `/api/v1/shop/*` for their own account only |
| Gateway agent | per-gateway HMAC-signed requests | `/api/v1/agent/*` for its own gateway only |
| Subscriber (client app) | subscription token in the URL | `/sub/<token>` |
| Anyone | — | `/health`, `/readiness`, `/api/v1/shop/plans`, `/api/v1/shop/config` |

The three session types are separate and non-interchangeable. An operator token
on a shop endpoint is a 401, and so is a customer token on a management
endpoint; both directions are covered by tests.

## Threats and what is done about them

### Stolen subscription URL
The token is 256 bits of CSPRNG output. Anyone holding it can fetch profiles,
so it is treated as a credential: never logged (only a six-character hint),
never shown in list views, rotatable in one action which invalidates the old URL
immediately. Credential rotation is separate, so a leaked URL and a leaked
VLESS uuid can be handled independently.

Subscription tokens are stored twice: as a SHA-256 hash (the lookup key) and
sealed with `SECRET_KEY` (AES-256-GCM). The sealed copy exists because a
customer must be able to see their own URL again on every visit. It is a
deliberate trade-off: an attacker with both the database and `SECRET_KEY` can
recover subscription URLs. Keep `SECRET_KEY` out of the database backup path.

### Stolen database snapshot
A snapshot *is* the database: every gateway's agent key, every REALITY private
key, every subscriber row. `SECRET_KEY` is deliberately not in it, so a snapshot
alone cannot decrypt sealed subscription tokens — but a snapshot and the key
stored in the same place are one secret, not two. `BACKUP_DIR` is `0700`, is
never served by the web container, and downloading a snapshot through the API
requires an admin session and is recorded as a critical event. See
docs/DEPLOYMENT.md.

### Leaked operator token
Sessions expire (`ADMIN_SESSION_TTL_SECONDS`, 12h default), are stored hashed,
and a password change revokes every session for that account. Login is rate
limited per IP *and* per username, so an account cannot be brute-forced from a
pool of addresses.

### Malicious or compromised gateway agent
An agent can only act for its own gateway. It can report health and usage for
its own subscribers, so a compromised gateway can burn a subscriber's quota;
per-report counter deltas are capped and anything above the ceiling raises an
event. It cannot read other gateways' configuration, other customers' data, or
any operator endpoint. Rotating the agent key invalidates the old one at once.

### Replayed agent request
Every agent request is signed over method, path, timestamp, nonce and a hash of
the body. Timestamps outside `AGENT_MAX_SKEW_SECONDS` are rejected, and each
nonce is stored until it falls outside the window, so a captured request cannot
be replayed — including on a network where TLS terminates upstream.

### Forged usage report
Reports are idempotent by `(gateway_id, report_id)` and carry cumulative
counters, so replaying one changes nothing. Counters for unknown credentials are
dropped rather than guessed.

### Unauthorized gateway
A gateway only exists if an operator registered it, and only works if it holds
the agent key issued at registration. There is no self-registration.

### Enumeration
`/sub/<token>` returns the same 404 and the same body for a wrong token, an
expired subscription, a disabled account and an exhausted quota. Order lookups
are scoped to the owning customer.

### Configuration injection
Every write path is validated with zod: hostnames are matched against a
hostname/IPv4/IPv6 pattern (URLs and ports are rejected), ports are bounded,
WebSocket paths must start with `/` and stay URL-safe, and TLS settings are
rejected when the gateway could not actually serve them. Generated Xray config
is assembled from typed fields, never string-concatenated.

### Server-side request forgery from the data plane
Generated gateway configs blackhole traffic to private and link-local ranges by
default, so a subscriber cannot use a gateway to reach its LAN, the control
plane, or a cloud metadata service. The lab is the only place this is disabled.

### Secret leakage into logs
The logger redacts a fixed key list (passwords, tokens, agent keys, credentials,
signatures, uuids) and truncates long values. Subscription paths are logged as
`/sub/[token]`. Egress credentials are sealed at rest and never serialised to an
operator response — only into the config handed to that gateway's own agent.

### Payment fraud
An order is fulfilled only when a transfer of the exact expected amount is found
on chain, the transaction succeeded, and it is buried under
`PAYMENT_CONFIRMATIONS` blocks. Each order gets a unique amount so a transfer
maps to exactly one order. A transaction hash can settle only one order
(enforced by a unique index). A customer asserting payment provisions nothing.

### Excessive API calls
Per-route rate limits: login 10/min, subscription fetch 30/min, admin API
600/min, agent 600/min, storefront auth 12/min. The limiter is in-process, which
is correct for the single-instance SQLite deployment this targets — a
multi-instance deployment needs a shared store.

## Known limitations

- **Rate limiting is per process.** Two API containers double every limit.
- **No 2FA** on operator accounts.
- **No CSRF tokens**, because no endpoint authenticates by cookie; every
  authenticated call carries a bearer token set by JavaScript.
- **Session tokens live in `localStorage`.** A cross-site scripting bug would
  expose them. The app renders no untrusted HTML and loads no third-party
  scripts, which is what that choice depends on.
- **The blackout lab proves the software fails over.** It cannot prove a gateway
  stays reachable during a real disruption.
- **`SECRET_KEY` rotation is not automated.** Changing it invalidates stored
  agent keys, egress credentials and the readable copy of subscription tokens.

## Operational rules

- Never commit a filled-in `.env`.
- `ADMIN_PASSWORD`/`ADMIN_PASSWORD_HASH` and `SECRET_KEY` are required in
  production; the process refuses to start without them.
- Only register egress paths you are authorized to use. The `authorizationNote`
  field exists to record who authorized one and under what agreement.
