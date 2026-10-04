#!/bin/sh
# Integrator housekeeping, run last (owner direction, 2026-09-01):
#   sh bin/housekeeping.sh <review sha>... [--dry-run]
# Docker — this run's review images go at once; other review images go after
#   24 hours. Dangling images go too, as does build cache older than a week. Cache is
#   also pruned for a free-space floor and capped at 1 GB by default (tunable via
#   HOUSEKEEPING_MIN_FREE and HOUSEKEEPING_MAX_USED_SPACE).
#   Containers, tagged non-review images, volumes and worktrees are left alone:
#   the production hub shares this host, including when it is stopped.
# On Docker Desktop for macOS, headroom is the host volume containing its default
#   sparse disk image, not the image's configured VM capacity. A moved image is
#   reported as unresolved rather than measuring a different filesystem.
# Every prune reports what it reclaimed, so a 0 B reclaim is visible in the run
# record instead of looking like success.
set -fu
usage='usage: sh bin/housekeeping.sh <review sha>... [--dry-run]'
if [ "$#" -lt 1 ]; then
  echo "$usage" >&2
  exit 2
fi
shas=
dry=
while [ "$#" -gt 0 ]; do
  case $1 in
    --dry-run)
      if [ "$#" -ne 1 ] || [ -z "$shas" ]; then
        echo "$usage" >&2
        exit 2
      fi
      dry=$1
      ;;
    -*) echo "$usage" >&2; exit 2 ;;
    *) shas="${shas}${shas:+ }$1" ;;
  esac
  shift
done

# Tunable, so a host with a different disk budget needs no edit here.
min_free=${HOUSEKEEPING_MIN_FREE:-5GB}
warn_free_gb=${HOUSEKEEPING_WARN_FREE_GB:-3}
max_used_space=${HOUSEKEEPING_MAX_USED_SPACE:-1GB}

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

# Same contract as run(), but reports the space the prune actually reclaimed.
prune() {
  if [ -n "$dry" ]; then
    echo "would: $*"
    return 0
  fi
  output=$("$@" 2>&1)
  status=$?
  if [ "$status" -ne 0 ]; then
    echo "housekeeping: failed ($status): $*" >&2
    failed=1
    return "$status"
  fi
  # `container`/`image prune` report "Total reclaimed space: X"; `builder prune`
  # reports "Total:<tab>X". Parse both, or the figure silently reads 0B.
  reclaimed=$(printf '%s\n' "$output" | sed -n -e 's/^Total reclaimed space: //p' -e 's/^Total:[[:space:]]*//p' | tail -1)
  [ -n "$reclaimed" ] || reclaimed="unparsed"
  echo "housekeeping: reclaimed $reclaimed: $*"
  return 0
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
  named=
  for sha in $shas; do
    current=$(image_list "docker image ls uberblick-review:$sha" docker image ls -q "uberblick-review:$sha") || return 1
    [ -n "$current" ] && named="${named}${named:+ }uberblick-review:$sha"
  done
  older=$(image_list "docker image ls review images older than 24h" docker image ls -q --filter reference=uberblick-review --filter until=24h) || return 1
  older=$(printf '%s\n' "$older" | sort -u)
  [ -n "$older" ] && run docker image rm -f $older
  [ -n "$named" ] && run docker image rm -f $named
  return 0
}

# Free space on the filesystem that actually holds the Docker root, which is not
# necessarily the one holding this checkout.
headroom() {
  root=$(docker info --format '{{.DockerRootDir}}' 2>/dev/null)
  status=$?
  if [ "$status" -ne 0 ] || [ -z "$root" ]; then
    echo "housekeeping: WARNING could not determine Docker root" >&2
    return 0
  fi
  location="docker root $root"
  operating_system=$(docker info --format '{{.OperatingSystem}}' 2>/dev/null)
  if [ "$operating_system" = "Docker Desktop" ]; then
    desktop_image=${HOME:+$HOME/Library/Containers/com.docker.docker/Data/vms/0/data/Docker.raw}
    if [ ! -f "$desktop_image" ]; then
      echo "housekeeping: WARNING could not determine Docker Desktop data location" >&2
      return 0
    fi
    root=$desktop_image
    location="Docker Desktop disk image $root"
  elif [ ! -d "$root" ]; then
    echo "housekeeping: WARNING could not determine Docker root" >&2
    return 0
  fi
  line=$(df -Pk "$root" 2>/dev/null | awk 'NR==2{print $1, $4}')
  if [ -z "$line" ]; then
    echo "housekeeping: WARNING could not determine filesystem for $location" >&2
    return 0
  fi
  fs=${line% *}
  free_kb=${line#* }
  free_gb=$(( free_kb / 1024 / 1024 ))
  if [ "$free_gb" -lt "$warn_free_gb" ]; then
    echo "housekeeping: WARNING low disk: $fs has ${free_gb}GB free under ${warn_free_gb}GB threshold ($location)" >&2
  else
    echo "housekeeping: disk ok: $fs has ${free_gb}GB free (threshold ${warn_free_gb}GB)"
  fi
}

review_images || failed=1
prune docker image prune -f
prune docker builder prune -f --filter until=168h
prune docker builder prune -f --min-free-space "$min_free"
prune docker builder prune -f --max-used-space "$max_used_space"
headroom

exit "$failed"
