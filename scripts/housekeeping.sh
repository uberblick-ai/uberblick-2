#!/bin/sh
# Integrator housekeeping, run last (owner direction, 2026-09-01):
#   sh scripts/housekeeping.sh <review sha> [--dry-run]
# Docker — what fills the disk is one retained review image per run, so those go
#   at once: every uberblick-review image older than this run's, then this run's.
#   Stopped containers and dangling layers go too. Build cache and unused images
#   are kept for a week (`until=168h`) so the next review still starts warm.
# Worktrees — git keeps no creation time, but a worktree's HEAD and index under
#   .git/worktrees/ change on every checkout or commit, so their mtime is last
#   activity. Remove a worktree only when that is a day old, its status is clean,
#   AND its branch is merged into origin/main, gone from origin, or detached. A
#   branch still on origin and unmerged is someone's run: kept. The main checkout
#   and the worktree this runs from are never touched.
set -u
sha=${1:?usage: housekeeping.sh <review sha> [--dry-run]}
dry=${2:-}
failed=0
run() {
  if [ -n "$dry" ]; then
    echo "would: $*"
    return 0
  fi
  "$@" >/dev/null 2>&1
  status=$?
  if [ "$status" -ne 0 ]; then
    echo "housekeeping: failed ($status): $*" >&2
    failed=1
    return "$status"
  fi
}

image_list() {
  label=$1
  shift
  "$@" 2>/dev/null
  status=$?
  if [ "$status" -ne 0 ]; then
    echo "housekeeping: failed ($status): $label" >&2
    return "$status"
  fi
}
review_images() {
  current=$(image_list "docker image ls uberblick-review:$sha" docker image ls -q "uberblick-review:$sha") || return 1
  if [ -n "$current" ]; then
    older=$(image_list "docker image ls before uberblick-review:$sha" docker image ls -q --filter reference=uberblick-review --filter "before=uberblick-review:$sha") || return 1
  else
    older=$(image_list "docker image ls review images" docker image ls -q --filter reference=uberblick-review) || return 1
  fi
  older=$(printf '%s\n' "$older" | sort -u)
  [ -n "$older" ] && run docker image rm -f $older
  [ -n "$current" ] && run docker image rm -f "uberblick-review:$sha"
  return 0
}

git fetch -q origin main || exit 2
review_images || failed=1
run docker container prune -f
run docker image prune -f
run docker image prune -a -f --filter until=168h
run docker builder prune -f --filter until=168h
run git worktree prune

self=$(git rev-parse --show-toplevel)
git worktree list --porcelain | awk '
  /^worktree /{w=$2} /^HEAD /{h=$2} /^branch /{b=$2} /^detached/{b="detached"} /^locked/{l="locked"}
  /^$/{if (w) print w, h, b, l; w=h=b=l=""} END{if (w) print w, h, b, l}' |
{
  worktree_failed=0
  read -r main _ _ # the first entry is the main checkout
  while read -r wt head branch locked; do
    [ "$wt" = "$main" ] || [ "$wt" = "$self" ] && continue
    gd=$(git -C "$wt" rev-parse --git-dir 2>/dev/null) || { echo "skip   $wt (unreadable)"; continue; }
    if [ -n "$(find "$gd/HEAD" "$gd/index" -mtime -1 2>/dev/null)" ]; then echo "keep   $wt (touched today)"; continue; fi
    [ "$locked" = "locked" ] && { echo "keep   $wt (locked)"; continue; }
    state=$(git -C "$wt" status --porcelain 2>/dev/null)
    status=$?
    if [ "$status" -ne 0 ]; then echo "keep   $wt (status unavailable)"; continue; fi
    if [ -n "$state" ]; then echo "keep   $wt (dirty)"; continue; fi
    reason=""
    if [ "$branch" = "detached" ]; then
      if git merge-base --is-ancestor "$head" origin/main 2>/dev/null ||
        [ -n "$(git for-each-ref --contains="$head" --count=1 --format='%(refname)' 2>/dev/null)" ]; then
        reason="detached, idle a day"
      else echo "keep   $wt (unmerged commits)"; continue; fi
    elif git merge-base --is-ancestor "$head" origin/main 2>/dev/null; then reason="merged"
    elif ! git ls-remote --exit-code --heads origin "${branch#refs/heads/}" >/dev/null 2>&1; then reason="branch gone from origin"
    fi
    if [ -n "$reason" ]; then
      if [ -n "$dry" ]; then echo "would: git worktree remove $wt ($reason)"
      elif git worktree remove "$wt" >/dev/null 2>&1; then echo "remove $wt ($reason)"
      else
        status=$?
        echo "housekeeping: failed ($status): git worktree remove $wt" >&2
        echo "keep   $wt (remove failed)"
        worktree_failed=1
      fi
    else echo "keep   $wt (${branch#refs/heads/} still open)"; fi
  done
  [ "$worktree_failed" -eq 0 ]
} || failed=1

exit "$failed"
