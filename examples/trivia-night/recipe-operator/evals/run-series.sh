#!/bin/sh
# Local only: night 1, then night 2 starting from night 1's memories.
set -eu
cd "$(dirname "$0")/.."
seed=evals/harbor/night2-memory/environment/seed-memories
find "$seed" -mindepth 1 ! -name .gitignore -delete
introspection eval run --path evals/harbor/night1-memory --harbor-adapter runtime -y >/dev/null
run=$(ls -td eval-runs/*/ | head -1)
cp -R "$run"harbor/night1-memory__*/artifacts/memories/. "$seed"/
echo "night 1: $run"; cat "$seed"/MEMORY.md
introspection eval run --path evals/harbor/night2-memory --harbor-adapter runtime -y >/dev/null || true
run=$(ls -td eval-runs/*/ | head -1)
echo "night 2: $run"; cat "$run"harbor/night2-memory__*/verifier/test-stdout.txt
