#!/bin/sh
# run-series.sh <recipe-dir> <pub> <hosted|fresh> <evidence-dir>: one pub's two nights, on the Pi sign-in only.
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
cd "$1"
set -- "$(pwd)" "$2" "$3" "$4"
exec env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN -u INTROSPECTION_TOKEN \
  PUB="$2" ARM="$3" EVIDENCE_DIR="$4" TASKS_DIR="$1/evals/harbor" \
  "$HERE/node_modules/.bin/vitest" run --config "$HERE/vitest.config.ts" --reporter=dot
