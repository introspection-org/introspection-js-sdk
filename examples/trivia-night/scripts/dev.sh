#!/usr/bin/env bash
# `pnpm dev`: the Trivia Night page on :3500, the question bank on its own
# loopback port with only its MCP server on a public https URL, and your
# Introspection project set up to call it. The page and /api/* are never public.
#
# Which Introspection it connects to is whichever stack `introspection login`
# chose: staging, production, or your own. Not logged in, the app runs alone.
#
# The public URL is a free Cloudflare quick tunnel (`brew install cloudflared`),
# new each run; the project follows it.
#
# The project setup, the first time on a stack (safe to re-run), in the trivia project:
#   1. the trivia-night Runtime, from this repository's .introspection/trivia-night.yaml
#   2. the page's `spa` application; off production, .env.local names the stack
#      and that application, the page's only settings
#   3. the application the bank is linked to: the platform signs a token
#      naming the end user, as that application, on every call to the bank
#   4. the trivia-bank MCP binding, on the tunnel, linked to that application
# Later runs only point the binding at the new tunnel URL.
#
# Env:
#   TRIVIA_NO_SETUP=1  serve the app and its tunnel only: no CLI, and nothing in
#                      the project changes
set -euo pipefail
cd "$(dirname "$0")/.."

PORT=3500
BANK_PORT=3501
ENV_FILE=.env.local
RUNTIME=trivia-night
# The project the page signs in to, beside its runtime and the bank's binding.
PROJECT=trivia
PRODUCTION=https://api.introspection.dev
MCP_SERVER_ID=trivia-bank
APP_NAME="Trivia Night bank"
SPA_NAME="Trivia night"

say() { echo "[dev] $*"; }
fail() {
  echo "[dev] $*" >&2
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

remove_env() {
  [ -f "$ENV_FILE" ] || return 0
  sed -i.bak "/^$1=/d" "$ENV_FILE" && rm -f "$ENV_FILE.bak"
}

# `json EXPR`: evaluate EXPR against the JSON on stdin (as `v`) and print it.
json() {
  node -e '
    let s = "";
    process.stdin.on("data", (d) => (s += d)).on("end", () => {
      const v = JSON.parse(s);
      const r = new Function("v", "return " + process.argv[1])(v);
      if (r !== undefined && r !== null) console.log(typeof r === "string" ? r : JSON.stringify(r));
    });
  ' "$1"
}

# The bank trusts only the platform's token here: a header naming the owner
# would let anyone on the tunnel play as any venue.
unset TRIVIA_DEV_OWNER_HEADER TRIVIA_DEV_OWNER
# What earlier versions wrote: the page now reads only its stack and application,
# and the bank's issuer is handed to it below.
for name in TRIVIA_DEV_OWNER_HEADER TRIVIA_DEV_OWNER TRIVIA_ISSUER TRIVIA_AUDIENCE \
  NEXT_PUBLIC_INTROSPECTION_DP_URL NEXT_PUBLIC_INTROSPECTION_TRIVIA_PROJECT \
  NEXT_PUBLIC_INTROSPECTION_TRIVIA_RUNTIME_ID NEXT_PUBLIC_INTROSPECTION_TRIVIA_REPOSITORY_ID \
  NEXT_PUBLIC_INTROSPECTION_TRIVIA_COMMIT_SHA NEXT_PUBLIC_INTROSPECTION_TRIVIA_RECIPE_PATH; do
  remove_env "$name"
done

# ---------------------------------------------------------------------------
# The Introspection CLI, installed or brought up to date, and a live session
# ---------------------------------------------------------------------------

if [ -z "${TRIVIA_NO_SETUP:-}" ]; then
  if command -v introspection >/dev/null 2>&1; then
    introspection upgrade --yes --non-interactive >/dev/null 2>&1 ||
      say "could not upgrade the introspection CLI; carrying on with $(introspection --version)"
  else
    say "installing the introspection CLI"
    pnpm add -g @introspection-ai/cli >/dev/null ||
      fail "could not install it: run \`pnpm setup\` once, then \`pnpm add -g @introspection-ai/cli\`"
  fi
  say "$(introspection --version)"
  # `whoami` reads the stored credentials, so an expired session still reads
  # as logged in: ask for something instead.
  if ! introspection runtimes list -o json >/dev/null 2>&1; then
    say "your Introspection session does not answer; signing in"
    introspection login || fail "could not sign in: run \`introspection login\`, then pnpm dev"
  fi
fi

# ---------------------------------------------------------------------------
# The public URL
# ---------------------------------------------------------------------------

command -v cloudflared >/dev/null 2>&1 || fail "install cloudflared first: brew install cloudflared"

PIDS=()
trap 'kill "${PIDS[@]}" 2>/dev/null || true' EXIT

TUNNEL_LOG="$(mktemp "${TMPDIR:-/tmp}/trivia-tunnel.XXXXXX")"
cloudflared tunnel --no-autoupdate --url "http://127.0.0.1:$BANK_PORT" >"$TUNNEL_LOG" 2>&1 &
PIDS+=($!)
TUNNEL=""
for _ in $(seq 60); do
  TUNNEL="$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$TUNNEL_LOG" | head -1 || true)"
  [ -n "$TUNNEL" ] && break
  sleep 1
done
[ -n "$TUNNEL" ] || fail "the tunnel did not start; its log: $TUNNEL_LOG"
BANK_URL="$TUNNEL/mcp"
say "bank: $BANK_URL"

# ---------------------------------------------------------------------------
# The Introspection project
# ---------------------------------------------------------------------------

ensure_runtime() {
  # The runtime runs recipe-operator/ from GitHub, as the manifest at the repository's
  # root names it, at the version the Data Plane deploys.
  if [ "$(introspection runtimes list -p "$PROJECT" -o json | json "v.some((r) => r.slug === '$RUNTIME')")" != "true" ]; then
    say "creating the $RUNTIME runtime from .introspection/$RUNTIME.yaml"
    (cd "$(git rev-parse --show-toplevel)" &&
      introspection runtimes create --manifest ".introspection/$RUNTIME.yaml" -p "$PROJECT" --yes >/dev/null) ||
      fail "could not create the $RUNTIME runtime"
  fi
}

# The page's `spa` application, by name; its client_id on stdout.
ensure_spa() {
  local app
  app="$(introspection applications list -p "$PROJECT" -o json | json "(v.records ?? v).find((a) => a.name === '$SPA_NAME')")"
  if [ -z "$app" ]; then
    app="$(introspection applications create -p "$PROJECT" --type spa --name "$SPA_NAME" \
      --environment staging \
      --redirect-uri "http://localhost:$PORT/callback" --allowed-origin "http://localhost:$PORT" \
      --allowed-scope "tasks:read tasks:write tasks:eval tasks:exec files:read files:write" -o json | json 'v.application ?? v')"
  fi
  json 'v.client_id' <<<"$app"
}

# The application the bank is linked to, by name; its id on stdout.
ensure_application() {
  local app
  app="$(introspection applications list -p "$PROJECT" -o json | json "(v.records ?? v).find((a) => a.name === '$APP_NAME')")"
  if [ -z "$app" ]; then
    # It only signs end-user tokens: it holds no secret and needs no scope
    # beyond the least one.
    app="$(introspection applications create -p "$PROJECT" --type service-account --name "$APP_NAME" \
      --allowed-scope "runtimes:read" -o json | json 'v.application ?? v')"
  fi
  json 'v.id + " " + v.client_id' <<<"$app"
}

connect() {
  local whoami cp_url app app_id client_id endpoint audience
  whoami="$(introspection whoami 2>/dev/null)" || return 1
  [ "$(json 'v.logged_in' <<<"$whoami")" = true ] || return 1
  cp_url="$(json 'v.cp_url' <<<"$whoami")"
  say "setting up your project on $cp_url"

  ensure_runtime

  local spa_client
  spa_client="$(ensure_spa)"
  [ -n "$spa_client" ] || fail "could not create the $SPA_NAME application"
  upsert_env NEXT_PUBLIC_TRIVIA_SPA_CLIENT_ID "$spa_client"
  if [ "${cp_url%/}" = "$PRODUCTION" ]; then
    remove_env NEXT_PUBLIC_INTROSPECTION_API_BASE_URL
  else
    upsert_env NEXT_PUBLIC_INTROSPECTION_API_BASE_URL "${cp_url%/}"
  fi

  app="$(ensure_application)"
  app_id="${app% *}"
  client_id="${app#* }"
  [ -n "$app_id" ] && [ -n "$client_id" ] || fail "could not create the $APP_NAME application"

  # An upsert by MCP server id, so a restart repoints it at the new tunnel. The binding
  # command takes no project, so it acts in the one `introspection login` chose: sign in to
  # the $PROJECT project for it to land beside the runtime.
  endpoint="$(introspection bindings mcp connect -r "$RUNTIME" --mcp-server-id "$MCP_SERVER_ID" \
    --endpoint-url "$BANK_URL" --authorized-application "$app_id" -o json)" ||
    fail "could not bind $MCP_SERVER_ID to $BANK_URL"
  say "$MCP_SERVER_ID → $BANK_URL, end users named by $APP_NAME ($app_id)"

  # The token's audience is the endpoint's audience setting, or else its URL.
  audience="$(json 'v.audience ?? v.endpoint?.audience ?? ""' <<<"$endpoint")"
  export TRIVIA_ISSUER="${cp_url%/}/v1/applications/$client_id"
  if [ -n "$audience" ]; then export TRIVIA_AUDIENCE="$audience"; fi
  say "the bank verifies tokens from $TRIVIA_ISSUER"
}

if [ -n "${TRIVIA_NO_SETUP:-}" ]; then
  say "serving the app and its tunnel only; the project is left as set up"
elif ! connect; then
  say "not connected to Introspection: the bank refuses every call until you run \`introspection login\` and restart pnpm dev"
fi

# The bank starts after the setup, with the issuer and audience it set. It serves only /mcp, and only on loopback, for the tunnel.
PORT="$BANK_PORT" HOST=127.0.0.1 TRIVIA_BANK_MCP_ONLY=1 \
  node --env-file-if-exists="$ENV_FILE" --import tsx scripts/bank-server.ts &
PIDS+=($!)
node_modules/.bin/next dev --hostname 127.0.0.1 --port "$PORT" &
PIDS+=($!)
APP=$!
say "page: http://localhost:$PORT, bank: $BANK_URL"
wait "$APP"
