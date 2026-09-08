# Jordan VPN

Jordan sells and operates managed access to authorized proxy infrastructure.

There are two halves to it. Customers see a storefront: pick a plan, pay in
USDT, get a subscription link that works in any Xray-compatible client. An
operator sees a control plane: gateways, egress paths, health, routing, quotas
and usage — designed to be run from a phone.

```
customer ──▶ storefront ──▶ order (USDT, TRC-20) ──▶ on-chain confirmation
                                                          │
                                                          ▼
                                              subscription + credential
                                                          │
client app ◀── /sub/<token> ◀── control plane ◀───────────┘
   │
   ▼
gateway (Xray, deployed by the agent) ──▶ selected egress ──▶ internet
```

## What is actually true about this

A `vless://` profile describes the **first hop only**. It tells a client how to
reach a gateway; it says nothing about how that gateway reaches the internet,
and it cannot create a path that does not exist. Jordan is built around that
distinction:

- **Ingress health** — can a client still reach the gateway? Measured by the
  control plane.
- **Egress health** — can the gateway still reach the internet? Only the
  gateway can answer that, so its agent measures it by sending probe traffic
  through each egress path and reports the result.

A gateway that is reachable with a dead egress and a gateway that is
unreachable are different failures with different fixes, and the UI never
collapses them into one status. When no egress is usable, the generated
configuration fails closed rather than quietly leaking traffic out of the
gateway's own default route.

Jordan routes only through connectivity the operator already has and is
authorized to use. It does not obtain access, and nothing here should be read
as a promise that a gateway stays reachable during a network disruption.

## Repository layout

| Path | What it is |
| --- | --- |
| `server/` | Control plane: API, database, health monitor, payment watcher |
| `src/` | Web app: customer storefront (2 screens) plus the operator console at `/admin` |
| `agent/` | Gateway agent: deploys Xray config, probes egress, reports usage |
| `android/` | Native client skeleton (VpnService + Xray) — never compiled, see its README |
| `lab/` | Blackout lab: an isolated Docker network that proves failover |
| `deploy/` | Production compose files and a reverse-proxy example |
| `docs/` | Architecture, security model, deployment, payments |

## Run it locally

```sh
# control plane
cd server && npm install && npm run dev
# it prints a generated admin password on first boot

# web app (separate terminal)
npm install
VITE_API_URL=http://localhost:8787 npm run dev
```

Open `http://localhost:5173` for the storefront and
`http://localhost:5173/#/admin` for the operator console.

With Docker:

```sh
cp .env.example .env     # fill in ADMIN_PASSWORD, SECRET_KEY, TRON_ADDRESS
docker compose -f deploy/docker-compose.yml up -d
```

## Tests

```sh
cd server && npm test        # 127 tests: auth, agent signing, routing, quota,
                             # usage accounting, payments, migrations
npm run test:e2e             # browser flow (needs playwright + a running stack)
cd lab && ./run-lab.sh       # 10 scenarios on an isolated Docker network
```

The lab is the interesting one: it builds a network where the client
container has no route to the test internet at all, then verifies that traffic
still flows through the gateway, that killing the primary egress moves traffic
to the backup, and that killing both makes the gateway fail closed while
remaining reachable.

## Documentation

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — components, data model, what runs where
- [`docs/SECURITY.md`](docs/SECURITY.md) — threat model and what is and is not defended
- [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) — running it for real, TLS, gateways
- [`docs/PAYMENTS.md`](docs/PAYMENTS.md) — how a USDT order becomes a subscription
- [`docs/ISSUING-CONFIGS.md`](docs/ISSUING-CONFIGS.md) — issuing configs by hand, in bulk, and what a quota really enforces
- [`agent/README.md`](agent/README.md) — the gateway agent
- [`android/README.md`](android/README.md) — the native client and what it still needs
