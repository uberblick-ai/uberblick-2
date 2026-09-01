#!/bin/sh
# Integrator housekeeping, run last (owner direction, 2026-09-01):
#   sh scripts/housekeeping.sh <review sha> [--dry-run]
# Docker — what fills the disk is one retained review image per run, so those go
#   at once: every uberblick-review image older than this run's, then this run's.
#   Stopped containers and dangling layers go too. Build cache and unused images
#   are kept for a week (`until=168h`) so the next review still starts warm.
# Worktrees — git keeps no creation time, but a worktree's HEAD and index under
#   .git/worktrees/ change on every checkout or commit, so their mtime is last
#   activity. Remove a worktree only when that is a day old AND its branch is
#   merged into origin/main, gone from origin, or detached. A branch still on
#   origin and unmerged is someone's run: kept. The main checkout and the
#   worktree this runs from are never touched.
set -u
sha=${1:?usage: housekeeping.sh <review sha> [--dry-run]}
dry=${2:-}
run() { if [ -n "$dry" ]; then echo "would: $*"; else "$@" >/dev/null 2>&1; fi; }

git fetch -q origin main || exit 2
older=$(docker image ls -q --filter reference=uberblick-review --filter "before=uberblick-review:$sha" 2>/dev/null | sort -u)
[ -n "$older" ] && run docker image rm -f $older
run docker image rm -f "uberblick-review:$sha" || true
run docker container prune -f
run docker image prune -f
run docker image prune -a -f --filter until=168h
run docker builder prune -f --filter until=168h || echo "housekeeping: docker prune failed" >&2
run git worktree prune

self=$(git rev-parse --show-toplevel)
git worktree list --porcelain | awk '
  /^worktree /{w=$2} /^HEAD /{h=$2} /^branch /{b=$2} /^detached/{b="detached"}
  /^$/{if (w) print w, h, b; w=h=b=""} END{if (w) print w, h, b}' |
{
  read -r main _ _ # the first entry is the main checkout
  while read -r wt head branch; do
    [ "$wt" = "$main" ] || [ "$wt" = "$self" ] && continue
    gd=$(git -C "$wt" rev-parse --git-dir 2>/dev/null) || { echo "skip   $wt (unreadable)"; continue; }
    if [ -n "$(find "$gd/HEAD" "$gd/index" -mtime -1 2>/dev/null)" ]; then echo "keep   $wt (touched today)"; continue; fi
    reason=""
    if [ "$branch" = "detached" ]; then reason="detached, idle a day"
    elif git merge-base --is-ancestor "$head" origin/main 2>/dev/null; then reason="merged"
    elif ! git ls-remote --exit-code --heads origin "${branch#refs/heads/}" >/dev/null 2>&1; then reason="branch gone from origin"
    fi
    if [ -n "$reason" ]; then echo "remove $wt ($reason)"; run git worktree remove --force "$wt"
    else echo "keep   $wt (${branch#refs/heads/} still open)"; fi
  done
}
