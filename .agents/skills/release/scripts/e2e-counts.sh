#!/usr/bin/env bash
# Usage: e2e-counts.sh <run-id> [log-file]
# Prints each browser shard's Playwright summary (passed/failed/flaky/skipped) and any failure lines.
# Reuses nonempty [log-file], refusing logs without browser summaries.
# Uses the whole-run log; the per-job logs endpoint refuses escape sequences.
set -euo pipefail
run=$1; log=${2:-$(mktemp)}
if [ ! -s "$log" ]; then
  download=$(mktemp "${log}.XXXXXX")
  trap 'rm -f -- "$download"' EXIT
  gh run view "$run" -R uberblick-ai/uberblick-2 --log > "$download"
  mv -- "$download" "$log"
fi
awk -F'\t' '$1 ~ /^browser / { m=$3; sub(/^[^ ]+ +/, "", m);
  if (m ~ /^[0-9]+ (passed|failed|flaky|skipped|did not run)/) { print $1": "m; found=1 } }
  END { if (!found) { print "No browser summaries found in log" > "/dev/stderr"; exit 1 } }' "$log"
echo "--- failure lines (empty means none)"
awk -F'\t' '$1 ~ /^browser / { m=$3; sub(/^[^ ]+ +/, "", m); if (m ~ /^[0-9]+\) /) print $1": "m }' "$log" | sort -u | head -40
