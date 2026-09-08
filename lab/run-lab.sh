#!/usr/bin/env bash
#
# Runs the Jordan blackout lab end to end and tears it down afterwards.
# Requires docker (with compose v2) and node 22+.
set -euo pipefail

cd "$(dirname "$0")"

export LAB_ADMIN_PASSWORD="${LAB_ADMIN_PASSWORD:-lab-admin-password}"
export LAB_SECRET_KEY="${LAB_SECRET_KEY:-lab-secret-key-not-for-production}"
# Placeholders so compose can parse the file before the gateway is registered.
export LAB_GATEWAY_ID="${LAB_GATEWAY_ID:-pending}"
export LAB_AGENT_KEY="${LAB_AGENT_KEY:-pending}"

KEEP="${KEEP_LAB:-0}"

cleanup() {
  if [ "$KEEP" = "1" ]; then
    echo "lab left running (KEEP_LAB=1). Tear it down with: docker compose -f lab/docker-compose.yml down -v"
    return
  fi
  echo "· tearing down the lab"
  docker compose -f docker-compose.yml down -v --remove-orphans >/dev/null 2>&1 || true
  rm -f state/client.json
}
trap cleanup EXIT

node lab.mjs
