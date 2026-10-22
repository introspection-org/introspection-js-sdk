#!/usr/bin/env bash
# Tell #main-build-alerts when the API drift state changes: clean to drift, or
# drift to clean.
#
# scripts/check-api-contract.mjs --out writes the state and the findings; this
# script owns the decision and the post, which follow introspection-sre's
# change/gates/main-status.sh: a {text} JSON curled to the webhook, and an
# empty webhook prints the message instead. A red that stays red stays quiet,
# so the channel hears each drift once rather than after every deploy.
#
# The last posted state lives in STATE_DIR/last-posted, and the workflow
# carries that directory between runs. It is written only after a real post,
# so a rehearsal never swallows the edge the first real post needs.
#
# env:
#   REPORT_DIR         the --out directory of check-api-contract.mjs
#   STATE_DIR          holds last-posted between runs
#   RUN_URL            optional; the run the message links to
#   CLOUD_SHA          optional; the introspection-cloud commit just deployed
#   SLACK_WEBHOOK_URL  empty prints the message instead of posting it
#   GITHUB_OUTPUT      optional; receives posted=true|false
set -euo pipefail

: "${REPORT_DIR:?}" "${STATE_DIR:?}"
output="${GITHUB_OUTPUT:-/dev/null}"

state="$(cat "${REPORT_DIR}/state")"
prev_state=""
if [ -f "${STATE_DIR}/last-posted" ]; then
  read -r prev_state <"${STATE_DIR}/last-posted"
fi
echo "state=${state} last posted=${prev_state:-none}"

if [ "${state}" = "red" ] && [ "${prev_state}" != "red" ]; then
  edge="🚨 API drift: the SDK is out of step with the staging API reference"
elif [ "${state}" != "red" ] && [ "${prev_state}" = "red" ]; then
  edge="✅ API drift cleared: the SDK matches the staging API reference again"
else
  echo "No edge; staying quiet."
  echo "posted=false" >>"${output}"
  exit 0
fi

message="${edge}"
if [ -n "${CLOUD_SHA:-}" ]; then
  message+=$'\n'"After introspection-cloud ${CLOUD_SHA} deployed to staging."
fi
message+=$'\n'"$(cat "${REPORT_DIR}/report.txt")"
if [ -n "${RUN_URL:-}" ]; then
  message+=$'\n'"Run: ${RUN_URL}"
fi

if [ -z "${SLACK_WEBHOOK_URL:-}" ]; then
  printf 'Slack post withheld (no webhook) — would have sent:\n%s\n' "${message}"
  echo "posted=false" >>"${output}"
  exit 0
fi
code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 20 \
  -X POST -H 'Content-Type: application/json' \
  -d "$(jq -n --arg t "${message}" '{text: $t}')" "${SLACK_WEBHOOK_URL}" || true)"
case "${code}" in
  2*) echo "Posted to Slack." ;;
  *)
    echo "::warning::Slack refused this alert (HTTP ${code}), so the channel did not hear it."
    exit 1
    ;;
esac
mkdir -p "${STATE_DIR}"
echo "${state}" >"${STATE_DIR}/last-posted"
echo "posted=true" >>"${output}"
