#!/usr/bin/env bash
# The app on :3400, with its booking provider on a public https URL through
# Cloudflare, so a hosted Introspection's egress and Person Server can reach it.
#
#   pnpm dev:public
#       A quick tunnel: a new https://*.trycloudflare.com each run, no account.
#   FLIGHTSECTOR_DOMAIN=example.dev pnpm dev:public
#       A named tunnel at booking.flightsector.example.dev, the same every run.
#       Once first: `cloudflared tunnel login`, picking that domain's zone.
#
# With PERSON_SERVER=acme (in the environment or .env.local), Acme runs its own
# Person Server here, so it gets a public URL too: ps.flightsector.<domain>, or
# a second quick tunnel.
#
# The URL goes to .env.local as BOOKING_ISSUER. Once `introspection:setup` has
# run, the booking connector is pointed at it too, so a new quick-tunnel URL
# needs nothing else.
set -euo pipefail
cd "$(dirname "$0")/.."
PORT=3400
ENV_FILE=.env.local

command -v cloudflared >/dev/null 2>&1 || {
  echo "[dev:public] install cloudflared first: brew install cloudflared" >&2
  exit 1
}

upsert_env() {
  touch "$ENV_FILE"
  if grep -q "^$1=" "$ENV_FILE"; then
    local escaped
    escaped="$(printf '%s' "$2" | sed 's/[&|\\]/\\&/g')"
    sed -i.bak "s|^$1=.*|$1=$escaped|" "$ENV_FILE" && rm -f "$ENV_FILE.bak"
  else
    printf '%s=%s\n' "$1" "$2" >>"$ENV_FILE"
  fi
}

read_env() {
  if [ -f "$ENV_FILE" ]; then
    awk -F= -v key="$1" '$1 == key { sub(/^[^=]*=/, ""); print; exit }' "$ENV_FILE"
  fi
}

MODE="${PERSON_SERVER:-$(read_env PERSON_SERVER)}"
PIDS=()
trap 'kill "${PIDS[@]}" 2>/dev/null || true' EXIT

# A quick tunnel to the app, its URL set in the variable named $1 once
# Cloudflare assigns it. Not run in a subshell, so its pid reaches the trap.
quick_tunnel() {
  local log url=""
  log="$(mktemp -t flightsector-tunnel)"
  cloudflared tunnel --no-autoupdate --url "http://localhost:$PORT" >"$log" 2>&1 &
  PIDS+=($!)
  for _ in $(seq 60); do
    url="$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$log" | head -1 || true)"
    [ -n "$url" ] && break
    sleep 1
  done
  [ -n "$url" ] || {
    echo "[dev:public] the tunnel did not start; its log: $log" >&2
    exit 1
  }
  printf -v "$1" '%s' "$url"
}

if [ -n "${FLIGHTSECTOR_DOMAIN:-}" ]; then
  NAME="${FLIGHTSECTOR_TUNNEL:-flightsector}"
  cloudflared tunnel info "$NAME" >/dev/null 2>&1 || cloudflared tunnel create "$NAME" >/dev/null
  BOOKING="https://booking.flightsector.${FLIGHTSECTOR_DOMAIN}"
  cloudflared tunnel route dns --overwrite-dns "$NAME" "${BOOKING#https://}" >/dev/null
  if [ "$MODE" = acme ]; then
    ACME="https://ps.flightsector.${FLIGHTSECTOR_DOMAIN}"
    cloudflared tunnel route dns --overwrite-dns "$NAME" "${ACME#https://}" >/dev/null
  fi
  # --url sends every hostname routed to the tunnel to the app, which tells
  # the parties apart by host.
  cloudflared tunnel --no-autoupdate run --url "http://localhost:$PORT" "$NAME" >"$(mktemp -t flightsector-tunnel)" 2>&1 &
  PIDS+=($!)
else
  quick_tunnel BOOKING
  if [ "$MODE" = acme ]; then quick_tunnel ACME; fi
fi

if [ "$MODE" = acme ]; then
  upsert_env ACME_PERSON_SERVER_URL "$ACME"
  export ACME_PERSON_SERVER_URL="$ACME"
  echo "[dev:public] Acme's Person Server: $ACME"
fi
upsert_env BOOKING_ISSUER "$BOOKING"
upsert_env APP_URL "http://localhost:$PORT"
echo "[dev:public] booking provider: $BOOKING"

# Set up already: point the booking connector at these URLs.
if [ -n "$(read_env INTROSPECTION_RUNTIME)" ]; then
  scripts/introspection-setup.sh connector
fi

echo "[dev:public] demo: http://localhost:$PORT/demo"
CA="$HOME/.portless/ca.pem"
if [ -z "${NODE_EXTRA_CA_CERTS:-}" ] && [ -f "$CA" ]; then
  export NODE_EXTRA_CA_CERTS="$CA"
fi
BOOKING_ISSUER="$BOOKING" APP_URL="http://localhost:$PORT" node_modules/.bin/next dev --turbopack --port "$PORT"
