#!/bin/sh
# Integrator housekeeping, run last (owner direction, 2026-09-01):
#   sh scripts/housekeeping.sh <review sha> [--dry-run]
# Docker — what fills the disk is one retained review image per run, so those go
#   once they are 24 hours old; this run's own image still goes at once.
#   Stopped containers and dangling layers go too. Build cache and unused images
#   are kept for a week (`until=168h`) so the next review still starts warm.
set -u
usage='usage: housekeeping.sh <review sha> [--dry-run]'
if [ "$#" -lt 1 ] || [ "$#" -gt 2 ]; then
  echo "$usage" >&2
  exit 2
fi
case $1 in
  -*) echo "$usage" >&2; exit 2 ;;
esac
sha=$1
dry=${2:-}
case $dry in
  ''|--dry-run) ;;
  *) echo "$usage" >&2; exit 2 ;;
esac
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
  older=$(image_list "docker image ls review images older than 24h" docker image ls -q --filter reference=uberblick-review --filter until=24h) || return 1
  older=$(printf '%s\n' "$older" | sort -u)
  [ -n "$older" ] && run docker image rm -f $older
  [ -n "$current" ] && run docker image rm -f "uberblick-review:$sha"
  return 0
}

review_images || failed=1
run docker container prune -f --filter until=168h
run docker image prune -f
run docker image prune -a -f --filter until=168h
run docker builder prune -f --filter until=168h

exit "$failed"
