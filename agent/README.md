# SyxVPN gateway agent

Runs on a gateway host next to Xray. It is the only component that holds
data-plane secrets, and the only one that touches the Xray configuration file.

## What it does

| Interval | Action |
| --- | --- |
| `HEARTBEAT_SECONDS` (30s) | Reports liveness/version, learns whether a newer config version exists |
| on change | Fetches, validates, tests and deploys the Xray configuration |
| `HEALTH_SECONDS` (60s) | Probes every assigned egress path end to end and reports the result |
| `USAGE_SECONDS` (60s) | Reads cumulative per-user counters from the Xray stats API and reports them |

## Safe configuration deployment

```
fetch -> structural validation -> write <config>.next.json -> `xray -test`
      -> copy running config to xray.last-good.json -> atomic rename
      -> reload -> wait for the stats API port -> report result
```

If validation or `xray -test` fails, the running configuration is never
touched. If the process does not come back after a reload, the last-known-good
file is restored and re-applied, and the failure is reported to the control
plane, which surfaces it as a `config.rejected` event.

## Applying subscriber changes without a restart

A gateway's configuration is split into its structure (inbound, outbounds,
routing) and its client list. When the control plane sends a version whose
structure hash is unchanged, the agent works out which credentials were added or
removed and applies them through Xray's API (`xray api adu` / `rmu`), then
rewrites the config file so a later restart starts from the truth. Nothing is
restarted and no connection is dropped.

If any of that fails, the agent falls back to a full deployment rather than
leaving the running process out of step with what the control plane believes.
The deployment report says which path was taken (`mode: hot` or `restart`).

This is what makes issuing a hundred subscriptions a day practical: it is one
API call to Xray, not a hundred restarts.

## Egress probing

The control plane generates one loopback SOCKS inbound per assigned egress,
pinned by a routing rule to that egress alone. The agent sends a probe request
through each of them, so "online" means traffic actually left the gateway by
that path — not merely that a port accepted a TCP connection. When a probe
fails and the egress is an outbound proxy, the agent additionally checks
whether the proxy hop itself is reachable, so the operator can tell "the
upstream proxy is down" from "the upstream proxy is up but has no internet".

## Authentication

Every request is signed:

```
HMAC-SHA256(agentKey, METHOD \n PATH \n TIMESTAMP_MS \n NONCE \n sha256(body))
```

sent as `x-jordan-gateway`, `x-jordan-timestamp`, `x-jordan-nonce` and
`x-jordan-signature`. The control plane rejects timestamps outside the skew
window and any nonce it has already seen, so captured requests cannot be
replayed. The agent key is issued once when the gateway is registered and can
be rotated from the dashboard.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `SYXVPN_URL` | — | Control-plane base URL (required) |
| `SYXVPN_GATEWAY_ID` | — | Gateway id from registration (required) |
| `SYXVPN_AGENT_KEY` | — | Agent key issued at registration (required) |
| `STATE_DIR` | `/var/lib/cvpn-agent` | Where config and last-known-good live |
| `XRAY_BIN` | `xray` | Path to the Xray binary |
| `XRAY_CONFIG_PATH` | `$STATE_DIR/xray.json` | Active configuration file |
| `RELOAD_MODE` | `supervise` | `supervise` (agent runs Xray) or `command` |
| `RELOAD_COMMAND` | `systemctl reload xray` | Used when `RELOAD_MODE=command` |
| `XRAY_API_PORT` | `10085` | Loopback stats/API port |
| `DEFAULT_PROBE_URL` | `http://connectivitycheck.gstatic.com/generate_204` | Fallback probe target |
| `PROBE_VERIFY_TLS` | `true` | Set false only for lab probe targets |

Run once and exit (useful for a systemd `oneshot` or a smoke test):

```sh
npm run once
```
