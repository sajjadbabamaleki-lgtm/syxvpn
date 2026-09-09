#!/bin/sh
# Bring up the first gateway on this host, end to end.
#
# Registering a gateway is five API calls, a container, a Caddy block and a
# health check, and getting one of them subtly wrong leaves an app that shows no
# servers and says nothing about why. This does all of it, reports what it did,
# and can be run again safely: an existing gateway for the same host is reused
# rather than duplicated.
#
#   sh deploy/bootstrap-gateway.sh
#
# Environment (all optional):
#   CONTROL_URL   control plane base URL         (default https://control.cvpn.pro)
#   GATEWAY_HOST  the name clients connect to    (default gw1.cvpn.pro)
#   GATEWAY_REGION  free-text region label       (default de)
#   LISTEN_PORT   loopback port Xray binds       (default 10001)
#   CADDYFILE     main Caddy config              (default /etc/caddy/Caddyfile)
#   ADMIN_USERNAME / ADMIN_PASSWORD              (default: read from ./.env)
set -eu

CONTROL_URL=${CONTROL_URL:-https://control.cvpn.pro}
GATEWAY_HOST=${GATEWAY_HOST:-gw1.cvpn.pro}
GATEWAY_REGION=${GATEWAY_REGION:-de}
LISTEN_PORT=${LISTEN_PORT:-10001}
CADDYFILE=${CADDYFILE:-/etc/caddy/Caddyfile}
REPO=$(cd "$(dirname "$0")/.." && pwd)

say() { printf '\n== %s\n' "$1"; }
die() { printf '\nFAILED: %s\n' "$1" >&2; exit 1; }
jget() { python3 -c 'import sys,json;d=json.load(sys.stdin);
for k in sys.argv[1].split("."):
    d = d[int(k)] if isinstance(d, list) else d.get(k)
    if d is None: print(""); raise SystemExit
print(d)' "$1"; }

# ---------------------------------------------------------------- credentials
if [ -z "${ADMIN_PASSWORD:-}" ] && [ -f "$REPO/.env" ]; then
  ADMIN_PASSWORD=$(grep -E '^ADMIN_PASSWORD=' "$REPO/.env" | head -1 | cut -d= -f2-)
fi
if [ -z "${ADMIN_USERNAME:-}" ] && [ -f "$REPO/.env" ]; then
  ADMIN_USERNAME=$(grep -E '^ADMIN_USERNAME=' "$REPO/.env" | head -1 | cut -d= -f2- || true)
fi
ADMIN_USERNAME=${ADMIN_USERNAME:-admin}
[ -n "${ADMIN_PASSWORD:-}" ] || die "no ADMIN_PASSWORD in the environment or $REPO/.env"

say "Signing in to $CONTROL_URL as $ADMIN_USERNAME"
TOKEN=$(printf '{"username":%s,"password":%s}' \
  "$(printf '%s' "$ADMIN_USERNAME" | python3 -c 'import sys,json;print(json.dumps(sys.stdin.read()))')" \
  "$(printf '%s' "$ADMIN_PASSWORD" | python3 -c 'import sys,json;print(json.dumps(sys.stdin.read()))')" \
  | curl -sS -X POST "$CONTROL_URL/api/v1/auth/login" -H 'Content-Type: application/json' -d @- \
  | jget data.token)
[ -n "$TOKEN" ] || die "admin login failed — check ADMIN_PASSWORD"
AUTH="Authorization: Bearer $TOKEN"
echo "signed in"

# ------------------------------------------------------------------- gateway
say "Looking for an existing gateway on $GATEWAY_HOST"
GW=$(curl -sS "$CONTROL_URL/api/v1/gateways" -H "$AUTH" \
  | python3 -c 'import sys,json;host=sys.argv[1]
rows=json.load(sys.stdin).get("data") or []
print(next((g["id"] for g in rows if g.get("host")==host), ""))' "$GATEWAY_HOST")

if [ -n "$GW" ]; then
  WS_PATH=$(curl -sS "$CONTROL_URL/api/v1/gateways/$GW" -H "$AUTH" | jget data.wsPath)
  echo "reusing $GW (wsPath $WS_PATH)"
else
  WS_PATH="/$(head -c 8 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  say "Registering $GATEWAY_HOST with wsPath $WS_PATH"
  RESP=$(printf '{"name":"gw1","region":"%s","host":"%s","port":443,"tlsMode":"reverse-proxy","sni":"%s","wsPath":"%s","listenAddress":"127.0.0.1","listenPort":%s}' \
    "$GATEWAY_REGION" "$GATEWAY_HOST" "$GATEWAY_HOST" "$WS_PATH" "$LISTEN_PORT" \
    | curl -sS -X POST "$CONTROL_URL/api/v1/gateways" -H "$AUTH" -H 'Content-Type: application/json' -d @-)
  GW=$(printf '%s' "$RESP" | jget data.id)
  [ -n "$GW" ] || die "registration failed: $RESP"
  echo "registered $GW"
fi

# ---------------------------------------------------------------------- egress
# A gateway with no egress assigned is not merely unrouted, it is invisible:
# routeState() answers "no-egress" and the subscription drops the gateway, so
# the app shows an empty config list and a switch with nothing to connect to.
say "Making sure the gateway has an egress"
HAS_EGRESS=$(curl -sS "$CONTROL_URL/api/v1/gateways/$GW" -H "$AUTH" \
  | python3 -c 'import sys,json;d=(json.load(sys.stdin).get("data") or {});print("yes" if d.get("activeEgressId") else "")')
if [ -n "$HAS_EGRESS" ]; then
  echo "already assigned"
else
  EG=$(curl -sS "$CONTROL_URL/api/v1/egresses" -H "$AUTH" \
    | python3 -c 'import sys,json;rows=json.load(sys.stdin).get("data") or []
print(next((e["id"] for e in rows if e.get("kind")=="direct"), ""))')
  if [ -z "$EG" ]; then
    EG=$(printf '{"name":"direct","region":"%s","kind":"direct","probeUrl":"http://connectivitycheck.gstatic.com/generate_204"}' "$GATEWAY_REGION" \
      | curl -sS -X POST "$CONTROL_URL/api/v1/egresses" -H "$AUTH" -H 'Content-Type: application/json' -d @- \
      | jget data.id)
    [ -n "$EG" ] || die "could not create a direct egress"
  fi
  printf '{"egressId":"%s","priority":100}' "$EG" \
    | curl -sS -X POST "$CONTROL_URL/api/v1/gateways/$GW/egresses" -H "$AUTH" \
      -H 'Content-Type: application/json' -d @- >/dev/null || die "could not assign the egress"
  echo "assigned $EG"
fi

say "Issuing an agent key (the previous one stops working)"
AGENT_KEY=$(curl -sS -X POST "$CONTROL_URL/api/v1/gateways/$GW/agent-key" -H "$AUTH" | jget data.agentKey)
[ -n "$AGENT_KEY" ] || die "could not issue an agent key"
echo "issued"

# --------------------------------------------------------------------- agent
say "Building the agent image (it carries the Xray binary)"
docker build -t jordan-agent "$REPO/agent" >/dev/null || die "agent image build failed"

say "Starting the agent"
docker rm -f jordan-agent >/dev/null 2>&1 || true
ENV_FILE=/etc/jordan-agent.env
# The umask is scoped to this file. Left set for the rest of the script it also
# made the Caddy block root-only, which validate (run as root) accepted and the
# caddy user could not read — a reload failure that looked like a bad config.
(umask 077; cat > "$ENV_FILE" <<ENV
JORDAN_URL=$CONTROL_URL
JORDAN_GATEWAY_ID=$GW
JORDAN_AGENT_KEY=$AGENT_KEY
ENV
)
docker run -d --name jordan-agent --restart unless-stopped --network host \
  --env-file "$ENV_FILE" -v jordan-agent-state:/var/lib/jordan-agent jordan-agent >/dev/null \
  || die "the agent container did not start"
echo "running — key is in $ENV_FILE (root only)"

# --------------------------------------------------------------------- caddy
BLOCK=/etc/caddy/cvpn-gw1.caddy
say "Writing the gateway's Caddy block to $BLOCK"
cat > "$BLOCK" <<CADDY
# Generated by deploy/bootstrap-gateway.sh. The path must match the gateway's
# registered wsPath; anything else on this name looks like an ordinary site.
$GATEWAY_HOST {
	@ws {
		path $WS_PATH
		header Connection *Upgrade*
		header Upgrade websocket
	}
	# The proxy goes inside a handle: Caddy sorts handle before reverse_proxy,
	# so a catch-all handle beside a bare reverse_proxy answers everything first
	# and the upgrade never reaches Xray — a 404 that looks like a wrong path.
	handle @ws {
		reverse_proxy 127.0.0.1:$LISTEN_PORT
	}
	handle {
		respond "" 404
	}
}
CADDY
# Caddy drops privileges: a block it cannot read is a block that does not exist.
chmod 644 "$BLOCK"

if [ -f "$CADDYFILE" ]; then
  if grep -q "$BLOCK" "$CADDYFILE"; then
    echo "already imported"
  else
    BACKUP="$CADDYFILE.bak.$(date +%s)"
    cp "$CADDYFILE" "$BACKUP"
    printf '\nimport %s\n' "$BLOCK" >> "$CADDYFILE"
    if caddy validate --config "$CADDYFILE" >/dev/null 2>&1 && systemctl reload caddy; then
      echo "imported and reloaded"
    else
      # Named rather than globbed: a second run must not restore a stale backup.
      cp "$BACKUP" "$CADDYFILE"
      systemctl reload caddy >/dev/null 2>&1 || true
      die "Caddy would not take the new config; $CADDYFILE is back as it was.
Read why with: journalctl -xeu caddy.service --no-pager | tail -30"
    fi
  fi
else
  echo "no $CADDYFILE — add the block in $BLOCK to your proxy by hand, then re-run"
fi

# -------------------------------------------------------------------- verdict
say "Waiting for the agent to deploy its configuration"
sleep 20
say "Health check"
curl -sS -X POST "$CONTROL_URL/api/v1/gateways/$GW/check" -H "$AUTH"; echo

cat <<NEXT

Gateway id: $GW
wsPath:     $WS_PATH

If the check above says "online", the gateway is live. In the app: Premium ->
pick the plan -> then settle the order:

  curl -sS $CONTROL_URL/api/v1/orders -H "Authorization: Bearer \$TOKEN"
  curl -sS -X POST $CONTROL_URL/api/v1/orders/<ORDER_ID>/settle \\
    -H "Authorization: Bearer \$TOKEN" -H 'Content-Type: application/json' -d '{"note":"manual"}'

If it says "offline", read the agent's own account of why:

  docker logs --tail 50 jordan-agent
NEXT
