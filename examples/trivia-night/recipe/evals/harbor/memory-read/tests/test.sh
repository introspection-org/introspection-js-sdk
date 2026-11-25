#!/bin/sh
# The bank records what the host asked for; round 1 must follow the notes:
# a liked genre, at the notes' difficulty for it, and nothing local elsewhere.
set -u
logs=${LOGS_DIR:-/logs/verifier}
mkdir -p "$logs"
room=$(curl -sf http://bank:8000/rooms || true)
echo "bank: $room"
first=$(printf '%s' "$room" | sed -n 's/.*"pending":\[{\([^}]*\)}.*/\1/p')
[ -n "$first" ] || first=$(printf '%s' "$room" | sed -n 's/.*"rounds":\[{\([^}]*\)}.*/\1/p')
genre=$(printf '%s' "$first" | sed -n 's/.*"genres\{0,1\}":\[\{0,1\}"\([a-z]*\)".*/\1/p')
difficulty=$(printf '%s' "$first" | sed -n 's/.*"difficult[a-z]*":\[\{0,1\}\([0-9]\).*/\1/p')
foreign=$(printf '%s' "$room" | grep -o '"region":"\(au\|us\)"' | head -1)
fail=""
case "$genre" in science | history) ;; *) fail="$fail round 1 genre '$genre' is not one the venue likes;" ;; esac
case "$genre:$difficulty" in science:5 | history:4) ;; *) fail="$fail round 1 is $genre at difficulty '$difficulty', not the notes' pitch;" ;; esac
[ -z "$foreign" ] || fail="$fail served a question local to another country;"
if [ -z "$fail" ]; then
  echo 1 >"$logs/reward.txt"
  echo "pass: round 1 is $genre at difficulty $difficulty"
  exit 0
fi
echo 0 >"$logs/reward.txt"
echo "fail:$fail" >&2
exit 1
