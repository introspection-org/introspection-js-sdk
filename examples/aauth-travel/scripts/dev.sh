#!/usr/bin/env bash
# `pnpm dev`: the Flight Sector demo app on :3400, its parties on public https
# URLs, and your Introspection project set up to use them.
#
# It installs the introspection CLI, or upgrades it, first.
#
# Which Introspection it connects to is whichever stack `introspection login`
# chose: staging, production, or your own. Not logged in, the app runs alone.
#
# Public URLs come from free Cloudflare quick tunnels (`brew install
# cloudflared`), new each run; the project follows them. With
# FLIGHTSECTOR_DOMAIN=example.dev (in the environment or .env.local) they are
# a named tunnel's hosts on that domain instead, the same every run
# (`cloudflared tunnel login` once).
#
# The project setup, the first time on a stack (safe to re-run):
#   1. the agent: a repository Introspection hosts, seeded from the public
#      travel-agent recipe, and its runtime
#   2. flight search: Browserbase's hosted MCP with BROWSERBASE_API_KEY set,
#      otherwise this app's mock
#   3. the agent's application, the booking provider as an AAuth connector
#      (introspection/booking.json) on its public host, and the runtime's
#      BOOKING_API_URL variable naming that host for the recipe
#   4. Sam, the traveller, as a customer member (introspection/sam.json)
#   5. a client secret for the demo page to sign in as the agent's application,
#      and, on the hosted Person Server, Acme's own application for approvals
# Later runs only point the connector, BOOKING_API_URL and the mock at the new URLs.
#
# Env:
#   PERSON_SERVER        hosted (default): Introspection's hosted Person Server
#                        speaks for Acme. acme: Acme's own, served by this app.
#   BROWSERBASE_API_KEY  real flight searches through Browserbase's hosted MCP
#   FLIGHTSECTOR_FEDERATED=1  Flight Sector runs its own AAuth Access Server, on
#                        a host of its own, and the booking provider names it
#                        (four-party); needs PERSON_SERVER=acme
#   FLIGHTSECTOR_DOMAIN  a domain in your Cloudflare account, for stable URLs
#   FLIGHTSECTOR_HOST_PREFIX  prefixes those hosts, e.g. smoke- for an automated
#                        run that must not take over a presenter's hosts
#   FLIGHTSECTOR_TUNNEL_TOKEN  run the named tunnel by its token, for CI: no
#                        `cloudflared tunnel login`; its DNS routes must already exist
#   FLIGHTSECTOR_NO_SETUP=1  serve the app and its tunnel only, from .env.local as
#                        it stands: no CLI, and nothing in the project changes
#   RECIPE_URL           the recipe to seed from (default the public one)
set -euo pipefail
cd "$(dirname "$0")/.."

PORT=3400
ENV_FILE=.env.local
WORK=.introspection-work
RUNTIME=travel-agent
RECIPE_URL="${RECIPE_URL:-https://github.com/introspection-recipes/recipe-travel-agent.git}"
SAM_USER_ID=sam@acme.example

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

read_env() {
  if [ -f "$ENV_FILE" ]; then
    awk -F= -v key="$1" '$1 == key { sub(/^[^=]*=/, ""); print; exit }' "$ENV_FILE"
  fi
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

# `issuer URL`: the issuer the well-known document at URL names, empty when
# there is none there; fails when nothing answers at all.
issuer() {
  local out
  out="$(curl -sS -m 10 -w '\n%{http_code}' "$1" 2>/dev/null)" || return 1
  if [ "${out##*$'\n'}" = 200 ]; then json 'v.issuer' <<<"${out%$'\n'*}"; fi
}

# ---------------------------------------------------------------------------
# The Introspection CLI, installed or brought up to date
# ---------------------------------------------------------------------------

if [ -n "${FLIGHTSECTOR_NO_SETUP:-}" ]; then
  :
elif command -v introspection >/dev/null 2>&1; then
  introspection upgrade --yes --non-interactive ||
    say "could not upgrade the introspection CLI; carrying on with $(introspection --version)"
else
  say "installing the introspection CLI"
  npm install -g @introspection-ai/cli >/dev/null || fail "could not install it: npm install -g @introspection-ai/cli"
fi
[ -n "${FLIGHTSECTOR_NO_SETUP:-}" ] || say "$(introspection --version)"

# ---------------------------------------------------------------------------
# Public URLs
# ---------------------------------------------------------------------------

command -v cloudflared >/dev/null 2>&1 || fail "install cloudflared first: brew install cloudflared"
FLIGHTSECTOR_DOMAIN="${FLIGHTSECTOR_DOMAIN:-$(read_env FLIGHTSECTOR_DOMAIN)}"
MODE="${PERSON_SERVER:-$(read_env PERSON_SERVER)}"
MODE="${MODE:-hosted}"
case "$MODE" in hosted | acme) ;; *) fail "PERSON_SERVER is hosted or acme" ;; esac
FEDERATED="${FLIGHTSECTOR_FEDERATED:-$(read_env FLIGHTSECTOR_FEDERATED)}"
case "$FEDERATED" in "" | 0) FEDERATED="" ;; 1) ;; *) fail "FLIGHTSECTOR_FEDERATED is 1 or unset" ;; esac
if [ -n "$FEDERATED" ] && [ "$MODE" = hosted ]; then
  fail "FLIGHTSECTOR_FEDERATED=1 needs PERSON_SERVER=acme: the hosted Person Server does not federate yet"
fi

PIDS=()
trap 'kill "${PIDS[@]}" 2>/dev/null || true' EXIT

# A quick tunnel to the app, its URL set in the variable named $1. Not run in
# a subshell, so its pid reaches the trap.
quick_tunnel() {
  local log url=""
  log="$(mktemp "${TMPDIR:-/tmp}/flightsector-tunnel.XXXXXX")"
  cloudflared tunnel --no-autoupdate --url "http://localhost:$PORT" >"$log" 2>&1 &
  PIDS+=($!)
  for _ in $(seq 60); do
    url="$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$log" | head -1 || true)"
    [ -n "$url" ] && break
    sleep 1
  done
  [ -n "$url" ] || fail "the tunnel did not start; its log: $log"
  printf -v "$1" '%s' "$url"
}

# Each party has a host of its own: the egress keys what it does on a request
# by host, and the app tells the parties apart by it.
# One label under the domain: Cloudflare's included certificate covers
# *.<domain>, not a second level.
if [ -n "${FLIGHTSECTOR_DOMAIN:-}" ]; then
  NAME="${FLIGHTSECTOR_TUNNEL:-flightsector}"
  PREFIX="${FLIGHTSECTOR_HOST_PREFIX:-}"
  # A token connects one tunnel and nothing else, so it can neither create the
  # tunnel nor route DNS: both are done once, by an account login.
  if [ -z "${FLIGHTSECTOR_TUNNEL_TOKEN:-}" ]; then
    cloudflared tunnel info "$NAME" >/dev/null 2>&1 || cloudflared tunnel create "$NAME" >/dev/null
  fi
  BOOKING="https://${PREFIX}flightsector-booking.${FLIGHTSECTOR_DOMAIN}"
  MOCK="https://${PREFIX}flightsector-browserbase.${FLIGHTSECTOR_DOMAIN}"
  ACME="https://${PREFIX}flightsector-ps.${FLIGHTSECTOR_DOMAIN}"
  AS="https://${PREFIX}flightsector-as.${FLIGHTSECTOR_DOMAIN}"
  ROUTES=("$BOOKING=$PORT" "$MOCK=$PORT" "$ACME=$PORT")
  if [ -n "$FEDERATED" ]; then ROUTES+=("$AS=$PORT"); fi
  # A local Introspection stack's Agent Provider and Person Server are named by
  # their public URLs, so they get hosts here too: ones that outlive a restart.
  if [ "$(introspection whoami 2>/dev/null | json 'v.cp_url' 2>/dev/null)" = "http://localhost:8000" ]; then
    LOCAL_AGENT_PROVIDER="https://introspection-cp.${FLIGHTSECTOR_DOMAIN}"
    LOCAL_PERSON_SERVER="https://introspection-ps.${FLIGHTSECTOR_DOMAIN}"
    ROUTES+=("$LOCAL_AGENT_PROVIDER=8000" "$LOCAL_PERSON_SERVER=8002")
  fi
  TUNNEL_CONFIG="$(mktemp "${TMPDIR:-/tmp}/flightsector-tunnel-config.XXXXXX")"
  echo "ingress:" >"$TUNNEL_CONFIG"
  for route in "${ROUTES[@]}"; do
    host="${route%=*}"
    host="${host#https://}"
    if [ -z "${FLIGHTSECTOR_TUNNEL_TOKEN:-}" ]; then
      cloudflared tunnel route dns --overwrite-dns "$NAME" "$host" >/dev/null
    fi
    printf '  - hostname: %s\n    service: http://localhost:%s\n' "$host" "${route##*=}" >>"$TUNNEL_CONFIG"
  done
  echo "  - service: http_status:404" >>"$TUNNEL_CONFIG"
  # The token reaches cloudflared in its environment (TUNNEL_TOKEN), never argv.
  TUNNEL_TOKEN="${FLIGHTSECTOR_TUNNEL_TOKEN:-}" cloudflared tunnel --no-autoupdate --config "$TUNNEL_CONFIG" run "$NAME" >"$(mktemp "${TMPDIR:-/tmp}/flightsector-tunnel.XXXXXX")" 2>&1 &
  PIDS+=($!)
else
  quick_tunnel BOOKING
  quick_tunnel MOCK
  ACME=""
  if [ "$MODE" = acme ]; then quick_tunnel ACME; fi
  AS=""
  if [ -n "$FEDERATED" ]; then quick_tunnel AS; fi
fi

upsert_env APP_URL "http://localhost:$PORT"
upsert_env BOOKING_ISSUER "$BOOKING"
upsert_env BROWSERBASE_MCP_URL "$MOCK"
if [ "$MODE" = acme ]; then upsert_env ACME_PERSON_SERVER_URL "$ACME"; fi
if [ -n "$FEDERATED" ]; then
  upsert_env FLIGHTSECTOR_FEDERATED 1
  upsert_env FLIGHTSECTOR_AS_URL "$AS"
  say "Flight Sector's Access Server: $AS"
else
  remove_env FLIGHTSECTOR_FEDERATED
  remove_env FLIGHTSECTOR_AS_URL
fi
say "booking provider: $BOOKING"

# The booking provider and Acme's Person Server sign with keys made here once
# and kept in .keys/, so a restart keeps them: a Person Server that cached the
# provider's keys would otherwise reject its tokens until that cache expires.
# They reach the app in its environment, never on a command line.
mkdir -p .keys
pem() {
  [ -s ".keys/$1" ] || (umask 077 && node -e '
    const { generateKeyPairSync } = require("node:crypto");
    process.stdout.write(generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }));
  ' >".keys/$1")
  cat ".keys/$1"
}
secret() {
  [ -s ".keys/$1" ] || (umask 077 && openssl rand -hex 32 >".keys/$1")
  cat ".keys/$1"
}
export BOOKING_SIGNING_KEY="${BOOKING_SIGNING_KEY:-$(pem booking.pem)}"
export ACME_PS_SIGNING_KEY="${ACME_PS_SIGNING_KEY:-$(pem acme-ps.pem)}"
export ACME_PS_SUBJECT_SECRET="${ACME_PS_SUBJECT_SECRET:-$(secret acme-ps-subject)}"
if [ -n "$FEDERATED" ]; then
  export FLIGHTSECTOR_AS_SIGNING_KEY="${FLIGHTSECTOR_AS_SIGNING_KEY:-$(pem flightsector-as.pem)}"
fi

# The app runs the workspace's own Person Server, resource and client packages
# from their dist/, so install and build them first: after a pull or a branch
# switch the source and its dependencies move on, and a stale dist answers in
# the old shape. Turbo's cache
# makes this quick when nothing changed.
say "building the workspace packages the app uses"
(cd ../.. && pnpm install --frozen-lockfile --prefer-offline --reporter=silent &&
  pnpm exec turbo run build --filter "introspection-example-aauth-travel^..." --output-logs=errors-only) ||
  fail "could not build the workspace packages; run \`pnpm build\` at the repository root to see why"

# The app starts first: the runtime's first build reaches the mock it serves.
# Until setup is done it says so, rather than that the project isn't set up.
remove_env DEMO_SETUP
if [ -z "${FLIGHTSECTOR_NO_SETUP:-}" ]; then upsert_env DEMO_SETUP pending; fi
node_modules/.bin/next dev --turbopack --port "$PORT" &
PIDS+=($!)
APP=$!
for _ in $(seq 90); do
  curl -s -o /dev/null "http://localhost:$PORT/" && break
  sleep 1
done

# ---------------------------------------------------------------------------
# The Introspection project
# ---------------------------------------------------------------------------

apply_connector() {
  local metadata
  metadata="$(node -e '
    const [resource, tenant] = process.argv.slice(1);
    const m = { aauth_resource: resource };
    if (tenant) m.aauth_tenant = tenant;
    console.log(JSON.stringify(m));
  ' "$BOOKING" "$TENANT")"
  # The booking provider's host changes with its tunnel, so the connector's
  # api_hosts and the recipe's BOOKING_API_URL are set here, not in booking.json.
  introspection connectors create @introspection/booking.json \
    --api-host "${BOOKING#https://}" \
    --person-server-url "$PERSON_SERVER_URL" \
    --application-id "$(read_env AGENT_APPLICATION_ID)" \
    --metadata "$metadata" >/dev/null
  printf '%s' "$BOOKING" | introspection bindings variables create -r "$RUNTIME" \
    --name BOOKING_API_URL --from-stdin >/dev/null
  say "booking connector → $BOOKING, approvals by $PERSON_SERVER_URL"
}

# The key is a write-only credential the egress injects; it reaches the CLI on
# stdin or from the environment, never in argv.
bind_flight_search() {
  local mcp_url
  if [ -n "${BROWSERBASE_API_KEY:-}" ]; then
    mcp_url="https://mcp.browserbase.com/mcp"
    introspection bindings credentials create -r "$RUNTIME" --name BROWSERBASE_API_KEY \
      --from-env BROWSERBASE_API_KEY >/dev/null 2>&1 || true
  else
    mcp_url="$MOCK/mcp"
    printf 'mock-browserbase-key' | introspection bindings credentials create -r "$RUNTIME" \
      --name BROWSERBASE_API_KEY --from-stdin >/dev/null 2>&1 || true
  fi
  introspection bindings mcp connect -r "$RUNTIME" --mcp-server-id browserbase \
    --endpoint-url "$mcp_url" --header 'Authorization=Bearer ${BROWSERBASE_API_KEY}' >/dev/null
  say "flight search → $mcp_url"
}

# A new client secret named $2 for application $1, on stdout. It is minted only
# when .env.local holds none, so any secret already under that name is an
# orphan: revoke them first, or switching stacks twice meets the two-secret cap.
mint_secret() {
  local app_id="$1" name="$2" id out err
  for id in $(introspection applications secrets list --app "$app_id" -o json |
    json "(v.records ?? v).filter((s) => s.name === '$name').map((s) => s.id).join(' ')"); do
    introspection applications secrets revoke --app "$app_id" --secret "$id" --yes >/dev/null
  done
  # The CLI writes the JSON on stdout and its notices ("shown once, store it
  # now") on stderr, so the two are read apart: merged, the notice breaks the
  # JSON after the secret already exists.
  err="$(mktemp "${TMPDIR:-/tmp}/flightsector-mint.XXXXXX")"
  if ! out="$(introspection applications secrets create --app "$app_id" --name "$name" -o json 2>"$err")"; then
    out="$(cat "$err")"
    rm -f "$err"
    fail "could not create the $name client secret: $out"
  fi
  rm -f "$err"
  json 'v.secret' <<<"$out"
}

# Acme's approval app, on the built-in Person Server, is an application of
# its own that may only read and answer approvals: the agent's may not. Run on
# every start, so a secret missing from .env.local is minted again.
ensure_acme_app() {
  local project_id="$1"
  local acme_name="Acme approvals" acme acme_id
  acme="$(introspection applications list -o json | json "(v.records ?? v).find((a) => a.name === '$acme_name')")"
  if [ -z "$acme" ]; then
    acme="$(introspection applications create --type service-account --name "$acme_name" \
      --allowed-scope "approvals:read approvals:write" -o json | json 'v.application ?? v')"
  fi
  acme_id="$(json 'v.id' <<<"$acme")"
  [ -n "$acme_id" ] || fail "could not create the $acme_name application"
  if [ -z "$(read_env ACME_CLIENT_SECRET)" ]; then
    local acme_secret
    acme_secret="$(mint_secret "$acme_id" "Acme approvals")"
    [ -n "$acme_secret" ] || fail "could not create a client secret for the $acme_name application"
    upsert_env ACME_CLIENT_SECRET "$acme_secret"
  fi
  upsert_env ACME_CLIENT_ID "$(json 'v.client_id' <<<"$acme")"
  upsert_env ACME_PROJECT "$project_id"
}

full_setup() {
  mkdir -p "$WORK"

  # 1. The agent.
  if introspection runtimes list -o json | json "v.some((r) => r.slug === '$RUNTIME')" | grep -q true; then
    say "runtime $RUNTIME exists"
  else
    if ! introspection repositories list -o json | json "v.some((r) => r.slug === '$RUNTIME')" | grep -q true; then
      say "seeding a repository from $RECIPE_URL"
      introspection repositories add "$RUNTIME" --provider introspection --template "$RECIPE_URL" >/dev/null ||
        fail "could not seed $RUNTIME from $RECIPE_URL; set RECIPE_URL to a recipe git can clone (for example its SSH URL)"
    fi
    rm -rf "${WORK:?}/$RUNTIME"
    git clone -q "$(introspection repositories list -o json | json "v.find((r) => r.slug === '$RUNTIME').url")" "$WORK/$RUNTIME"
    say "creating the $RUNTIME runtime"
    (cd "$WORK/$RUNTIME" && introspection runtimes create --yes >/dev/null) ||
      fail "could not create the $RUNTIME runtime from $WORK/$RUNTIME"
    # A hosted recipe is checked from the files a push carries, and the seed
    # push came before the runtime existed, so push once more to check it.
    say "pushing to $RUNTIME so the platform checks the recipe"
    (cd "$WORK/$RUNTIME" &&
      git -c user.name=aauth-travel -c user.email=aauth-travel@example.invalid \
        commit -q --allow-empty -m "chore: check the recipe" &&
      git push -q origin HEAD:main)
  fi

  # 2. Flight search.
  bind_flight_search

  # 3. The application whose client id is the agent's AAuth identity, and the connector.
  local app_name="Flight Sector agent" app app_id client_id
  app="$(introspection applications list -o json | json "(v.records ?? v).find((a) => a.name === '$app_name')")"
  # What the demo page does as it: run the runtime as Sam, follow and stop the
  # task, and load a conversation. Naming them replaces the role's default.
  local app_scopes="runtimes:read tasks:read tasks:write conversations:read"
  if [ -z "$app" ]; then
    app="$(introspection applications create --type service-account --name "$app_name" \
      --allowed-scope "$app_scopes" -o json | json 'v.application ?? v')"
  fi
  app_id="$(json 'v.id' <<<"$app")"
  client_id="$(json 'v.client_id' <<<"$app")"
  [ -n "$app_id" ] && [ -n "$client_id" ] || fail "could not create the $app_name application"
  introspection applications update "$app_id" --allowed-scope "$app_scopes" >/dev/null ||
    fail "could not set the $app_name application's scopes"
  upsert_env AGENT_APPLICATION_ID "$app_id"
  apply_connector

  # 4. Sam, before his first session, so the rails can read his seniority.
  introspection members create @introspection/sam.json >/dev/null
  say "Sam is user:$SAM_USER_ID"

  # 5. The demo page signs in as that application, with a client secret.
  if [ -z "$(read_env INTROSPECTION_CLIENT_SECRET)" ]; then
    local secret
    secret="$(mint_secret "$app_id" "Flight Sector demo")"
    [ -n "$secret" ] || fail "could not create a client secret for the $app_name application"
    upsert_env INTROSPECTION_CLIENT_SECRET "$secret"
  fi
  upsert_env INTROSPECTION_CLIENT_ID "$client_id"
  upsert_env INTROSPECTION_PROJECT "$project_id"
  if [ "$MODE" = hosted ]; then ensure_acme_app "$project_id"; fi
  upsert_env INTROSPECTION_BASE_API_URL "$CP_URL"
  upsert_env INTROSPECTION_RUNTIME "$RUNTIME"
  upsert_env DEMO_SAM_USER_ID "$SAM_USER_ID"
  upsert_env TRUSTED_AGENT_PROVIDERS "$AGENT_PROVIDER"
  upsert_env PERSON_SERVER "$MODE"
  if [ "$MODE" = hosted ]; then
    upsert_env HOSTED_PERSON_SERVER_URL "$PERSON_SERVER_URL"
    upsert_env ACME_INTROSPECTION_URL "$DP_URL"
    upsert_env ACME_ORG_ID "$ORG_ID"
  fi
}

connect() {
  command -v introspection >/dev/null 2>&1 || return 1
  local whoami
  whoami="$(introspection whoami 2>/dev/null)" || return 1
  [ "$(json 'v.logged_in' <<<"$whoami")" = true ] || return 1
  introspection members --help >/dev/null 2>&1 ||
    fail "this introspection CLI predates \`members\`; upgrade it: introspection upgrade"
  CP_URL="$(json 'v.cp_url' <<<"$whoami")"
  DP_URL="$(json 'v.dp_url' <<<"$whoami")"
  ORG_ID="$(json 'v.org_id' <<<"$whoami")"
  local project_id
  project_id="$(json 'v.project_id' <<<"$whoami")"

  # The platform as Agent Provider, which the booking provider and Acme trust,
  # and the Person Server that speaks for Acme.
  AGENT_PROVIDER="$(issuer "$CP_URL/.well-known/aauth-agent.json")" ||
    fail "nothing answers at $CP_URL: start the control plane"
  [ -n "$AGENT_PROVIDER" ] || fail "$CP_URL serves no Agent Provider: AAuth is not enabled on this stack"
  if [ "$MODE" = hosted ]; then
    PERSON_SERVER_URL="$(issuer "$DP_URL/.well-known/aauth-person.json")" ||
      fail "nothing answers at $DP_URL: start the data plane"
    [ -n "$PERSON_SERVER_URL" ] ||
      fail "$DP_URL serves no hosted Person Server; restart with PERSON_SERVER=acme to use Acme's own"
    TENANT="$ORG_ID:$project_id"
  else
    PERSON_SERVER_URL="$ACME"
    TENANT=""
  fi

  if [ -n "${LOCAL_AGENT_PROVIDER:-}" ] &&
    { [ "$AGENT_PROVIDER" != "$LOCAL_AGENT_PROVIDER" ] || { [ "$MODE" = hosted ] && [ "$PERSON_SERVER_URL" != "$LOCAL_PERSON_SERVER" ]; }; }; then
    fail "your local stack's issuers are not on $FLIGHTSECTOR_DOMAIN yet. In introspection-cloud, set
    apps/controlplane-api/.env  CONTROLPLANE_PUBLIC_URL=$LOCAL_AGENT_PROVIDER
    apps/dataplane-api/.env     PERSON_SERVER_ISSUER=$LOCAL_PERSON_SERVER
                                PERSON_SERVER_TRUSTED_AGENT_PROVIDERS=$LOCAL_AGENT_PROVIDER
  then restart the CP, the DP and their workers, and run pnpm dev again"
  fi

  # The booking provider and Acme reach both at these public URLs, so a dead
  # tunnel in front of a local stack fails every booking.
  # A tunnel just started takes a few seconds to connect.
  local doc answered
  for doc in "$AGENT_PROVIDER/.well-known/aauth-agent.json" "$PERSON_SERVER_URL/.well-known/aauth-person.json"; do
    answered=""
    for _ in $(seq 15); do
      if curl -fsS -m 10 -o /dev/null "$doc" 2>/dev/null; then
        answered=1
        break
      fi
      sleep 2
    done
    [ -n "$answered" ] ||
      fail "${doc%/.well-known/*} does not answer; on a local stack, restart its tunnel and the service it fronts"
  done

  # The project in the Introspection app, by its slug, so the demo can link to
  # the run's conversation. INTROSPECTION_APP_URL overrides the app's host.
  local project_url
  project_url="$(introspection open --annotations --print 2>/dev/null | tail -1)"
  project_url="${project_url%/annotations}"
  if [ -n "${INTROSPECTION_APP_URL:-}" ] && [ -n "$project_url" ]; then
    project_url="${INTROSPECTION_APP_URL%/}/p/${project_url##*/p/}"
  fi
  remove_env INTROSPECTION_APP_URL
  remove_env INTROSPECTION_PROJECT_ID
  if [ -n "$project_url" ]; then upsert_env INTROSPECTION_PROJECT_URL "$project_url"; fi

  # Set up on another stack (or never): set this one up from the start.
  if [ "$(read_env INTROSPECTION_BASE_API_URL)" != "$CP_URL" ]; then
    for key in INTROSPECTION_TOKEN INTROSPECTION_CLIENT_SECRET ACME_INTROSPECTION_TOKEN ACME_CLIENT_SECRET AGENT_APPLICATION_ID; do remove_env "$key"; done
  fi
  # A stack reset since keeps the URL but not the project, so check it is still there.
  local app_id
  app_id="$(read_env AGENT_APPLICATION_ID)"
  if [ -n "$app_id" ] && [ -n "$(read_env INTROSPECTION_CLIENT_SECRET)" ] &&
    introspection applications list -o json | json "(v.records ?? v).some((a) => a.id === '$app_id')" | grep -q true; then
    apply_connector
    bind_flight_search
    if [ "$MODE" = hosted ]; then ensure_acme_app "$(read_env INTROSPECTION_PROJECT)"; fi
  else
    say "setting up your project on $CP_URL"
    for key in INTROSPECTION_TOKEN INTROSPECTION_CLIENT_SECRET ACME_INTROSPECTION_TOKEN ACME_CLIENT_SECRET AGENT_APPLICATION_ID; do remove_env "$key"; done
    full_setup
  fi
  return 0
}

if [ -n "${FLIGHTSECTOR_NO_SETUP:-}" ]; then
  say "serving the app and its tunnel only; the project is left as set up: http://localhost:$PORT"
elif connect; then
  say "demo: http://localhost:$PORT"
else
  say "not connected to Introspection: run \`introspection login\`, then restart pnpm dev."
  say "meanwhile: http://localhost:$PORT/walkthrough; pnpm e2e plays the agent without Introspection."
fi
remove_env DEMO_SETUP
wait "$APP"
