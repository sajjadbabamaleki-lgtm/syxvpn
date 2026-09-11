# Additional inbound protocols

A gateway has always had one door: VLESS, one port, one shape. A censor who
learns that shape has learned the fleet, and a client that is blocked on it has
nothing to try next.

A gateway can now carry more doors — same host, same credentials, same egress,
different protocol and port. The client is told about the ones it can use,
measures them against each other, and connects through whichever is working.

| Kind | What it is | Needs |
| --- | --- | --- |
| `shadowsocks` | 2022-blake3-aes-256-gcm | nothing — no certificate, no domain |
| `trojan` | trojan over real TLS | the gateway's own certificate paths |
| `reality` | a second borrowed handshake | a site to borrow (issued here) |

All three are native to the Xray already running on the gateway. No second
binary is deployed, no second config is generated, and the agent's deploy,
test and last-known-good path is the one it has always used.

## What does not change

- **The gateway's own inbound.** Its columns, its port, its profile: untouched.
  With no rows in `gateway_inbounds`, the generated configuration is byte for
  byte what it was.
- **Clients already on phones.** A subscription is negotiated now
  (`?protocols=shadowsocks,trojan,reality`). A client that does not ask — every
  build shipped before this — is answered with the vless-only list it has always
  been answered with, in the same order.
- **Accounting.** Every door carries the same per-user email, the credential id,
  so Xray's counters are unchanged and a subscriber spends the same quota
  whichever way they came in.
- **Secrets.** Nothing new is stored. A subscriber's key for a door is derived
  (HKDF over their credential UUID, salted with the inbound id), so rotating a
  credential rotates every derived key with it.

## Rolling it out

Three dials, each of which is also a way back.

| Dial | Where | Effect |
| --- | --- | --- |
| `ADAPTIVE_INBOUNDS` | control plane env | Off: nothing is generated, served or probed, whatever is configured |
| `ADAPTIVE_INBOUNDS_PERCENT` | control plane env | Share of subscribers told the extra doors exist |
| `enabled` | per inbound row | One door, on one gateway |

The order to do it in:

1. **One gateway, flag off.** Add a door and leave `ADAPTIVE_INBOUNDS=false`.
   Nothing is deployed; the row exists.

       POST /api/v1/gateways/<id>/inbounds  { "kind": "shadowsocks", "port": 8388 }

   Open the port on the host's firewall. A door nobody can reach measures as
   offline, which is correct and is also not useful.

2. **Turn generation on, tell nobody.** `ADAPTIVE_INBOUNDS=true` with
   `ADAPTIVE_INBOUNDS_PERCENT=0`. The gateway deploys the new inbound on its
   next config fetch; the control plane starts probing it; no subscriber is told
   it exists. Watch for one full monitor interval:

       GET /api/v1/gateways/<id>/inbounds        · status should be "online"
       GET /api/v1/observability/health-checks?targetType=inbound
       GET /api/v1/observability/events?severity=warning

   The gateway's own ingress status must not have moved. If it has, the new
   inbound is interfering with the old one — take the door out and find out why
   before going further.

3. **A few subscribers.** `ADAPTIVE_INBOUNDS_PERCENT=5`. Which subscribers is
   decided by a hash of the subscriber id, so it is the same five percent on
   every fetch, and raising the number later only ever adds to them.

4. **Widen, slowly.** 25, then 50, then 100, leaving at least a day between
   steps. What to watch at each step is below.

5. **The second and third gateway.** Repeat from (1). There is no need to hurry:
   a subscriber whose gateway has no extra doors is exactly where they were.

## What to watch

| Signal | Where | What it means |
| --- | --- | --- |
| inbound `status` | `GET /gateways/<id>/inbounds` | A door measured offline stops being advertised on the next fetch |
| `gateway.offline` / `gateway.degraded` events naming an inbound | `GET /observability/events` | That door failed its probes; the gateway itself is still up, which is why it is a warning and not a page |
| gateway `ingress_status` | gateway list | Must not change when a door is added. If it does, stop |
| `config_version` | gateway list | Bumps on every inbound change; the agent redeploys on the next fetch |
| deployment failures | agent logs | The agent tests a config with the real binary before deploying and keeps the last good one, so a bad config is a gateway that did not change rather than a gateway that fell over |

## Rolling back

In the order of how much they take back:

- **One door**: `PATCH /gateways/<id>/inbounds/<inboundId> { "enabled": false }`.
  It stops being generated and stops being advertised on the next fetch.
- **One fleet-wide dial**: `ADAPTIVE_INBOUNDS_PERCENT=0`. Every subscriber is
  answered with the vless-only list again; the doors stay up, which means the
  clients that are *currently* connected through one are not thrown off.
- **Everything**: `ADAPTIVE_INBOUNDS=false`. The control plane generates,
  serves and probes exactly what it did before the feature existed. Gateways
  drop the extra inbounds on their next config fetch, so a client holding one of
  those profiles falls back to the vless door on its own — which is the
  behaviour the client has when any door stops answering.

No migration is undone in any of these. The rows stay; they are simply not read.

## Client side

A build of the app that knows about this asks for the protocols it can dial and
ranks every door it is given — each is a candidate in its own right, with its
own measurements and its own memory of how often it has worked. The tunnel
switches between them the way it has always switched between gateways: on
evidence, with hysteresis, and without taking the interface down.

`XrayConfigBuilder.PROTOCOLS` is the list the client asks for. Adding a protocol
to the control plane without adding it there means no client will ever ask for
it — which is the safe direction for that mistake to point.

## Describing it to customers

These are privacy and reliability features, and that is how they should be
written about in a store listing: "connects reliably on restrictive networks",
"more than one way to reach our servers", "encrypted DNS". Not "bypass", not
"circumvention", not the name of any country's filtering system. The App Store
and Play policies both have room for a VPN that is honest about being a VPN;
they have much less room for one that advertises what it defeats.
