#!/usr/bin/env bash
# One-time setup for the stack the `introspection` CLI is logged in to.
# Local: portless as a startup service on :443 (asks for sudo once), its CA
# trusted, and the demo's hostnames in /etc/hosts. Safe to re-run.
set -euo pipefail
cd "$(dirname "$0")/.."
PORTLESS=node_modules/.bin/portless

command -v introspection >/dev/null 2>&1 || { echo "[setup] install the introspection CLI and run: introspection login" >&2; exit 1; }
CP_URL="$(introspection whoami 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const w=JSON.parse(s);console.log(w.logged_in?w.cp_url:"")}catch{}})')"
[ -n "$CP_URL" ] || { echo "[setup] run: introspection login" >&2; exit 1; }
echo "[setup] introspection CLI targets $CP_URL"

case "$CP_URL" in
  http://localhost*|http://127.0.0.1*) ;;
  *)
    echo "[setup] remote stack: the booking provider and Acme's pages must be publicly hosted; nothing to do locally"
    exit 0
    ;;
esac

[ -x "$PORTLESS" ] || { echo "[setup] run pnpm install first" >&2; exit 1; }
if "$PORTLESS" doctor 2>/dev/null | grep -q 'Proxy target: https://127.0.0.1:443'; then
  echo "[setup] portless already serving :443"
else
  "$PORTLESS" proxy stop >/dev/null 2>&1 || true
  "$PORTLESS" service install
fi
"$PORTLESS" hosts sync
"$PORTLESS" doctor
cat <<'NEXT'

[setup] next, in introspection-cloud:
  make dev-aauth-demo            # then restart make dev
  make seed-applications seed-travel-agent
  make seed-aauth-demo
and here: pnpm dev, then open https://flightsector.localhost/demo
NEXT
