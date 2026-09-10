#!/bin/sh
# Pull the deployed branch and rebuild the control plane, in place.
#
# Credentials are not this script's business: the host stores them once, in
# root's git credential store, so a deploy is one command with nothing to type.
set -e

REPO=${REPO:-/opt/cvpn}
BRANCH=${BRANCH:-claude/jordan-vpn-control-plane-pq17ik}

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

docker compose --env-file .env -f deploy/docker-compose.yml up -d --build
echo 'DEPLOYED'
