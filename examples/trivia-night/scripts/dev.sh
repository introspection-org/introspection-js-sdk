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
# The project setup, the first time on a stack (safe to re-run):
#   1. the trivia-host Runtime: a repository Introspection hosts, synced from
#      this example's recipe-operator/ with its generated Harbor tasks, and its runtime
#   2. the application the bank is linked to: the platform signs a token
#      naming the end user, as that application, on every call to the bank
#   3. the trivia-bank MCP binding, on the tunnel, linked to that application
# Later runs only point the binding at the new tunnel URL.
#
# Env:
#   TRIVIA_NO_SETUP=1  serve the app and its tunnel only, from .env.local as it
#                      stands: no CLI, and nothing in the project changes
set -euo pipefail
cd "$(dirname "$0")/.."

PORT=3500
BANK_PORT=3501
ENV_FILE=.env.local
WORK=.introspection-work
RUNTIME=trivia-host
MCP_SERVER_ID=trivia-bank
APP_NAME="Trivia Night bank"

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
remove_env TRIVIA_DEV_OWNER_HEADER
remove_env TRIVIA_DEV_OWNER

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
  # The runtime runs recipe-operator/ with its Harbor tasks, which
  # recipe-operator/evals/venues.mjs generates and git ignores, so its hosted
  # repository holds a copy of that folder plus the generated tasks, synced on
  # every run so the platform evals use the tasks this checkout generates.
  local git_id=(-c user.name=trivia-night -c user.email=trivia-night@example.invalid)
  local repo_url exists
  repo_url="$(introspection repositories list -o json | json "v.find((r) => r.slug === '$RUNTIME')?.url")"
  exists="$(introspection runtimes list -o json | json "v.some((r) => r.slug === '$RUNTIME')")"
  rm -rf "${WORK:?}/$RUNTIME"
  mkdir -p "$WORK"
  if [ -n "$repo_url" ]; then
    git clone -q "$repo_url" "$WORK/$RUNTIME"
  else
    mkdir -p "$WORK/$RUNTIME"
    git -C "$WORK/$RUNTIME" init -q -b main
  fi
  (cd recipe-operator && git ls-files -z --cached --others --exclude-standard |
    rsync -a --from0 --files-from=- . "../$WORK/$RUNTIME/")
  # The generator reads the fakes' world, so their dependencies come first; the
  # page reads each task's tastes from recipe-operator/evals/harbor, so the tasks
  # are generated there too, beside the copy the runtime gets.
  [ -d recipe-operator/fakes/node_modules ] ||
    (cd recipe-operator/fakes && npm ci --silent) ||
    fail "could not install recipe-operator/fakes' dependencies"
  node recipe-operator/evals/venues.mjs >/dev/null &&
    node recipe-operator/evals/venues.mjs "$WORK/$RUNTIME/evals/harbor" >/dev/null ||
    fail "could not generate the Harbor tasks"
  (cd "$WORK/$RUNTIME" && git add -A && git add -f evals/harbor &&
    { git diff --cached --quiet HEAD 2>/dev/null ||
      git "${git_id[@]}" commit -q -m "feat: trivia-host from introspection-js-sdk examples/trivia-night/recipe-operator"; })
  if [ -z "$repo_url" ]; then
    say "creating the $RUNTIME repository from recipe-operator/"
    # Run inside a repository with commits and no origin, `add` pushes it as
    # the first commit and sets it as origin.
    (cd "$WORK/$RUNTIME" && introspection repositories add "$RUNTIME" --provider introspection >/dev/null) ||
      fail "could not create the $RUNTIME repository"
  fi
  if [ "$exists" != "true" ]; then
    say "creating the $RUNTIME runtime"
    (cd "$WORK/$RUNTIME" && introspection runtimes create --yes >/dev/null) ||
      fail "could not create the $RUNTIME runtime from $WORK/$RUNTIME"
    # A hosted recipe is checked from the files a push carries, and the seed push
    # came before the runtime existed, so push once more to check and build it.
    (cd "$WORK/$RUNTIME" &&
      git "${git_id[@]}" commit -q --allow-empty -m "chore: check the recipe")
  fi
  say "pushing $RUNTIME so the platform checks and builds the recipe and its tasks"
  (cd "$WORK/$RUNTIME" && git push -q origin HEAD:main) ||
    fail "could not push $RUNTIME"
}

# The application the bank is linked to, by name; its id on stdout.
ensure_application() {
  local app
  app="$(introspection applications list -o json | json "(v.records ?? v).find((a) => a.name === '$APP_NAME')")"
  if [ -z "$app" ]; then
    # It only signs end-user tokens: it holds no secret and needs no scope
    # beyond the least one.
    app="$(introspection applications create --type service-account --name "$APP_NAME" \
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

  app="$(ensure_application)"
  app_id="${app% *}"
  client_id="${app#* }"
  [ -n "$app_id" ] && [ -n "$client_id" ] || fail "could not create the $APP_NAME application"

  # An upsert by MCP server id, so a restart repoints it at the new tunnel.
  endpoint="$(introspection bindings mcp connect -r "$RUNTIME" --mcp-server-id "$MCP_SERVER_ID" \
    --endpoint-url "$BANK_URL" --authorized-application "$app_id" -o json)" ||
    fail "could not bind $MCP_SERVER_ID to $BANK_URL"
  say "$MCP_SERVER_ID → $BANK_URL, end users named by $APP_NAME ($app_id)"

  # The token's audience is the endpoint's audience setting, or else its URL.
  audience="$(json 'v.audience ?? v.endpoint?.audience ?? ""' <<<"$endpoint")"
  upsert_env TRIVIA_ISSUER "${cp_url%/}/v1/applications/$client_id"
  if [ -n "$audience" ]; then upsert_env TRIVIA_AUDIENCE "$audience"; else remove_env TRIVIA_AUDIENCE; fi
  say "the bank verifies tokens from ${cp_url%/}/v1/applications/$client_id"
}

if [ -n "${TRIVIA_NO_SETUP:-}" ]; then
  say "serving the app and its tunnel only; the project is left as set up"
elif ! connect; then
  say "not connected to Introspection: the bank refuses every call until you run \`introspection login\` and restart pnpm dev"
fi

# The bank starts after the setup: it reads TRIVIA_ISSUER and TRIVIA_AUDIENCE
# when it loads. It serves only /mcp, and only on loopback, for the tunnel.
PORT="$BANK_PORT" HOST=127.0.0.1 TRIVIA_BANK_MCP_ONLY=1 \
  node --env-file-if-exists="$ENV_FILE" --import tsx scripts/bank-server.ts &
PIDS+=($!)
node_modules/.bin/next dev --hostname 127.0.0.1 --port "$PORT" &
PIDS+=($!)
APP=$!
say "page: http://localhost:$PORT, bank: $BANK_URL"
wait "$APP"
