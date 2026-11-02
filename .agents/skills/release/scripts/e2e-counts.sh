#!/usr/bin/env bash
# Usage: e2e-counts.sh <run-id> [log-file]
# Prints each browser shard's Playwright summary (passed/failed/flaky/skipped) and any failure lines.
# Reuses [log-file] when it already has content. Uses the whole-run log; the per-job logs
# endpoint refuses escape sequences.
set -euo pipefail
run=$1; log=${2:-$(mktemp)}
[ -s "$log" ] || gh run view "$run" -R uberblick-ai/uberblick-2 --log > "$log" 2>&1
awk -F'\t' '$1 ~ /^browser / { m=$3; sub(/^[^ ]+ +/, "", m);
  if (m ~ /^[0-9]+ (passed|failed|flaky|skipped|did not run)/) print $1": "m }' "$log"
echo "--- failure lines (empty means none)"
awk -F'\t' '$1 ~ /^browser / { m=$3; sub(/^[^ ]+ +/, "", m); if (m ~ /^[0-9]+\) /) print $1": "m }' "$log" | sort -u | head -40
