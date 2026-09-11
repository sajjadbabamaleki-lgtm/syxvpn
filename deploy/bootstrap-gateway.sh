#!/bin/sh
# Bring up the first gateway on this host, end to end.
#
# Registering a gateway is five API calls, a container, a Caddy block and a
# health check, and getting one of them subtly wrong leaves an app that shows no
# servers and says nothing about why. This does all of it, reports what it did,
# and can be run again safely: an existing gateway for the same host is reused
# rather than duplicated.
#
# On the control-plane host it needs nothing: the admin password comes from the
# .env beside it. On a machine that is only a gateway — which is where a gateway
# belongs, away from the control plane and its address — clone the repository
# and pass the two things that host cannot know:
#
#   CONTROL_URL=https://control.sixvpn.pro \
#   GATEWAY_HOST=203.0.113.9 GATEWAY_REGION=nl \
#   ADMIN_PASSWORD=… sh deploy/bootstrap-gateway.sh
#
# There are two kinds of gateway, and the difference decides most of what
# follows:
#
#   reality (default)  Xray owns port 443 and borrows a real site's TLS
#                      handshake. No domain, no certificate, no Caddy, nothing
#                      to point at this machine — a bare IP address is enough,
#                      and a censor probing it is answered by www.microsoft.com.
#   ws                 VLESS over WebSocket behind Caddy, which needs a name
#                      pointed here and a certificate issued for it.
#
# Environment (all optional):
#   CONTROL_URL   control plane base URL         (default https://control.sixvpn.pro)
#   GATEWAY_HOST  the address clients dial       (default gw1.sixvpn.pro)
#   GATEWAY_REGION  free-text region label       (default de)
#   TRANSPORT     reality | ws                   (default reality)
#   REALITY_DEST  the site whose TLS is borrowed (default www.microsoft.com:443)
#   PUBLIC_PORT   port clients dial              (default 443)
#   LISTEN_PORT   ws only: loopback port Xray binds  (default 10001)
#   CADDYFILE     ws only: main Caddy config     (default /etc/caddy/Caddyfile)
#   ADMIN_USERNAME / ADMIN_PASSWORD              (default: read from ./.env)
set -eu

CONTROL_URL=${CONTROL_URL:-https://control.sixvpn.pro}
GATEWAY_HOST=${GATEWAY_HOST:-gw1.sixvpn.pro}
GATEWAY_REGION=${GATEWAY_REGION:-de}
TRANSPORT=${TRANSPORT:-reality}
REALITY_DEST=${REALITY_DEST:-www.microsoft.com:443}
PUBLIC_PORT=${PUBLIC_PORT:-443}
LISTEN_PORT=${LISTEN_PORT:-10001}
CADDYFILE=${CADDYFILE:-/etc/caddy/Caddyfile}
REPO=$(cd "$(dirname "$0")/.." && pwd)

case "$TRANSPORT" in
  reality|ws) ;;
  *) printf 'TRANSPORT must be reality or ws, not %s\n' "$TRANSPORT" >&2; exit 1 ;;
esac

# Everything this run owns is named after the host's first label — gw2.sixvpn.pro
# gives gw2 — so a second gateway, on a second machine or behind the same
# proxy, cannot overwrite the first one's container, key file or Caddy block.
LABEL=$(printf '%s' "$GATEWAY_HOST" | cut -d. -f1)
GATEWAY_NAME=${GATEWAY_NAME:-$LABEL}

say() { printf '\n== %s\n' "$1"; }
have() { command -v "$1" >/dev/null 2>&1; }
die() { printf '\nFAILED: %s\n' "$1" >&2; exit 1; }
jget() { python3 -c 'import sys,json;d=json.load(sys.stdin);
for k in sys.argv[1].split("."):
    d = d[int(k)] if isinstance(d, list) else d.get(k)
    if d is None: print(""); raise SystemExit
print(d)' "$1"; }

# ------------------------------------------------------------------ preflight
# Said now, by name, rather than as a build or a reload failing later.
have docker || die "docker is not installed on this host"
have python3 || die "python3 is not installed on this host"
have curl || die "curl is not installed on this host"
if [ "$TRANSPORT" = ws ]; then
  have caddy || say "WARNING: no caddy on this host — the block will be written but not loaded"
else
  # REALITY needs the public port itself, and something already holding it is
  # the one failure that looks like a broken gateway rather than a busy port.
  if have ss && ss -ltn "( sport = :$PUBLIC_PORT )" 2>/dev/null | grep -q LISTEN; then
    die "something is already listening on port $PUBLIC_PORT.
A REALITY gateway is the public listener — nothing may sit in front of it.
Stop what is on $PUBLIC_PORT (often caddy or nginx), or pass PUBLIC_PORT=… to
use another port, and run this again."
  fi
fi

# ---------------------------------------------------------------- credentials
if [ -z "${ADMIN_PASSWORD:-}" ] && [ -f "$REPO/.env" ]; then
  ADMIN_PASSWORD=$(grep -E '^ADMIN_PASSWORD=' "$REPO/.env" | head -1 | cut -d= -f2-)
fi
if [ -z "${ADMIN_USERNAME:-}" ] && [ -f "$REPO/.env" ]; then
  ADMIN_USERNAME=$(grep -E '^ADMIN_USERNAME=' "$REPO/.env" | head -1 | cut -d= -f2- || true)
fi
ADMIN_USERNAME=${ADMIN_USERNAME:-admin}
[ -n "${ADMIN_PASSWORD:-}" ] || die "no ADMIN_PASSWORD in the environment or $REPO/.env
On a gateway-only host there is no .env: pass ADMIN_PASSWORD=… to this script."

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

WS_PATH=""
if [ -n "$GW" ]; then
  # The registration decides the transport, not this run's default: re-running
  # on an existing WebSocket gateway must not silently take Caddy out from
  # under it, or the other way round.
  TRANSPORT=$(curl -sS "$CONTROL_URL/api/v1/gateways/$GW" -H "$AUTH" | jget data.transport)
  [ "$TRANSPORT" = reality ] || WS_PATH=$(curl -sS "$CONTROL_URL/api/v1/gateways/$GW" -H "$AUTH" | jget data.wsPath)
  echo "reusing $GW ($TRANSPORT${WS_PATH:+, wsPath $WS_PATH})"
elif [ "$TRANSPORT" = reality ]; then
  say "Registering $GATEWAY_HOST as a REALITY gateway borrowing $REALITY_DEST"
  RESP=$(printf '{"name":"%s","region":"%s","host":"%s","port":%s,"transport":"reality","tlsMode":"none","realityDest":"%s"}' \
    "$GATEWAY_NAME" "$GATEWAY_REGION" "$GATEWAY_HOST" "$PUBLIC_PORT" "$REALITY_DEST" \
    | curl -sS -X POST "$CONTROL_URL/api/v1/gateways" -H "$AUTH" -H 'Content-Type: application/json' -d @-)
  GW=$(printf '%s' "$RESP" | jget data.id)
  [ -n "$GW" ] || die "registration failed: $RESP"
  echo "registered $GW — the key pair and short IDs were issued by the control plane"
else
  WS_PATH="/$(head -c 8 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  say "Registering $GATEWAY_HOST with wsPath $WS_PATH"
  RESP=$(printf '{"name":"%s","region":"%s","host":"%s","port":%s,"transport":"ws","tlsMode":"reverse-proxy","sni":"%s","wsPath":"%s","listenAddress":"127.0.0.1","listenPort":%s}' \
    "$GATEWAY_NAME" "$GATEWAY_REGION" "$GATEWAY_HOST" "$PUBLIC_PORT" "$GATEWAY_HOST" "$WS_PATH" "$LISTEN_PORT" \
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
docker build -t cvpn-agent "$REPO/agent" >/dev/null || die "agent image build failed"

say "Starting the agent"
CONTAINER=cvpn-agent-$GATEWAY_NAME
docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
# The container this replaces, from before the rename. It runs on the host
# network and would still be talking to the control plane beside its
# replacement, reporting health for the same gateway from two processes.
docker rm -f "jordan-agent-$GATEWAY_NAME" >/dev/null 2>&1 || true
ENV_FILE=/etc/cvpn-agent-$GATEWAY_NAME.env
# The umask is scoped to this file. Left set for the rest of the script it also
# made the Caddy block root-only, which validate (run as root) accepted and the
# caddy user could not read — a reload failure that looked like a bad config.
(umask 077; cat > "$ENV_FILE" <<ENV
SIXVPN_URL=$CONTROL_URL
SIXVPN_GATEWAY_ID=$GW
SIXVPN_AGENT_KEY=$AGENT_KEY
ENV
)
docker run -d --name "$CONTAINER" --restart unless-stopped --network host \
  --env-file "$ENV_FILE" -v "cvpn-agent-$GATEWAY_NAME:/var/lib/cvpn-agent" cvpn-agent >/dev/null \
  || die "the agent container did not start"
echo "running — key is in $ENV_FILE (root only)"

# --------------------------------------------------------------------- caddy
# Only a WebSocket gateway has anything in front of it. A REALITY gateway is
# the public listener itself: the handshake it forwards to the borrowed site
# has to come from the real socket, so a proxy in the path would break the one
# thing REALITY is for.
configure_reverse_proxy() {
BLOCK=/etc/caddy/sixvpn-$GATEWAY_NAME.caddy
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

# A gateway-only host has no Caddyfile at all. A file holding just this import
# is a complete config, so the same command works on both kinds of machine.
if [ ! -f "$CADDYFILE" ] && have caddy; then
  say "No $CADDYFILE on this host — creating one that imports the block"
  mkdir -p "$(dirname "$CADDYFILE")"
  printf 'import %s\n' "$BLOCK" > "$CADDYFILE"
  if caddy validate --config "$CADDYFILE" >/dev/null 2>&1 && systemctl reload caddy 2>/dev/null; then
    echo "created and loaded"
  else
    systemctl restart caddy >/dev/null 2>&1 \
      && echo "created and started" \
      || die "Caddy would not start with $CADDYFILE.
Read why with: journalctl -xeu caddy.service --no-pager | tail -30"
  fi
elif [ -f "$CADDYFILE" ]; then
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
  echo "no caddy here — put $BLOCK in front of $LISTEN_PORT yourself, then re-run"
fi
}

if [ "$TRANSPORT" = reality ]; then
  say "No reverse proxy: a REALITY gateway is the public listener"
  echo "nothing to write — Xray owns $GATEWAY_HOST:$PUBLIC_PORT"
else
  configure_reverse_proxy
fi

# -------------------------------------------------------------------- verdict
say "Waiting for the agent to deploy its configuration"
sleep 20
if [ "$TRANSPORT" = reality ]; then
  REALITY_LINE="
Borrowed:   $REALITY_DEST — this is the certificate a prober gets back"
fi

say "Health check"
curl -sS -X POST "$CONTROL_URL/api/v1/gateways/$GW/check" -H "$AUTH"; echo

cat <<NEXT

Gateway id: $GW
Transport:  $TRANSPORT${WS_PATH:+
wsPath:     $WS_PATH}${REALITY_LINE:-}

If the check above says "online", the gateway is live. In the app: Premium ->
pick the plan -> then settle the order:

  curl -sS $CONTROL_URL/api/v1/orders -H "Authorization: Bearer \$TOKEN"
  curl -sS -X POST $CONTROL_URL/api/v1/orders/<ORDER_ID>/settle \\
    -H "Authorization: Bearer \$TOKEN" -H 'Content-Type: application/json' -d '{"note":"manual"}'

If it says "offline", read the agent's own account of why:

  docker logs --tail 50 $CONTAINER
NEXT
