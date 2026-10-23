#!/usr/bin/env bash
# Pick the staging control plane and data plane base URLs whose
# /openapi.json the API contract check reads.
#
# introspection-cloud's "API Reference Deployed" workflow sends both in the
# api-reference-deployed payload (client_payload.cp_url / dp_url) after each
# staging deploy. That run records them in URLS_DIR, which the workflow saves
# in the Actions cache; pull requests and manual runs without inputs restore
# the newest saved pair there. Each URL given here wins over the recorded one.
#
# Writes INTROSPECTION_CP_URL and INTROSPECTION_DP_URL to GITHUB_ENV, for
# scripts/check-api-contract.mjs, and the pair to URLS_DIR/cp_url and
# URLS_DIR/dp_url. A URL that is neither given nor recorded fails.
#
# env:
#   CP_URL, DP_URL  optional; the payload's or the manual run's URLs
#   URLS_DIR        holds the recorded pair between runs
#   GITHUB_ENV      optional; receives the two INTROSPECTION_* variables
set -euo pipefail

: "${URLS_DIR:?}"
mkdir -p "${URLS_DIR}"

resolve() {
  local given="$1" file="${URLS_DIR}/$2"
  if [ -n "${given}" ]; then
    echo "${given}"
  elif [ -s "${file}" ]; then
    cat "${file}"
  fi
}
cp_url="$(resolve "${CP_URL:-}" cp_url)"
dp_url="$(resolve "${DP_URL:-}" dp_url)"

if [ -z "${cp_url}" ] || [ -z "${dp_url}" ]; then
  echo "::error::No staging reference URLs recorded yet. Run introspection-cloud's \"API Reference Deployed\" workflow by hand (it dispatches here and refills the cache), or run this workflow with the cp_url and dp_url inputs."
  exit 1
fi
# One line each, since they go into GITHUB_ENV.
for url in "${cp_url}" "${dp_url}"; do
  if ! [[ "${url}" =~ ^https?://[^[:space:]]+$ ]]; then
    echo "::error::Not an http(s) base URL: ${url}"
    exit 1
  fi
done

echo "${cp_url}" >"${URLS_DIR}/cp_url"
echo "${dp_url}" >"${URLS_DIR}/dp_url"
{
  echo "INTROSPECTION_CP_URL=${cp_url}"
  echo "INTROSPECTION_DP_URL=${dp_url}"
} >>"${GITHUB_ENV:-/dev/null}"
echo "control plane: ${cp_url}"
echo "data plane: ${dp_url}"
