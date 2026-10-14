#!/usr/bin/env bash
# Portless as a startup service on :443 (asks for sudo once), its CA trusted,
# and the demo's hostnames mapped. Quiet and quick once done.
set -euo pipefail
cd "$(dirname "$0")/.."
PORTLESS=node_modules/.bin/portless

[ -x "$PORTLESS" ] || { echo "[setup] run pnpm install first" >&2; exit 1; }
if ! "$PORTLESS" doctor 2>/dev/null | grep -q 'Proxy target: https://127.0.0.1:443'; then
  echo "[setup] installing portless on :443 (once; asks for your password)"
  "$PORTLESS" proxy stop >/dev/null 2>&1 || true
  "$PORTLESS" service install
fi
for host in flightsector booking.flightsector ps.acme browserbase.flightsector; do
  "$PORTLESS" alias "$host" 3400 --force >/dev/null
done
"$PORTLESS" hosts sync >/dev/null
