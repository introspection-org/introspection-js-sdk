#!/usr/bin/env bash
# The whole flow with no platform: a dev server that trusts the e2e script's
# Agent Provider, then scripts/e2e-aauth.mjs playing the agent against it.
set -euo pipefail
cd "$(dirname "$0")/.."

if lsof -nP -iTCP:3400 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "[e2e] stop the dev server on :3400 first; this starts its own" >&2
  exit 1
fi
scripts/setup.sh
node_modules/.bin/portless alias e2e-agents 3499 --force >/dev/null

export NODE_EXTRA_CA_CERTS="${NODE_EXTRA_CA_CERTS:-$HOME/.portless/ca.pem}"
export E2E_SERVER_LOG="$(mktemp -t aauth-travel)"
TRUSTED_AGENT_PROVIDERS="${TRUSTED_AGENT_PROVIDERS:-https://cp.introspection.localhost},https://e2e-agents.localhost" \
  node_modules/.bin/next dev --turbopack --port 3400 > "$E2E_SERVER_LOG" 2>&1 &
SERVER=$!
trap 'kill $SERVER 2>/dev/null; rm -f "$E2E_SERVER_LOG"' EXIT

for _ in $(seq 120); do
  curl -sf -o /dev/null https://flightsector.localhost/ && break
  sleep 0.5
done
node scripts/e2e-aauth.mjs
