#!/bin/sh
# run-series.sh <candidate-dir> <pub> <arm> <evidence-dir>: one pub's two nights, on the Pi subscription only.
set -eu
X=$(cd "$(dirname "$0")" && pwd)
C="${INTROSPECTION_CLI_DIR:?the folder whose node_modules/.bin has the introspection CLI}"
cd "$1"
exec env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN -u INTROSPECTION_TOKEN \
  PATH="$C/node_modules/.bin:$PATH" PUB="$2" ARM="$3" EVIDENCE_DIR="$4" \
  TASKS_DIR="$HOME/introspection/introspection-js-sdk/examples/trivia-night/recipe-operator/evals/harbor" \
  "$X/node_modules/.bin/vitest" run --config "$X/vitest.config.ts" --reporter=dot
