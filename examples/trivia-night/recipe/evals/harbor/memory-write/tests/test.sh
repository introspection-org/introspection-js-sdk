#!/bin/sh
# The venue's notes after the night: its region and liked genres, a harder
# science pitch after a 100% round, and tonight's birthday music round not
# kept as something the venue likes.
set -u
mkdir -p /logs/verifier
notes=$(cat /workspace/memories/*.md /workspace/memories/*/*.md 2>/dev/null || true)
printf 'notes:\n%s\n' "$notes"
fail=""
[ -n "$notes" ] || fail="$fail no notes under /workspace/memories;"
printf '%s' "$notes" | grep -qiE 'uk|oxford|united kingdom|britain|england' || fail="$fail the region is missing;"
likes=$(printf '%s\n' "$notes" | grep -iE 'like|love|favou?rite|prefer' || true)
printf '%s' "$likes" | grep -qi science || fail="$fail science is not noted as liked;"
printf '%s' "$likes" | grep -qi history || fail="$fail history is not noted as liked;"
printf '%s' "$likes" | grep -qi music && fail="$fail tonight's music round was kept as a liking;"
printf '%s\n' "$notes" | grep -iE 'science' | grep -qE '\b[45]\b' || fail="$fail science is not pitched above 3;"
if [ -z "$fail" ]; then
  echo 1 >/logs/verifier/reward.txt
  echo pass
  exit 0
fi
echo 0 >/logs/verifier/reward.txt
echo "fail:$fail" >&2
exit 1
