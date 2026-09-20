# Handover — state of the deployment, 2026-09-20

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
| Gateway `gw1` | the German host, `gw_LLa63NqkZTsE` | XHTTP on `/6749e3d2af833f06`, Xray on `127.0.0.1:10001` behind Caddy, reached as `api.xoft.pro` through Cloudflare. **This is the one that works from Iran.** |
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

## Solved: configs that only worked in this project's own app

**Fixed on 2026-09-20 and verified end to end** — the same config line now
imports and carries traffic in v2rayNG *and* NPV Tunnel, from the operator's
Iranian network.

Two independent faults were stacked on top of each other, which is why every
single-cause theory failed: fixing either one alone still left a dead tunnel.

### Fault 1 — the tunnel's shape. WebSocket is reset on the way in.

A WebSocket tunnel opens with an HTTP/1.1 `Upgrade` request, and from Iran that
request was being answered with an injected RST. The proof was a pair of tests
from one phone, on one network, against one path:

- v2rayNG, ws profile: `failed to dial to api.xoft.pro:443 > read tcp … ->
  188.114.99.0:443: read: connection reset by peer`.
- A browser opening a WebSocket to the identical URL: `OPEN - websocket works |
  closed 1000`.

The browser succeeds because it reaches Cloudflare over HTTP/2, where there is
no `Upgrade` line to match on. Xray's own client speaks HTTP/1.1.

The fix is **XHTTP** (`type=xhttp`, `mode=auto`), Xray's transport that carries
the tunnel inside ordinary HTTP requests. Upstream has deprecated WebSocket,
gRPC and HTTPUpgrade in its favour; `SplitHTTPConfig` in
`infra/conf/transport_internet.go` is the struct the wire format comes from, and
it takes `host`, `path` and `mode` under the key `xhttpSettings`.

Verified with a real Xray 26.6.27 — the same core v2rayNG ships — run on the
German host against the live gateway through Cloudflare: `exit_ip=173.249.47.5`.

### Fault 2 — the profile carried a dead name.

The gateway row still held `sni` and `ws_host` = `edge7.gamotion.pro`, left over
from an earlier attempt. So every config the operator console sold told the
client: connect to `api.xoft.pro` (Cloudflare), but announce `edge7.gamotion.pro`
in the TLS handshake. Cloudflare does not serve that name, so the handshake died
before any transport mattered. **Every config sold before this date was broken
this way**, regardless of client.

The row is now `sni=api.xoft.pro`, `ws_host=NULL`. Leaving `ws_host` empty is
deliberate: the gateway's XHTTP inbound only pins a `Host` header when that
column is set, and a gateway behind Cloudflare should accept whatever Host
arrives.

**Check this column pair first whenever a config "connects" but moves nothing.**
A profile whose `sni` is not a name the front door actually serves cannot work,
and nothing in the logs says so — the connection simply ends.

### What was ruled out along the way, with the evidence

Do not re-test these without a reason.

1. **The credential is missing from the gateway.** No: the gateway config built
   by the control plane contains the subscriber's UUID for both gateways
   (`has_ours: true`), and `config_version == deployed_config_version` with the
   agent last seen seconds earlier.
2. **The client profile is malformed.** No: `sid=0bac07f5` is in the inbound's
   `shortIds`, `sni=www.cloudflare.com` is in `serverNames`, `flow` matches on
   both sides, and `xray x25519 -i <gateway private key>` derives exactly the
   `pbk` the profile carries. (The `sni` fault above is a different thing: the
   profile was well formed, it just named a host nobody serves.)
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
7. **Buying a third server.** No — and this was the operator's call, correctly:
   two servers that both fail a name-based block do not become one that passes.
   The answer was the shape of the traffic, not another address.

### Ports, from the operator's Iranian network

Only **443** reaches a gateway. Tested, each with the listener confirmed up:

- 8443 — unreachable.
- 2053 — a Shadowsocks-2022 inbound, `ufw` and `iptables` opened, `ss -ltn`
  showing it listening, answering from Germany. From Iran: nothing.
- 80 — same inbound moved there, confirmed listening. The gateway's Xray log
  showed **no** line carrying that inbound's tag while a client tried.
- 443 — works.

The gateway's access log settles this kind of question: a connection that
reaches Xray produces a line naming the inbound tag. Nothing arriving is a
network fact, not a configuration one.

The Shadowsocks inbound `ib_3d5186b29a77` on `gw2` still sits on port 80 and is
useless there. Move it or delete it.

## How to test a gateway without a phone

This is the loop that found the answer, and it runs entirely on the German host.
It is worth keeping: it tells you whether a config is broken *before* anyone is
asked to install anything.

Write a client config — a local SOCKS door on 10888, the profile under test as
the outbound:

    printf '%s' '{"log":{"loglevel":"warning"},"inbounds":[{"port":10888,"listen":"127.0.0.1","protocol":"socks","settings":{"udp":true}}],"outbounds":[{"protocol":"vless","settings":{"vnext":[{"address":"api.xoft.pro","port":443,"users":[{"id":"<uuid>","encryption":"none"}]}]},"streamSettings":{"network":"xhttp","security":"tls","tlsSettings":{"serverName":"api.xoft.pro","fingerprint":"chrome"},"xhttpSettings":{"path":"<ws_path>","mode":"auto","host":"api.xoft.pro"}}}]}' > /tmp/c.json

Run it and ask the internet who you are:

    pkill -f /tmp/xray; sleep 1; nohup /tmp/xray -c /tmp/c.json >/tmp/xray.log 2>&1 & sleep 4; echo "exit_ip=$(curl -s --socks5-hostname 127.0.0.1:10888 --max-time 20 https://api.ipify.org)"; tail -n 8 /tmp/xray.log

`exit_ip=173.249.47.5` means the whole path works: Cloudflare, Caddy, Xray,
egress. An empty `exit_ip` with the log naming the step that failed is a far
better bug report than "it does not connect".

Use the binary v2rayNG uses, not the one the server runs — that is the whole
point of the test. `/tmp/xray` on the German host is Xray 26.6.27.

And print what the console would actually sell, rather than assuming:

    cd /opt/cvpn && docker compose --env-file .env -f deploy/docker-compose.yml exec -T api node -e "Promise.all([import('/app/src/db/index.js'),import('/app/src/domain/xray.js')]).then(([d,x])=>{const db=d.openDatabase('/data/cvpn.db');const g=db.prepare('select * from gateways where id=?').get('<gateway id>');console.log(x.clientProfile(g,'<uuid>'))})"

That command is what exposed Fault 2. The config in the database and the config
in the operator's hand had drifted, and only printing the second one showed it.

## Caddy in front of an XHTTP gateway

The gateway's path needs its subpaths too — XHTTP's packet-up mode appends
segments to it, so a matcher on the bare path silently drops half the transport:

    @gw path /6749e3d2af833f06 /6749e3d2af833f06/*
    handle @gw {
        reverse_proxy 127.0.0.1:10001 {
            flush_interval -1
        }
    }

`flush_interval -1` turns off response buffering; without it the tunnel stalls
rather than fails, which is harder to diagnose. The block lives in the
`control.cvpn.pro, api7.gamotion.pro, api.xoft.pro` site.

## The spare name, and the one command that switches to it

`cdn.gamotion.pro` is live and proven: a real Xray client on the German host
reached the gateway through it and got `exit_ip=173.249.47.5`, the same as
through the live name. It is a separate registration on separate nameservers
(`gamotion.pro`, Cloudflare, `mitchell`/`walk`), proxied, pointing at
`173.249.47.5`. The apex and `www` still serve Hostinger's parking page, which
is the right camouflage: from outside, the domain is somebody's unfinished site.

Caddy serves it from the same site block as the live name — one line, so the
spare inherits the control plane, the gateway path and the APK download
together and cannot drift from them:

    control.cvpn.pro, api7.gamotion.pro, api.xoft.pro, cdn.gamotion.pro {

The app already carries it, second in `CONTROL_PLANE_URLS`, which is the part
that has to be done in advance: on the day the live name is filtered, nothing
can be delivered to a phone, because the delivery would travel over the name
that just stopped working.

**When `api.xoft.pro` is filtered, this is the whole switch:**

    cd /opt/cvpn && docker compose --env-file .env -f deploy/docker-compose.yml exec -T api node -e "import('/app/src/db/index.js').then(d=>{const db=d.openDatabase('/data/cvpn.db');db.prepare('update gateways set host=?, sni=?, config_version=config_version+1 where id=?').run('cdn.gamotion.pro','cdn.gamotion.pro','gw_LLa63NqkZTsE');console.log(JSON.stringify(db.prepare('select id,host,sni,config_version,deployed_config_version from gateways where id=?').get('gw_LLa63NqkZTsE')))})"

Then set `PUBLIC_BASE_URL=https://cdn.gamotion.pro` in `/opt/cvpn/.env` and
restart the api service, so links the console hands out point at the name that
works. Subscriptions refresh themselves; a config line already in somebody's
client does not, and has to be reissued.

Wait for `deployed_config_version` to catch up to `config_version`, then test
from the German host with the loop above before telling anyone it is fixed.

**Buy the next spare now, not on the day.** A domain cannot be registered from
inside the situation that makes it necessary, and an app that does not already
know the name cannot be told it. The list in `build.gradle.kts` is where a new
one goes, and it only reaches phones through a new APK — so the lead time is a
build, not a command.

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
- A gateway's `sni` / `ws_host` columns are what end up in a sold config. They
  outlive the name that put them there, and a stale one breaks every config for
  that gateway with no error anywhere. Print `clientProfile` output, do not
  trust the row.
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
- **XHTTP end to end**: a `transport='xhttp'` gateway kind (migration
  `010_gateway_xhttp`), the inbound and the `vless://…type=xhttp&mode=auto`
  profile the console hands over, an ingress health probe that speaks it, and
  the same transport in the Android app's config builder.
- The app resolves a gateway's name itself (`GatewayAddress`) and dials the
  address, because the Go core cannot read Android's DNS settings and
  `1.1.1.1` is blocked in Iran.
- A uTLS fingerprint (`fp=chrome`) on every TLS path. Go's own handshake is a
  signature a censor can match on.

## Still open

- Every config sold before 2026-09-20 carries the dead `edge7.gamotion.pro`
  name and cannot work. Customers holding one need a reissue — the subscription
  link fixes itself on refresh, a pasted config line does not.
- `gw2` is disabled (`enabled=0`) and the container is left running. It has no
  stale-name fault — REALITY takes its names from `reality_server_names`, not
  `sni` — and the server is healthy: tested from Germany, `exit_ip=76.13.78.219`.
  It simply does not reach Iran: the same config failed in v2rayNG and NPV
  Tunnel from the operator's network. Re-enable with `enabled=1` if that
  changes; it is one command and costs nothing to leave off.
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
- One working gateway. `gw1` carries everything. The spare *name* above
  survives a name-based block, which is what has happened every time so far,
  but not the German host going down — that needs a second gateway, and the
  second one has to be somewhere REALITY-on-a-bare-IP is not what reaches Iran.
