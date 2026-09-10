#!/bin/sh
# Pull the deployed branch and rebuild the control plane, in place.
#
# Credentials are not this script's business: the host stores them once, in
# root's git credential store, so a deploy is one command with nothing to type.
set -e

REPO=${REPO:-/opt/cvpn}
# A branch name on GitHub, not a product name: this one is a real ref and does
# not get renamed along with everything else.
BRANCH=${BRANCH:-claude/jordan-vpn-control-plane-pq17ik}

# The repository was renamed. GitHub redirects the old URL, so a clone made
# before the rename keeps working — until somebody creates a repository under
# the freed-up old name, at which point the redirect stops and this host starts
# deploying a stranger's code. Correct it once, quietly.
case "$(git -C "$REPO" remote get-url origin)" in
  *jordan-vpn*) git -C "$REPO" remote set-url origin https://github.com/sajjadbabamaleki-lgtm/cvpn ;;
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

# ---------------------------------------------------------------- the rename
# The stack used to be called "jordan", which made its data volume
# jordan_jordan-data and its database /data/jordan.db. Both names are in the
# compose file, so a plain `up -d` would create a new, empty volume, start
# cleanly, and serve a control plane with no customers in it — the old data
# still on disk, and nobody told.
#
# So the move is done here, once, before anything starts. It is safe to run
# again: after the first time there is nothing to find.
OLD_VOL=jordan_jordan-data
NEW_VOL=cvpn_cvpn-data

if docker volume inspect "$OLD_VOL" >/dev/null 2>&1 && ! docker volume inspect "$NEW_VOL" >/dev/null 2>&1; then
  echo "== moving $OLD_VOL to $NEW_VOL"
  # The old containers are still running under the old project name and still
  # hold port 8787. Stopping by project leaves the volumes alone.
  docker compose -p jordan -f deploy/docker-compose.yml down 2>/dev/null || true

  docker volume create "$NEW_VOL" >/dev/null
  docker run --rm -v "$OLD_VOL":/from -v "$NEW_VOL":/to alpine sh -c '
    cp -a /from/. /to/ &&
    # The file is named in DB_PATH, and the -wal and -shm belong to it: leaving
    # them beside a database under another name is how a restore corrupts one.
    for ext in "" -wal -shm; do
      [ -f "/to/jordan.db$ext" ] && mv "/to/jordan.db$ext" "/to/cvpn.db$ext"
    done
    # Written by an older development build; the code still reads it under this
    # name if the new one is absent, but it may as well be moved with the rest.
    [ -f /to/.jordan-secret-key ] && mv /to/.jordan-secret-key /to/.cvpn-secret-key
    ls -la /to
  ' || { echo "FAILED: could not move the data volume; nothing was started and $OLD_VOL is untouched" >&2; exit 1; }
  echo "== moved. $OLD_VOL is left in place until you are satisfied; remove it with:"
  echo "     docker volume rm $OLD_VOL"
fi

$COMPOSE up -d --build
echo 'DEPLOYED'
