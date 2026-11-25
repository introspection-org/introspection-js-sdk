#!/bin/sh
set -u
here=$(dirname "$0")
mkdir -p "${LOGS_DIR:-/logs/verifier}"
node "$here/check.mjs"
