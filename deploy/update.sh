#!/bin/sh
# Pull the deployed branch and rebuild the control plane, in place.
#
# This host deliberately stores no GitHub credentials: the repository is
# private, and a token written into .git/config or a credential store is a
# token that outlives the person who pasted it. So it is typed in each run and
# never reaches the disk.
set -e

REPO=${REPO:-/opt/cvpn}
BRANCH=${BRANCH:-claude/jordan-vpn-control-plane-pq17ik}
ORIGIN=${ORIGIN:-github.com/sajjadbabamaleki-lgtm/jordan-vpn.git}

printf 'GitHub token: '
stty -echo 2>/dev/null || true
read -r TOKEN
stty echo 2>/dev/null || true
printf '\n'

git -C "$REPO" fetch "https://x-access-token:$TOKEN@$ORIGIN" "$BRANCH"
TOKEN=
git -C "$REPO" reset --hard FETCH_HEAD

cd "$REPO"
docker compose --env-file .env -f deploy/docker-compose.yml up -d --build
echo 'DEPLOYED'
