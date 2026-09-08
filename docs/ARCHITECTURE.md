# Architecture

## The distinction everything else follows from

```
client ──▶ subscription ──▶ gateway (ingress) ──▶ egress ──▶ internet
```

A client profile only ever describes the first arrow. The scarce resource is the
last one: a path that is both available and authorized to reach international
connectivity. Jordan models ingress and egress as separate objects with separate
health, because they fail independently.

An old prototype config makes the point. A VMess profile with
`Host: google.com` set on its WebSocket headers still opens a TCP connection to
the address in the profile — the `Host` value belongs to the HTTP layer and
routes nothing. And a client profile never reveals the server's upstream path;
whatever that server did to reach the internet is invisible from the profile.

## Control plane and data plane

The **control plane** (`server/`) holds state and makes decisions: who may
connect, which gateways exist, which egress each gateway should use right now,
what has been used, what has been paid. It never carries subscriber traffic.

The **data plane** is Xray on each gateway host. It carries traffic and knows
only what the control plane deployed to it.

They meet in exactly two places: the agent fetches a configuration, and the
agent reports back (health, usage, deployment result).

## Components

### Control plane (`server/`)

| Module | Responsibility |
| --- | --- |
| `db/migrations.js` | Forward-only schema; epoch-ms timestamps everywhere |
| `auth/admin.js` | Operator sessions (scrypt password, hashed bearer token) |
| `auth/agent.js` | Per-gateway HMAC request signing with nonce replay protection |
| `domain/gateways.js` | Gateway registry, config assembly, deployment records |
| `domain/egresses.js` | Egress registry, assignment, credential sealing |
| `domain/routing.js` | Deterministic egress selection and failover |
| `domain/health.js` | Ingress probing, agent-reported egress health, staleness |
| `domain/subscribers.js` | Subscriptions, credentials, rotation, entitlement |
| `domain/usage.js` | Cumulative-counter accounting with dedup |
| `domain/shop.js` | Customers, plans, orders |
| `domain/xray.js` | All Xray configuration generation |
| `services/monitor.js` | Periodic probing, sweeps, entitlement enforcement |
| `services/payments.js` | On-chain settlement |

### Gateway agent (`agent/`)

Runs beside Xray on each gateway. Fetches configuration, validates it, tests it
with the real binary, deploys it atomically, keeps the previous file as
last-known-good, probes each egress path end to end, and reports usage from
Xray's per-user counters. See [`agent/README.md`](../agent/README.md).

### Web app (`src/`)

One bundle, two audiences. The customer app is the default route (plans,
payment, config). The operator console lives under `/admin` with a separate
session type; neither session can use the other's API.

## Data model

```
customers ──< orders >── plans
    │
    └──< subscribers ──< credentials
              │
              └──< usage_events, usage_counters

gateways ──< gateway_egress >── egresses
    │             │
    │             └── per-pair health (an egress can be up from A, down from B)
    ├──< route_switches
    └──< health_checks
```

Notable choices:

- **Timestamps are integers** (epoch ms). No SQLite date parsing anywhere.
- **Money is integers** in micro-USDT, the same precision as TRC-20 USDT.
- **Egress health is per (gateway, egress) pair**, not global, because that is
  the only measurement that means anything.
- **Credentials are separate rows from subscribers**, so rotation can keep an
  old credential deployed during a grace period while advertising the new one.

## Routing and failover

Selection is deterministic and inspectable. Candidates are the enabled egress
paths assigned to a gateway whose pair health is not `offline`, ranked by:

1. pair health (`online` < `degraded` < `unknown`)
2. assignment priority (lower wins)
3. egress priority (lower wins)
4. weight (higher wins)
5. measured latency (lower wins; unmeasured last)
6. id, as a stable tie-break

The current selection is retained unless a *strictly better* candidate exists,
so equal-ranked paths never flap. A change writes a `route_switches` row with
the reason, raises an event, and increments the gateway's `config_version` —
which is what makes failover real: the agent picks up the new version and
redeploys. If nothing is selectable, the generated config blackholes client
traffic while keeping the probe listeners alive, so the gateway can detect its
own recovery.

## Xray generation

Per gateway the control plane generates:

- a `vless` + `ws` inbound (loopback when a reverse proxy terminates TLS)
- one outbound per assigned egress, the active one first
- one loopback SOCKS inbound per egress, pinned by a routing rule to that egress
  alone — this is what makes end-to-end egress probing possible
- a stats API inbound on loopback, with per-user counters enabled
- private-range and bittorrent blocking (private ranges can be disabled for a lab)

Client profiles advertise `security=tls` only when something actually terminates
TLS, and `tlsMode: "xray"` is rejected without certificate paths.

## Usage accounting

Agents read Xray's cumulative per-user counters and post them with a report id.
The control plane derives deltas from the last value it saw for that
(gateway, credential, direction) triple, so a replayed report cannot double
count, a lost report is recovered by the next one, and an Xray restart reads as
a counter reset rather than a huge delta.

## What the control plane refuses to fake

- A subscription serves profiles only for gateways measured as reachable.
- Egress health older than `EGRESS_STALE_SECONDS` decays to `unknown`, never
  stays `online`.
- Usage is `—` until an agent has actually reported.
- An order is fulfilled only by a confirmed on-chain transfer, or by an operator
  settling it by hand — which is stored and displayed as such.
