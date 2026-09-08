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

## Files

| Path | What it is |
| --- | --- |
| `docker-compose.yml` | The isolated topology |
| `lab.mjs` | The driver: registers real infrastructure, asserts each scenario |
| `probe.mjs` | Dependency-free HTTP/SOCKS5 probe used inside the containers |
| `Dockerfile.xray` | Xray + Node, built from `lab/bin` so the build needs no network |
| `Dockerfile.agent` | The real agent source plus the pinned Xray binary |
| `fetch-xray.sh` | Downloads the pinned release into `lab/bin` (gitignored) |
