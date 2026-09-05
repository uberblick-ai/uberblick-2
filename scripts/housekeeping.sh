#!/bin/sh
# Integrator housekeeping, run last (owner direction, 2026-09-01):
#   sh scripts/housekeeping.sh <review sha>... [--dry-run]
# Docker — every review image this run built goes at once; other review images
#   go once they are 24 hours old.
#   Stopped containers and dangling layers go too. Build cache and unused images
#   are kept for a week (`until=168h`) so the next review still starts warm —
#   but a review build regenerates the cache on every run, so almost nothing is
#   ever that old and the time filter alone reclaims nothing (#785). A space
#   floor prunes the cache only once free space actually falls below it.
# Worktrees — an agent run removes its own, so abandoned ones accumulate. Old
#   ones go here, never with `--force`: a locked worktree, or one holding
#   modified or untracked files, is reported and left for a human.
#   Clean detached worktrees are removable: durable recovery is a remote commit
#   or PR, never an unreferenced local commit (`AGENTS.md`, Claim and recovery).
# On Docker Desktop for macOS, headroom is the host volume containing its default
#   sparse disk image, not the image's configured VM capacity. A moved image is
#   reported as unresolved rather than measuring a different filesystem.
# Every prune reports what it reclaimed, so a 0 B reclaim is visible in the run
# record instead of looking like success.
set -fu
usage='usage: housekeeping.sh <review sha>... [--dry-run]'
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
worktree_max_age_h=${HOUSEKEEPING_WORKTREE_MAX_AGE_H:-24}

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

# Why `git worktree remove` would refuse, so --dry-run predicts the same set the
# real run acts on rather than over-promising. Empty output means removable.
worktree_blocked() {
  wt=$1
  admin=$(git -C "$wt" rev-parse --git-dir 2>/dev/null) || {
    echo "worktree status unavailable"
    return 0
  }
  [ -e "$admin/locked" ] && {
    echo "locked"
    return 0
  }
  status_output=$(GIT_OPTIONAL_LOCKS=0 git -C "$wt" status --porcelain 2>/dev/null)
  status=$?
  if [ "$status" -ne 0 ]; then
    echo "worktree status unavailable"
  elif [ -n "$status_output" ]; then
    echo "modified or untracked files"
  fi
}

# Abandoned agent worktrees. `git worktree prune` cannot help: their directories
# still exist, so they must be removed by path.
stale_worktrees() {
  now=$(date +%s)
  current=$(pwd -P)
  git worktree list --porcelain 2>/dev/null | sed -n 's/^worktree //p' | while IFS= read -r wt; do
    case $wt in
      */.claude/worktrees/*) ;;
      *) continue ;;
    esac
    [ -d "$wt" ] || continue
    # Never remove the worktree this run is executing from.
    case $current in
      "$wt"|"$wt"/*) continue ;;
    esac
    mtime=$(stat -c %Y "$wt" 2>/dev/null) || continue
    age_h=$(( (now - mtime) / 3600 ))
    [ "$age_h" -ge "$worktree_max_age_h" ] || continue
    if [ -n "$dry" ]; then
      blocked=$(worktree_blocked "$wt")
      if [ -n "$blocked" ]; then
        echo "would keep (${age_h}h old): $wt -- $blocked"
      else
        echo "would: git worktree remove $wt (${age_h}h old)"
      fi
      continue
    fi
    if out=$(git worktree remove "$wt" 2>&1); then
      echo "housekeeping: removed worktree (${age_h}h old): $wt"
    else
      echo "housekeeping: kept worktree (${age_h}h old): $wt -- $(printf '%s' "$out" | head -1)"
    fi
  done
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
  if [ ! -d "$root" ]; then
    operating_system=$(docker info --format '{{.OperatingSystem}}' 2>/dev/null)
    if [ "$?" -ne 0 ] || [ "$operating_system" != "Docker Desktop" ]; then
      echo "housekeeping: WARNING could not determine Docker root" >&2
      return 0
    fi
    desktop_image=
    if [ -n "${HOME:-}" ]; then
      desktop_image="$HOME/Library/Containers/com.docker.docker/Data/vms/0/data/Docker.raw"
    fi
    if [ -z "$desktop_image" ] || [ ! -f "$desktop_image" ]; then
      echo "housekeeping: WARNING could not determine Docker Desktop data location" >&2
      return 0
    fi
    root=$desktop_image
    location="Docker Desktop disk image $root"
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
prune docker container prune -f --filter until=168h
prune docker image prune -f
prune docker image prune -a -f --filter until=168h
prune docker builder prune -f --filter until=168h
prune docker builder prune -f --min-free-space "$min_free"
stale_worktrees
headroom

exit "$failed"
