#!/usr/bin/env bash
# Re-record this SDK's end-to-end walks on introspection-cloud's SDK Walks
# workflow (sdk-walks.yml), which runs every SDK's walk against a Compose stack
# built from the cloud ref, with this SDK checked out at the SDK ref. Every walk
# recording the run made (the walk, and the suites beside it such as GitHub
# write-back) is then copied into tests/recordings.
#
#   scripts/record-walk.sh                                 # cloud main, the current branch
#   scripts/record-walk.sh --cloud-ref my-cloud-branch --sdk-ref my-sdk-branch
#   pnpm record-walk -- --sdk-ref my-sdk-branch            # the same, from the root
#
# Run it from a checkout of this repository: the one around the current
# directory, else the one holding this script. The SDK ref must be pushed and not
# behind its remote: the workflow checks it out from GitHub, not from this
# checkout. The run's sdk-coverage artifact stays in .record-walk/<run id>.
# WALK_RECORD_LOCK, when set, names a directory used as a lock so only one
# recording runs at a time on this machine. Needs gh (signed in) and jq.
#
# Another SDK copies this script and changes only the settings below.
set -euo pipefail

SDK=js
SDK_REPO=introspection-org/introspection-js-sdk
# Where the recordings sit in the workflow's sdk-coverage artifact, and here.
# Each holds <name>/bootstrap.json and <name>_<hash>/recording.har (Polly's
# directory for the cassette), the layout the replay reads.
ARTIFACT_RECORDING_DIR=recordings/js
RECORDING_DIR=tests/recordings
REPLAY="pnpm --filter introspection-tests test:walk"

CLOUD_REPO=introspection-org/introspection-cloud
WORKFLOW=sdk-walks.yml
POLL=30

die() { echo "record-walk: $*" >&2; exit 1; }
say() { echo "record-walk: $*" >&2; }

# The git remote of a `git remote -v` listing that fetches from SDK_REPO.
sdk_remote() { awk -v r="$SDK_REPO" '$2 ~ r"(\\.git)?$" && $3 == "(fetch)" { print $1; exit }'; }

script="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
top=$(git rev-parse --show-toplevel 2>/dev/null || true)
if [ -n "$top" ] && [ -n "$(git -C "$top" remote -v | sdk_remote)" ]; then
  cd "$top"
else
  cd "$(dirname "$script")/.."
fi
[ -n "$(git remote -v 2>/dev/null | sdk_remote)" ] || die "run it from a checkout of $SDK_REPO"

cloud_ref=main
sdk_ref=$(git branch --show-current)
while [ "$#" -gt 0 ]; do
  case "$1" in
    --) shift ;;
    --cloud-ref) cloud_ref=${2:?--cloud-ref needs a value}; shift 2 ;;
    --sdk-ref) sdk_ref=${2:?--sdk-ref needs a value}; shift 2 ;;
    -h | --help) sed -n '2,19p' "$script" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done
[ -n "$sdk_ref" ] || die "detached HEAD: pass --sdk-ref <branch>"
command -v gh >/dev/null || die "gh is not installed"
command -v jq >/dev/null || die "jq is not installed"

# 1. The workflow records what GitHub has, so the SDK ref must be pushed and current.
remote=$(git remote -v | sdk_remote)
[ -n "$remote" ] || die "no git remote points at $SDK_REPO"
git fetch --quiet "$remote" "+refs/heads/$sdk_ref:refs/remotes/$remote/$sdk_ref" 2>/dev/null ||
  die "$sdk_ref is not pushed to $SDK_REPO; push it first"
sdk_sha=$(git rev-parse "refs/remotes/$remote/$sdk_ref")
if local_sha=$(git rev-parse --verify --quiet "refs/heads/$sdk_ref"); then
  [ -z "$(git rev-list "$local_sha..$sdk_sha")" ] || die "$sdk_ref is behind $remote/$sdk_ref; pull first"
  [ -z "$(git rev-list "$sdk_sha..$local_sha")" ] || die "$sdk_ref has unpushed commits; push them first"
fi
say "recording $SDK_REPO@$sdk_ref ($sdk_sha) against $CLOUD_REPO@$cloud_ref"

lock_held=
release_lock() {
  if [ -n "$lock_held" ]; then rm -rf "$WALK_RECORD_LOCK"; lock_held=; fi
}
trap release_lock EXIT
trap 'exit 130' INT TERM

# 2. One recording at a time on this machine.
if [ -n "${WALK_RECORD_LOCK:-}" ]; then
  until mkdir "$WALK_RECORD_LOCK" 2>/dev/null; do
    say "waiting for $WALK_RECORD_LOCK (held by $(cat "$WALK_RECORD_LOCK/branch" 2>/dev/null || echo unknown))"
    sleep "$POLL"
  done
  lock_held=1
  echo "$SDK_REPO@$sdk_ref" >"$WALK_RECORD_LOCK/branch"
fi

# 3. A dispatch cancels a running SDK Walks run on the same ref, so wait for none to run.
busy() {
  gh run list --repo "$CLOUD_REPO" --workflow "$WORKFLOW" --limit 50 \
    --json databaseId,status,url --jq '[.[] | select(.status != "completed") | .url] | join(" ")'
}
while :; do
  runs=$(busy) || die "cannot list $CLOUD_REPO's SDK Walks runs"
  [ -n "$runs" ] || break
  say "waiting for running SDK Walks runs: $runs"
  sleep "$POLL"
done

# 4. Dispatch, then find that run: gh prints its URL; failing that, the newest
# dispatch on the cloud ref by this user created after the dispatch.
me=$(gh api user --jq .login)
since=$(date -u +%Y-%m-%dT%H:%M:%SZ)
out=$(gh workflow run "$WORKFLOW" --repo "$CLOUD_REPO" --ref "$cloud_ref" \
  -f sdk_refs="$SDK=$sdk_ref" 2>&1) || die "dispatch failed: $out"
run_id=$(grep -oE "/actions/runs/[0-9]+" <<<"$out" | head -1 | cut -d/ -f4 || true)
for _ in $(seq 20); do
  [ -z "$run_id" ] || break
  sleep 5
  run_id=$(gh run list --repo "$CLOUD_REPO" --workflow "$WORKFLOW" --event workflow_dispatch \
    --branch "$cloud_ref" --user "$me" --limit 10 --json databaseId,createdAt \
    --jq "[.[] | select(.createdAt >= \"$since\")] | last | .databaseId // empty")
done
[ -n "$run_id" ] || die "dispatched, but no run appeared: $out"
run_url="https://github.com/$CLOUD_REPO/actions/runs/$run_id"
say "run $run_url"

while :; do
  # A failed poll (a network blip in a long wait) is retried, not fatal.
  state=$(gh run view "$run_id" --repo "$CLOUD_REPO" --json status,conclusion \
    --jq '"\(.status) \(.conclusion)"' 2>/dev/null) || state="unknown -"
  read -r status conclusion <<<"$state"
  [ "$status" = completed ] && break
  say "run is $status"
  sleep "$POLL"
done
say "run $conclusion"

# 5. A walk can be advisory in the workflow, so read its own log, not the run's
# conclusion. The artifact stays, so a failed walk can be read without
# downloading it again.
art="$PWD/.record-walk/$run_id"
rm -rf "$art"
gh run download "$run_id" --repo "$CLOUD_REPO" --name sdk-coverage --dir "$art" ||
  die "the run ($conclusion) left no sdk-coverage artifact: $run_url"
release_lock
log="$art/walk-$SDK.log"
say "artifact in $art"
[ -f "$log" ] || die "the artifact has no walk-$SDK.log, so the $SDK walk never ran: $run_url"
# Vitest's summary, without its colours: "Test Files  1 failed | 2 passed (3)", "Tests  ...".
plain=$(sed $'s/\x1b\\[[0-9;]*m//g' "$log")
if grep -qE '^ *(Test Files|Tests) .*failed' <<<"$plain" || ! grep -qE '^ *Tests .*passed' <<<"$plain"; then
  grep -E -A3 '^ *(FAIL|×|Test Files|Tests) ' <<<"$plain" | grep -v '^--$' | tail -60 >&2 || tail -60 <<<"$plain" >&2
  die "the $SDK walk failed in $run_url (read $log); nothing copied"
fi
src="$art/$ARTIFACT_RECORDING_DIR"
names=()
for d in "$src"/*/; do
  [ -d "$d" ] || continue
  name=$(basename "$d")
  [ -s "$d/bootstrap.json" ] || continue
  names+=("$name")
  # Polly's cassette for the recording sits in <name>_<hash>.
  compgen -G "$src/${name}_*/recording.har" >/dev/null ||
    die "the artifact has $ARTIFACT_RECORDING_DIR/$name/bootstrap.json but no ${name}_*/recording.har: $run_url"
done
[ "${#names[@]}" -gt 0 ] || die "the artifact has no recording under $ARTIFACT_RECORDING_DIR: $run_url (downloaded to $art)"

# Replace each recording the run made, its bootstrap and its cassette; leave the
# others (a suite the run did not walk) as they are.
for name in "${names[@]}"; do
  rm -rf "${RECORDING_DIR:?}/$name" "$RECORDING_DIR/${name}"_*
  cp -R "$src/$name" "$RECORDING_DIR/$name"
  for cassette in "$src/${name}"_*/; do
    cp -R "${cassette%/}" "$RECORDING_DIR/$(basename "$cassette")"
  done
done

# 6. Report.
echo
echo "Run: $run_url ($conclusion; $CLOUD_REPO@$cloud_ref, $SDK=$sdk_ref $sdk_sha)"
echo "Artifact: $art (walk-$SDK.log, summary.md)"
grep -F "| \`$SDK\`" "$art/summary.md" 2>/dev/null || true
echo
git status --short -- "$RECORDING_DIR"
echo "Copied ${names[*]} into $RECORDING_DIR. Now replay them, scan them for credentials, and commit:"
echo "  $REPLAY"
