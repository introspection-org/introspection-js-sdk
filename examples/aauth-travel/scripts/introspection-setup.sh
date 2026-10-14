#!/usr/bin/env bash
# Sets up your Introspection project for the demo, on whichever stack the
# `introspection` CLI is logged in to (`introspection login`):
#
#   1. the agent: a managed repository seeded from the public travel-agent
#      recipe, and its runtime
#   2. flight search: Browserbase's hosted MCP with BROWSERBASE_API_KEY set,
#      otherwise this app's mock
#   3. the application the agent acts as, and the booking provider as an AAuth
#      connector (introspection/booking.json)
#   4. Sam, the traveller, as a customer member with the attributes the
#      recipe's Cedar rails read (introspection/sam.json)
#   5. an API key for the demo page and Acme's approvals, and the rest of
#      .env.local
#
# Run `pnpm dev:public` first: the connector needs the booking provider's
# public URL. Safe to re-run; `scripts/introspection-setup.sh connector` redoes
# step 3 alone, which is what `dev:public` does when its URL changes.
#
# Env:
#   PERSON_SERVER  hosted (default): Introspection's hosted Person Server speaks
#                  for Acme. acme: Acme's own, served by this app.
#   RECIPE_URL     the recipe to seed from (default the public travel-agent recipe)
#   BROWSERBASE_API_KEY  real flight searches through Browserbase's hosted MCP
set -euo pipefail
cd "$(dirname "$0")/.."

ENV_FILE=.env.local
WORK=.introspection-work
RUNTIME=travel-agent
RECIPE_URL="${RECIPE_URL:-https://github.com/introspection-org/recipe-travel-agent.git}"
SAM_USER_ID=sam@acme.example

say() { echo "[setup] $*"; }
fail() {
  echo "[setup] $*" >&2
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

command -v introspection >/dev/null 2>&1 ||
  fail "install the introspection CLI (npm install -g @introspection-ai/cli), then: introspection login"
introspection members --help >/dev/null 2>&1 ||
  fail "this introspection CLI predates \`members\`; upgrade it: introspection upgrade"
WHOAMI="$(introspection whoami 2>/dev/null)" || fail "run: introspection login"
[ "$(json 'v.logged_in' <<<"$WHOAMI")" = true ] || fail "run: introspection login"
CP_URL="$(json 'v.cp_url' <<<"$WHOAMI")"
DP_URL="$(json 'v.dp_url' <<<"$WHOAMI")"
ORG_ID="$(json 'v.org_id' <<<"$WHOAMI")"
PROJECT_ID="$(json 'v.project_id' <<<"$WHOAMI")"
MODE="${PERSON_SERVER:-$(read_env PERSON_SERVER)}"
MODE="${MODE:-hosted}"
case "$MODE" in hosted | acme) ;; *) fail "PERSON_SERVER is hosted or acme" ;; esac

BOOKING="$(read_env BOOKING_ISSUER)"
[ -n "$BOOKING" ] || fail "start \`pnpm dev:public\` first: it gives the booking provider a public URL"

# The platform as Agent Provider, which the booking provider and Acme trust.
AGENT_PROVIDER="$(curl -fsS "$CP_URL/.well-known/aauth-agent.json" | json 'v.issuer')" ||
  fail "$CP_URL serves no Agent Provider; AAuth is not enabled on this stack"

if [ "$MODE" = hosted ]; then
  PERSON_SERVER_URL="$(curl -fsS "$DP_URL/.well-known/aauth-person.json" | json 'v.issuer')" ||
    fail "$DP_URL serves no hosted Person Server; run with PERSON_SERVER=acme to use Acme's own"
  # Acme is a tenant of the hosted Person Server; here, your own project.
  TENANT="$ORG_ID:$PROJECT_ID"
else
  PERSON_SERVER_URL="$(read_env ACME_PERSON_SERVER_URL)"
  [ -n "$PERSON_SERVER_URL" ] || fail "restart \`PERSON_SERVER=acme pnpm dev:public\` to give Acme's Person Server a public URL"
  TENANT=""
fi

apply_connector() {
  local app_id metadata
  app_id="$(read_env AGENT_APPLICATION_ID)"
  [ -n "$app_id" ] || fail "run the whole setup once first: pnpm run introspection:setup"
  metadata="$(node -e '
    const [resource, tenant] = process.argv.slice(1);
    const m = { aauth_resource: resource, aauth_upstream: resource };
    if (tenant) m.aauth_tenant = tenant;
    console.log(JSON.stringify(m));
  ' "$BOOKING" "$TENANT")"
  introspection connectors create @introspection/booking.json \
    --person-server-url "$PERSON_SERVER_URL" \
    --application-id "$app_id" \
    --metadata "$metadata" >/dev/null
  say "booking connector → $BOOKING, approvals by $PERSON_SERVER_URL"
}

if [ "${1:-}" = connector ]; then
  apply_connector
  exit 0
fi

mkdir -p "$WORK"

# 1. The agent.
if introspection runtimes list -o json | json "v.some((r) => r.slug === '$RUNTIME')" | grep -q true; then
  say "runtime $RUNTIME exists"
else
  if ! introspection repositories list -o json | json "v.some((r) => r.slug === '$RUNTIME')" | grep -q true; then
    say "seeding a managed repository from $RECIPE_URL"
    introspection repositories add "$RUNTIME" --provider introspection --template "$RECIPE_URL" >/dev/null
  fi
  CLONE="$(introspection repositories list -o json | json "v.find((r) => r.slug === '$RUNTIME').url")"
  rm -rf "${WORK:?}/$RUNTIME"
  git clone -q "$CLONE" "$WORK/$RUNTIME"
  say "creating the $RUNTIME runtime"
  (cd "$WORK/$RUNTIME" && introspection runtimes create --yes >/dev/null)
fi

# 2. Flight search. The key is a write-only credential the egress injects; it
# reaches the CLI on stdin or from the environment, never in argv.
if [ -n "${BROWSERBASE_API_KEY:-}" ]; then
  MCP_URL="https://mcp.browserbase.com/mcp"
  introspection bindings credentials create -r "$RUNTIME" --name BROWSERBASE_API_KEY \
    --from-env BROWSERBASE_API_KEY >/dev/null 2>&1 || true
else
  MCP_URL="$BOOKING/browserbase/mcp"
  printf 'mock-browserbase-key' | introspection bindings credentials create -r "$RUNTIME" \
    --name BROWSERBASE_API_KEY --from-stdin >/dev/null 2>&1 || true
fi
introspection bindings mcp connect -r "$RUNTIME" --mcp-server-id browserbase \
  --endpoint-url "$MCP_URL" --header 'Authorization=Bearer ${BROWSERBASE_API_KEY}' >/dev/null
say "flight search → $MCP_URL"

# 3. The application whose client id is the agent's AAuth identity, and the connector.
APP_NAME="Flight Sector agent"
APP_ID="$(introspection applications list -o json | json "(v.records ?? v).find((a) => a.name === '$APP_NAME')?.id")"
if [ -z "$APP_ID" ]; then
  APP_ID="$(introspection applications create --type service-account --name "$APP_NAME" -o json | json 'v.id ?? v.application?.id')"
fi
[ -n "$APP_ID" ] || fail "could not create the $APP_NAME application"
upsert_env AGENT_APPLICATION_ID "$APP_ID"
apply_connector

# 4. Sam, before his first session, so the rails can read his seniority.
introspection members create @introspection/sam.json >/dev/null
say "Sam is user:$SAM_USER_ID"

# 5. One project key for the demo page and Acme's approval app.
if [ -z "$(read_env INTROSPECTION_TOKEN)" ]; then
  KEY_FILE="$WORK/api-key"
  rm -f "$KEY_FILE"
  introspection api-keys create --name "Flight Sector demo" --secret-file "$KEY_FILE" >/dev/null
  KEY="$(cat "$KEY_FILE")"
  rm -f "$KEY_FILE"
  upsert_env INTROSPECTION_TOKEN "$KEY"
  upsert_env ACME_INTROSPECTION_TOKEN "$KEY"
  unset KEY
fi
upsert_env INTROSPECTION_BASE_API_URL "$CP_URL"
upsert_env INTROSPECTION_RUNTIME "$RUNTIME"
upsert_env DEMO_SAM_USER_ID "$SAM_USER_ID"
upsert_env TRUSTED_AGENT_PROVIDERS "$AGENT_PROVIDER"
upsert_env PERSON_SERVER "$MODE"
if [ "$MODE" = hosted ]; then
  upsert_env HOSTED_PERSON_SERVER_URL "$PERSON_SERVER_URL"
  upsert_env ACME_INTROSPECTION_URL "$DP_URL"
  upsert_env ACME_ORG_ID "$ORG_ID"
  upsert_env ACME_TENANT "$TENANT"
fi

say "done. Open http://localhost:3400/demo (pnpm dev:public picks up .env.local by itself)."
