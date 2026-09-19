# Blackout lab

A controlled Docker environment where the client container has **no route to
the test internet at all**. It exists to answer one question honestly: does the
software actually route around a dead egress, or does it only say it does?

```
client ──edge──▶ gateway ──transit──▶ egress-a ──world──▶ origin
                    │                  egress-b ──▶
                    └── control plane (edge)
```

Every lab network is `internal: true`, so nothing reaches the real internet. The
client is attached to `edge` only, which is what makes "the client can only get
out through a gateway" a property of the topology rather than an assertion in a
test.

## Run it

```sh
./fetch-xray.sh     # once: downloads the pinned Xray release into lab/bin
./run-lab.sh        # builds, runs every scenario, tears down
```

`KEEP_LAB=1 ./run-lab.sh` leaves it running for inspection.
`LAB_SKIP_BUILD=1` reuses the images.

## What it asserts

| | Scenario |
| --- | --- |
| S1 | The client reaches the origin through the gateway |
| S2 | The client has no direct route to the test internet |
| S3 | The control plane measures the gateway as reachable (real WebSocket upgrade) |
| S4 | The gateway measures its egress path end to end, through the data plane |
| S6 | Killing the primary egress is detected and routed around |
| S7 | Client traffic recovers over the backup, confirmed from the backup's own logs |
| S5a | With both egresses dead the gateway is still reachable — a different failure |
| S5b | With no usable egress the gateway fails closed |
| S8 | Restoring the primary returns the route to it |
| S9 | Traffic is accounted against the subscriber's quota |

Last run: 10/10 passed against Xray 26.3.27, primary-to-backup failover taking
about eleven seconds from the egress dying to client traffic flowing again.

## What it does not prove

That a gateway stays reachable during a real national disruption. Nothing in a
lab can prove that, and no configuration can create a path that does not exist.
The lab proves the control plane, the agent and the generated data plane behave
correctly when a path dies — no more.

## REALITY

The docker scenarios above are all WebSocket. `reality-e2e.mjs` covers the
REALITY path separately, without docker, and answers the question the other
tests do not: does a config this control plane issues work in a **third-party**
client? It takes the `vless://` link from `clientProfile()`, builds a client
from only what that link carries — the way v2rayNG and NPV Tunnel build theirs —
and runs it against the inbound `gatewayServerConfig()` produces.

```sh
node lab/reality-e2e.mjs
XRAY_SERVER_BIN=./lab/bin/xray-26.3.27 XRAY_CLIENT_BIN=./lab/bin/xray-26.6.27 \
  node lab/reality-e2e.mjs
```

The two binaries matter: a gateway usually runs an older core than the phone.
Both cores are asserted against the same generated pair, and a wrong public key
and a wrong short id must both be refused, or the run reports itself invalid.

Last run: the handshake passes on 26.3.27↔26.3.27, 26.3.27↔26.6.27 (the
deployed gateway against v2rayNG's core) and 26.6.27↔26.6.27. End-to-end
traffic passes wherever the egress can reach the lab origin; from Xray 26.6
`freedom` refuses to dial any special-use address, so on such a core that half
reports itself skipped rather than failing for a reason unrelated to the config.

## Files

| Path | What it is |
| --- | --- |
| `docker-compose.yml` | The isolated topology |
| `lab.mjs` | The driver: registers real infrastructure, asserts each scenario |
| `probe.mjs` | Dependency-free HTTP/SOCKS5 probe used inside the containers |
| `Dockerfile.xray` | Xray + Node, built from `lab/bin` so the build needs no network |
| `Dockerfile.agent` | The real agent source plus the pinned Xray binary |
| `fetch-xray.sh` | Downloads the pinned release into `lab/bin` (gitignored) |
| `reality-e2e.mjs` | The issued REALITY link against the issued inbound, on real cores |
