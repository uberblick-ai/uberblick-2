#!/usr/bin/env bash
# Usage: landed-prs.sh <previous-tag> [candidate-ref]
# Lists PRs merged into the range (prev, candidate], trusted authors only, then direct commits.
set -euo pipefail
prev=$1; cand=${2:-origin/main}; repo=uberblick-ai/uberblick-2
for c in $(git rev-list "$prev..$cand"); do
  gh api "repos/$repo/commits/$c/pulls" --jq '.[] | select(.merged_at != null) | "\(.number)\t\(.author_association)\t\(.merge_commit_sha)\t\(.title)"'
done | while IFS=$'\t' read -r n a m t; do
  if ! git merge-base --is-ancestor "$m" "$cand" || git merge-base --is-ancestor "$m" "$prev"; then continue; fi
  case $a in OWNER|MEMBER|COLLABORATOR) printf '#%s\t%s\n' "$n" "$t" ;; *) printf '#%s\t(withheld: %s author)\n' "$n" "$a" ;; esac
done | sort -u -t$'\t' -k1,1
echo "--- direct commits (no PR)"
for c in $(git rev-list --no-merges "$prev..$cand"); do
  [ "$(gh api "repos/$repo/commits/$c/pulls" --jq length)" = 0 ] && git log -1 --format='%h %s' "$c"
done
true
