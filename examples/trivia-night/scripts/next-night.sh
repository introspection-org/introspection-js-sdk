#!/bin/sh
# next-night.sh <run-dir> <arm> <venue> <rep> <night>: record the series' previous
# night (if any), set up this one, and print the host's one-line prompt.
set -eu
cd "$(dirname "$0")/.."
run=$1 arm=$2 venue=$3 rep=$4 night=$5
series="$PWD/$run/series/$arm.$venue.r$rep"
if [ "$night" -gt 1 ]; then pnpm -s host finish "$series" --out "$run"; fi
if [ "$night" -eq 0 ]; then exit 0; fi
pnpm -s host begin "$series" --recipe ".introspection-work/cand-$arm" --arm "$arm" --venue "$venue" --rep "$rep" --night "$night" >/dev/null
pnpm -s host brief "$series" > "$series/brief-$night.md"
echo "Read your brief at $series/brief-$night.md with the Read tool, then follow it exactly. That brief file is the only file outside the memory folder you may read."
