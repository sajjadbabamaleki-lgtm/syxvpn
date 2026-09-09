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
docker compose --env-file .env -f deploy/docker-compose.yml up -d --build
echo 'DEPLOYED'
