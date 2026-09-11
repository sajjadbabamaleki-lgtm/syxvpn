# Deployment

## What runs where

| Host | Runs | Reachable from |
| --- | --- | --- |
| Control plane | `server/` + the web app + a TLS reverse proxy | customers and operators; gateway agents |
| Gateway | Xray + `agent/` + a TLS reverse proxy | clients (public), control plane |
| Egress | whatever provides the authorized upstream path | gateways only |

The control plane never carries subscriber traffic. Gateways never hold customer
or payment data.

## 0. Names

| Name | Points at | Proxy |
| --- | --- | --- |
| `syxvpn.pro`, `www.syxvpn.pro` | the control-plane host | Cloudflare is fine |
| `control.syxvpn.pro` | the same host | Cloudflare is fine |
| `gw1.syxvpn.pro`, `gw2…` | each gateway host, one record each | **DNS only — grey cloud** |

A gateway is never proxied through Cloudflare. The tunnel is not ordinary web
traffic, proxying it breaks the TLS the client expects to terminate at the
gateway, and doing it would put this deployment on the wrong side of their
terms.

Keep the names you are no longer using rather than dropping them. An old domain
costs a registration a year and goes into the client's endpoint list behind the
current one, where it is reached only when the first name cannot be connected to
at all — which is a situation you cannot register a domain from inside of. The
Android build ships `control.syxvpn.pro` first, then `control.sixvpn.pro` and
`control.cvpn.pro` behind it — both names this product has been called, and
both worth the renewal for exactly this reason. Add more with
`SYXVPN_CONTROL_PLANE_URLS`, comma separated, in the order to try.

## 1. Control plane

```sh
cp .env.example .env
```

Fill in at least:

```sh
NODE_ENV=production
ADMIN_PASSWORD=...              # or ADMIN_PASSWORD_HASH from server/scripts/hash-password.js
SECRET_KEY=$(openssl rand -base64 32)
PUBLIC_BASE_URL=https://control.syxvpn.pro
CORS_ORIGINS=https://control.syxvpn.pro
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

There are two kinds, and the choice decides everything else about the host.

### REALITY (recommended)

Xray owns the public port and borrows a real site's TLS handshake. A client
that holds the public key and a short ID gets the tunnel; anyone else — a
censor's active prober included — is forwarded to the borrowed site and gets
that site's genuine certificate back.

```
client ──REALITY/TCP──▶ Xray :443 ──▶ egress
                          └─not a subscriber──▶ www.microsoft.com:443
```

Nothing else is needed on the machine: no domain pointed at it, no certificate,
no reverse proxy. **A bare IP address is enough**, which is what makes a spare
gateway cheap enough to keep spares.

```sh
CONTROL_URL=https://control.syxvpn.pro \
GATEWAY_HOST=203.0.113.9 GATEWAY_REGION=nl \
ADMIN_PASSWORD=… sh deploy/bootstrap-gateway.sh
```

Choosing the borrowed site is the one judgement call. It must speak TLS 1.3 and
HTTP/2, be reachable *from the gateway*, not be blocked where the subscribers
are, and not be yours — the whole disguise is that the handshake belongs to
somebody real. Pass a different one with `REALITY_DEST=www.cloudflare.com:443`.
Use different sites on different gateways: one dest across the fleet is itself
a fingerprint.

The X25519 pair and the short IDs are issued by the control plane. Do not run
`xray x25519` by hand — a key copied between gateways means one seized machine
exposes the rest.

### WebSocket behind a reverse proxy

The older topology. It needs a public hostname, a TLS certificate, and Caddy:

```
client ──TLS──▶ Caddy :443 ──ws──▶ Xray 127.0.0.1:10001 ──▶ egress
```

```sh
TRANSPORT=ws GATEWAY_HOST=gw2.syxvpn.pro … sh deploy/bootstrap-gateway.sh
```

Or register it in the operator console (`/admin/gateways`) with:

- **Public host/port** — what clients dial (443)
- **TLS** — "terminated by a reverse proxy"
- **Xray loopback port** — 10001
- **WebSocket path** — something non-obvious

It is worth keeping some of these: a certificate on a name you own is a
liability under scrutiny, but WebSocket-over-TLS survives places where plain
TCP on 443 to an unknown IP is what gets throttled. Run both.

### The agent

Registration returns an agent key **once**. Then on the gateway host:

```sh
# The container name and the state directory keep the name they were created
# under: an agent that is already running has its last-known-good configuration
# under that path, and renaming it would throw away the one file that lets a
# gateway recover from a bad config without a person on the machine.
docker run -d --name cvpn-agent --restart unless-stopped \
  --network host \
  -e SYXVPN_URL=https://control.syxvpn.pro \
  -e SYXVPN_GATEWAY_ID=gw_... \
  -e SYXVPN_AGENT_KEY=jga_... \
  -v /var/lib/cvpn-agent:/var/lib/cvpn-agent \
  syxvpn/agent:latest
```

The agent fetches its configuration, tests it with `xray -test`, deploys it
atomically and starts reporting. Within a minute the console should show the
gateway online with its agent reporting.

`deploy/Caddyfile.example` contains the matching reverse-proxy block — for a
WebSocket gateway only; a REALITY gateway must have nothing in front of it.

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
- Upgrades: migrations run on boot and are forward-only. Take a snapshot first
  (below); there is no down migration to fall back on.

## Backups

Everything the business is made of is in one SQLite file: subscribers,
customers, orders, every gateway's agent key, every REALITY private key, and
the sealed copy of every subscription token. The control plane snapshots it
every `BACKUP_INTERVAL_HOURS` (6 by default) into `BACKUP_DIR`, keeping the
newest `BACKUP_KEEP` (28, so about a week). `/admin/settings` lists them, takes
one on demand, and downloads one.

Snapshots use SQLite's `VACUUM INTO`, not a file copy. That matters: copying
`cvpn.db` by hand while the service is running produces a file that opens and
is quietly missing the last few minutes, because the recent pages are still in
the WAL.

**Two things this does not do for you.**

1. **Get the snapshot off the machine.** `BACKUP_DIR` is a host bind mount
   (`./backups` by default), so a snapshot survives losing the Docker volume,
   the container, and any query that empties a table. It does not survive the
   disk, the provider, or someone with root. Copy it somewhere else — anything
   that runs on a schedule and leaves the machine:

   ```sh
   rsync -az --delete /opt/cvpn/backups/ you@elsewhere:/backups/cvpn/
   ```

2. **Protect the file.** A snapshot is the database. Anyone holding one holds
   every gateway's agent key and every REALITY private key. Keep the directory
   `0700`, and do not put it anywhere the web server can serve it.

   `SECRET_KEY` is deliberately *not* in the database, and a snapshot without it
   cannot decrypt sealed subscription tokens. Keep it somewhere separate — a
   backup and the key to it in the same place is one secret, not two.

### Restoring

```sh
cd /opt/cvpn
docker compose -f deploy/docker-compose.yml stop api

# Into the volume the API reads, under the name it expects.
docker run --rm -v cvpn_cvpn-data:/data -v /opt/cvpn/backups:/backups:ro \
  alpine sh -c 'cp /backups/cvpn-20260910T041233Z.sqlite /data/cvpn.db && \
                rm -f /data/cvpn.db-wal /data/cvpn.db-shm && \
                chown 1000:1000 /data/cvpn.db'

docker compose -f deploy/docker-compose.yml start api
docker compose -f deploy/docker-compose.yml logs -f api
```

Removing `-wal` and `-shm` is not optional: they belong to the database that was
just replaced, and leaving them beside a different file is how a restore turns
into corruption. Restore the same `SECRET_KEY` as well, or every subscription
URL in the restored database becomes unreadable.

After the API comes back, migrations run against the restored file — a snapshot
from an older version is upgraded on boot, so an old backup is still a usable
one. Check `/readiness`, then re-run a gateway health check from the console:
the agents will still be running the configuration they had, which may be newer
than what the restored database thinks it deployed.

## Scaling limits, honestly

SQLite and in-process rate limiting mean one API instance. That is enough for a
substantial number of gateways and subscribers, but running two containers
doubles every rate limit and will corrupt nothing while measuring nothing
usefully. Moving beyond one instance means Postgres and a shared limiter.
