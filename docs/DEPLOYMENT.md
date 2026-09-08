# Deployment

## What runs where

| Host | Runs | Reachable from |
| --- | --- | --- |
| Control plane | `server/` + the web app + a TLS reverse proxy | customers and operators; gateway agents |
| Gateway | Xray + `agent/` + a TLS reverse proxy | clients (public), control plane |
| Egress | whatever provides the authorized upstream path | gateways only |

The control plane never carries subscriber traffic. Gateways never hold customer
or payment data.

## 1. Control plane

```sh
cp .env.example .env
```

Fill in at least:

```sh
NODE_ENV=production
ADMIN_PASSWORD=...              # or ADMIN_PASSWORD_HASH from server/scripts/hash-password.js
SECRET_KEY=$(openssl rand -base64 32)
PUBLIC_BASE_URL=https://control.example.net
CORS_ORIGINS=https://control.example.net
TRON_ADDRESS=T...               # only if you are selling
TRUST_PROXY=true                # you are behind a reverse proxy
```

```sh
docker compose -f deploy/docker-compose.yml up -d
docker compose -f deploy/docker-compose.yml logs -f api
```

The API starts on 8787 and the web app on 8080; put TLS in front of both. A
Caddy example is in `deploy/Caddyfile.example`.

Back up the database file (`DB_PATH`) **and** `SECRET_KEY`. Neither is useful
without the other: the key decrypts agent keys, egress credentials and the
readable copy of subscription tokens.

## 2. A gateway

Each gateway needs a public hostname, a TLS certificate, and Xray. The
recommended topology terminates TLS in a reverse proxy and keeps Xray on
loopback:

```
client ──TLS──▶ Caddy :443 ──ws──▶ Xray 127.0.0.1:10001 ──▶ egress
```

Register the gateway in the operator console (`/admin/gateways`) with:

- **Public host/port** — what clients dial (443)
- **TLS** — "terminated by a reverse proxy"
- **Xray loopback port** — 10001
- **WebSocket path** — something non-obvious

Registration returns an agent key **once**. Then on the gateway host:

```sh
docker run -d --name jordan-agent --restart unless-stopped \
  --network host \
  -e JORDAN_URL=https://control.example.net \
  -e JORDAN_GATEWAY_ID=gw_... \
  -e JORDAN_AGENT_KEY=jga_... \
  -v /var/lib/jordan-agent:/var/lib/jordan-agent \
  jordan/agent:latest
```

The agent fetches its configuration, tests it with `xray -test`, deploys it
atomically and starts reporting. Within a minute the console should show the
gateway online with its agent reporting.

`deploy/Caddyfile.example` contains the matching reverse-proxy block.

## 3. Egress paths

An egress is how a gateway reaches the internet. Three kinds:

- **direct** — the gateway's own uplink; `bindAddress` selects which authorized
  source address to leave from on a multi-homed host
- **socks** — an authorized SOCKS5 proxy you control
- **vless** — an authorized upstream VLESS server you control

Give each one a `probeUrl` — the agent fetches it *through that path*, which is
what turns "online" into a measurement rather than an assumption. Assign egress
paths to gateways with a priority; lower wins, and the rest is failover.

Register only paths you are authorized to use. `authorizationNote` is there to
record who authorized one.

## 4. Plans

`/admin/plans`. Until at least one plan is published and `TRON_ADDRESS` is set,
customers can browse but not buy.

## Operating notes

- `/health` is liveness, `/readiness` is dependencies. Point your monitor at
  `/readiness`; it also reports whether payments are configured.
- The monitor probes gateways every `HEALTH_INTERVAL_SECONDS` and expires stale
  agent-reported egress health, so a silent agent degrades to `unknown` rather
  than staying green.
- A gateway with a red `config.inSync` is running an older configuration than
  the control plane intends — usually a stopped agent.
- Upgrades: migrations run on boot and are forward-only. Take a copy of the
  database file first.

## Scaling limits, honestly

SQLite and in-process rate limiting mean one API instance. That is enough for a
substantial number of gateways and subscribers, but running two containers
doubles every rate limit and will corrupt nothing while measuring nothing
usefully. Moving beyond one instance means Postgres and a shared limiter.
