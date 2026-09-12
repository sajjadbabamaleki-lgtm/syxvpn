#!/bin/sh
# Pull the deployed branch and rebuild the control plane, in place.
#
# Credentials are not this script's business: the host stores them once, in
# root's git credential store, so a deploy is one command with nothing to type.
set -e

REPO=${REPO:-/opt/cvpn}
# A branch name on GitHub, not a product name: this one is a real ref and does
# not get renamed along with everything else.
BRANCH=${BRANCH:-claude/app-theme-material-sync-a8y48j}

# The repository has been renamed twice: jordan-vpn, then cvpn, now syxvpn.
# GitHub redirects an old URL, so a clone made before a rename keeps working —
# until somebody creates a repository under the freed-up old name, at which
# point the redirect stops and this host starts deploying a stranger's code.
# Both freed names are corrected, once, quietly.
case "$(git -C "$REPO" remote get-url origin)" in
  *jordan-vpn*|*/cvpn|*/cvpn.git)
    git -C "$REPO" remote set-url origin https://github.com/sajjadbabamaleki-lgtm/syxvpn ;;
esac

git -C "$REPO" fetch origin "$BRANCH"
git -C "$REPO" reset --hard "origin/$BRANCH"

cd "$REPO"

# The database snapshots land on the host, not in the data volume — a backup
# that dies with the thing it was protecting is not one. Docker would create
# this bind mount as root, and the API runs as uid 1000 inside its container, so
# it has to exist with the right owner before the container starts or every
# snapshot fails with EACCES.
BACKUPS=${BACKUP_HOST_DIR:-$REPO/backups}
mkdir -p "$BACKUPS"
# It holds every agent key, every REALITY private key and the sealed copy of
# every subscription token. Nobody but root and the API reads it.
chmod 700 "$BACKUPS"
chown 1000:1000 "$BACKUPS"

COMPOSE="docker compose --env-file .env -f deploy/docker-compose.yml"

$COMPOSE up -d --build

# --------------------------------------------------------------- did it work?
# `up -d` returns once the containers have been *started*, which is not the same
# as serving. It returned cleanly once while the site was down, printed DEPLOYED
# over the top of an outage, and the first anybody knew of it was a person
# opening the page — so the script now waits for both halves to actually answer
# and, when one does not, says which and shows its log.
#
# The gateway agent is not checked here: it runs on the gateway hosts, and on
# this one it is a separate container this script does not own.
serving() {
  name=$1
  url=$2
  waited=0
  code=000
  while [ "$waited" -lt 90 ]; do
    # curl prints 000 itself when it cannot connect, so the fallback is only
    # for curl dying before it writes anything -- appending another 000 to the
    # one curl wrote is how the message ends up reading "HTTP 000000".
    code=$(curl -s -o /dev/null -m 3 -w '%{http_code}' "$url" 2>/dev/null || true)
    [ -n "$code" ] || code=000
    if [ "$code" = 200 ]; then
      echo "== $name is serving"
      return 0
    fi
    sleep 2
    waited=$((waited + 2))
  done
  echo "FAILED: $name did not answer on $url within ${waited}s (last: HTTP $code)" >&2
  return 1
}

# Readiness, not liveness: it is the check that opens the database, so a control
# plane that started with an unreadable volume fails here rather than later.
if serving api http://127.0.0.1:8787/readiness && serving web http://127.0.0.1:8080/; then
  echo 'DEPLOYED'
else
  echo '--- containers -------------------------------------------------' >&2
  $COMPOSE ps >&2
  echo '--- logs -------------------------------------------------------' >&2
  $COMPOSE logs --tail 40 >&2
  exit 1
fi
