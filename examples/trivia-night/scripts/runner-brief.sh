#!/bin/sh
# runner-brief.sh <arm> <recipe> <venue> <rep> <nights> <run-dir>: a series runner's brief.
set -eu
here=$(cd "$(dirname "$0")/.." && pwd)
series="$here/$6/series/$1.$3.r$4"
sed -e "s|{{SERIES}}|$series|g" -e "s|{{RECIPE}}|$here/$2|g" -e "s|{{ARM}}|$1|g" \
  -e "s|{{VENUE}}|$3|g" -e "s|{{REP}}|$4|g" -e "s|{{NIGHTS}}|$5|g" -e "s|{{OUT}}|$here/$6|g" \
  "$here/improve/series-runner.md"
