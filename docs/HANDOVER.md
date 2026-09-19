# Handover — state of the deployment, 2026-09-19

Written at the end of a long session so the next one does not repeat its dead
ends. Everything below is either **verified** (a command was run and its output
read) or explicitly marked as unknown. Where a test disproved something, that is
recorded too: a ruled-out cause is worth as much as a confirmed one, and three
of the hypotheses in this file cost hours before they fell.

No secrets here. Passwords and keys live on the hosts.

## The fleet

| What | Where | Notes |
|---|---|---|
| Control plane + storefront + operator console | `173.249.47.5` (Contabo, Germany) | `/opt/cvpn`, docker compose, Caddy on the host |
| Gateway `gw2` | `76.13.78.219` (Hostinger, Lithuania) | REALITY on 443, container `cvpn-agent-gw2`, Xray 26.3.27 |
| Gateway `gw1` | the German host | Reachable from Europe; **not** usable from Iran |
| Egress | `eg_cthHLfB2SwM8` | kind `direct` (freedom) — no upstream proxy in the path |

The control plane's own tabs in the operator's terminal app: one session is the
German host, one is labelled `gateway` and is Lithuania. Commands for
`/opt/cvpn` and `docker compose` belong to Germany; `ufw`, `cvpn-agent-gw2` and
`xray` belong to the gateway.

## Names

Iranian filtering here is **by name**, and the names this product has used are
burned:

- `cvpn.pro`, `control.cvpn.pro` — filtered. Cut mid-handshake from Iran even
  when served through Cloudflare, so the block follows the name, not the host.
- `syxvpn.pro`, `control.syxvpn.pro` — filtered.
- `sixvpn.pro` — does not resolve.
- `gamotion.pro` — untouched by the censor but points at a burned address; it
  has `api7`/`edge7` records aimed at the German host from an earlier attempt.

**`xoft.pro` is the live name.** It sits on Cloudflare nameservers
(`mitchell` / `walk`), and:

- `api.xoft.pro` → A `173.249.47.5`, **proxied** (orange) — the control plane.
- `xoft.pro`, `www.xoft.pro` → the same host, proxied — the site.
- Caddy on the German host serves `api.xoft.pro` from the same block as
  `control.cvpn.pro`, and `xoft.pro` from the public-site block.
- `PUBLIC_BASE_URL=https://api.xoft.pro` in `/opt/cvpn/.env` (it was
  `api7.gamotion.pro` for most of the session; a first attempt to change it did
  not take, so verify with `grep` rather than assuming).

A gateway is never proxied through Cloudflare. Grey cloud, always.

Operator console: **`https://api.xoft.pro/app/#/admin`**. The `/app/#/` matters —
the app is hash-routed and `/admin` alone lands on the customer storefront,
which asks for an email and will never accept an operator password.

APK for customers: `https://api.xoft.pro/download/syxvpn.apk`, refreshed with

    cd /opt/cvpn/downloads && curl -fL -o syxvpn.apk \
      https://github.com/sajjadbabamaleki-lgtm/syxvpn/releases/download/app-latest/syxvpn-arm64-v8a.apk \
      && sha256sum syxvpn.apk | tee syxvpn.apk.sha256

GitHub is filtered in Iran, so the release link is for the server to fetch, not
for a customer to open.

## The open problem

**A config that works in this project's own Android app does not work in
v2rayNG or NPV Tunnel.** The tunnel reports itself connected and no traffic
moves. This is not cosmetic: configs are sold to people who use those apps.

### What was ruled out, with the evidence

Do not re-test these without a reason.

1. **The credential is missing from the gateway.** No: the gateway config built
   by the control plane contains the subscriber's UUID for both gateways
   (`has_ours: true`), and `config_version == deployed_config_version` with the
   agent last seen seconds earlier.
2. **The client profile is malformed.** No: `sid=0bac07f5` is in the inbound's
   `shortIds`, `sni=www.cloudflare.com` is in `serverNames`, `flow` matches on
   both sides, and `xray x25519 -i <gateway private key>` derives exactly the
   `pbk` the profile carries.
3. **Xray version mismatch.** No — this was tested rather than argued. Local
   REALITY server/client pairs, all PASS: 26.3.27↔26.3.27, **26.3.27↔26.6.27**
   (the deployed server against v2rayNG's core), 26.6.27↔26.6.27,
   26.9.9↔26.6.27. v2rayNG 5.25.82 reports Xray 26.6.27.
4. **UDP (and therefore plain DNS) cannot cross REALITY + Vision.** No: a UDP
   datagram was sent through a local REALITY tunnel over SOCKS5 UDP ASSOCIATE
   and echoed back (server 26.3.27, client 26.6.27).
5. **An egress that cannot carry UDP.** No: the egress is `direct`.
6. **A clock skew on the phone.** No: the same phone runs this project's app
   against the same gateway successfully.

### What the evidence does point at

**Only port 443 reaches the gateway from the operator's Iranian network.**

- 8443 — unreachable (earlier in the session).
- 2053 — a Shadowsocks-2022 inbound was created, the port was opened with `ufw`
  and `iptables`, `ss -ltn` showed it listening, and it answered from Germany.
  From Iran: nothing, in this project's own app as well as in v2rayNG.
- 80 — the same inbound was moved there, confirmed listening. The gateway's
  Xray log showed **no** line carrying the inbound's tag while a client tried,
  only the existing REALITY traffic on `client-in`.
- 443 — works.

The gateway's access log is the instrument that settles this: a connection that
reaches Xray produces a line naming the inbound tag. Nothing arriving means the
packets never got there, which is a network fact and not a configuration one.

Why REALITY itself fails in v2rayNG on port 443, where the same parameters work
from this project's app on the same phone, is **still unexplained**. The
gateway logs nothing for those attempts — which, for REALITY, is also what a
rejected handshake looks like, since a rejected client is forwarded to the
borrowed site in silence.

### The remaining plan

A second door that is also on port 443, which means a second address:

1. A second server (any provider) running Shadowsocks on 443 — this also buys
   redundancy the fleet does not have: if Lithuania stops, every user stops.
2. Or a second IPv4 on the Lithuanian host (Hostinger sells them), cheaper but
   with no redundancy.

The Shadowsocks inbound `ib_3d5186b29a77` on `gw2` currently sits on port 80 and
is useless there. Move it or delete it.

## Operational gotchas that cost time today

- The operator works from a phone terminal that **cannot supply interactive
  input**: `read -s` prints the prompt and returns empty. Anything needing a
  secret must take it from a file or an environment variable on the command
  line, or be done inside the container.
- **No Persian text inside a command.** It mangles on paste.
- One line per command. Multi-line heredocs and `(...)` groups have come back
  as `syntax error near unexpected token`.
- From `/opt/cvpn`: `docker compose --env-file .env -f deploy/docker-compose.yml …`.
- `openDatabase` takes a path: `openDatabase('/data/cvpn.db')`.
- `buildGatewayConfig` returns an envelope — the Xray config is `out.config`.
- `console.table` with `strftime` in SQL needs single quotes inside the SQL,
  which the shell eats; compute in JS instead.
- Deploy: `BRANCH=claude/filter-config-broken-c863mj sh /opt/cvpn/deploy/update.sh`.
- The admin password lives in the `admins` table, **not** in `.env`.
  `ADMIN_PASSWORD` is read once, at first boot. Changing it later does nothing;
  reset it by updating `password_hash` through the app's own `hashPassword`.

## Code delivered this session (branch `claude/filter-config-broken-c863mj`)

- The gateway agent is served its additional inbounds — they had never been
  deployed to any gateway since the feature shipped.
- `XRAY_LOG_LEVEL` is configurable; it was left on `debug` (which writes users'
  destinations to disk) and is back to `warning`.
- Android CI fixed; APKs build again.
- The app reaches its control plane **through its own tunnel** when the direct
  road fails: a loopback SOCKS inbound in the Xray config, routed to the
  gateway, tried after the direct attempt and preferred for five minutes once
  it wins.
- `api.xoft.pro` is first in the app's control-plane list.
- The operator console finishes a sale on one screen: config lines and a QR
  beside the subscription link, every door a subscriber has (not only the
  gateway's own inbound), each button naming its protocol.
- Config rows: identified by the config line rather than `host:port`, so two
  configs into one gateway stop being one row; a four-character tag from the
  credential; a per-row end-to-end test; hiding one config no longer hides
  every config at that address, and survives a restart.

## Still open

- **The third-party client problem above.** This is the one that matters.
- `agent/Dockerfile` pins `XRAY_VERSION=latest`. Every gateway built gets
  whatever was released that day — the Lithuanian box got 26.3.27 while the
  current release is 26.9.9. Pin it.
- `server/src/domain/health.js`: `checkGatewayIngress` turns a failed deeper
  probe into `degraded` when TCP is up, and `applyIngressResult` only counts
  failures on `offline`. A gateway can therefore sit `degraded` forever and
  stay in `usableGateways`, which is how a dead gateway keeps being handed out.
- `TunnelService.addDisallowedApplication(packageName)` keeps the app's own
  traffic out of its tunnel. Sockets are already protected, so the exclusion is
  not load-bearing; removing it would put `Latency.measure` through the tunnel
  and needs those sockets protected first.
- The operator password was reset from the database during this session and is
  a value that appeared in a chat transcript. Change it from the console.
- Two-factor is off on the operator account, on a console that is now reachable
  from anywhere.
- One live gateway. `gw1` is enabled and unusable from Iran; it is still being
  handed to subscribers.
