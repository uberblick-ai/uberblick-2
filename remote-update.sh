#!/bin/sh
#
# Bring this host's checkout, and the containers running from it, to origin/main.
#
# Runs only when somebody means it: by hand on the host, or from
# `ub remote update <ssh-target>` — a person or an agent session over SSH.
# Nothing schedules it; there is no timer (owner decision, 2026-08-25).
#
# The comparison is against the last *successfully deployed* commit, recorded in
# refs/uberblick/deployed and moved only after a build exits 0 — never against
# HEAD. Resetting to origin/main and then failing the build would otherwise
# leave the checkout at the new commit, the containers at the old one, and every
# later run concluding it is current: one bad commit would wedge the host
# permanently.
#
# `git reset --hard` discards host-local edits to tracked files, deliberately:
# the host mirrors main and is not a place to edit. What it discarded is printed
# so the loss is visible rather than silent. The host's `.env` is untracked and
# survives — nothing here runs `git clean`.

set -eu

checkout=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
deployed_ref=refs/uberblick/deployed

# Outside the checkout, which this script rewrites underneath itself. The lock
# is what keeps a by-hand run and an `ub remote update` from colliding. The fd
# is held for the life of the script, so a run that is still building keeps it.
#
# Exactly one status means "another run holds it": `flock -n` answers a lock it
# could not acquire with 1, and reaches for anything else only when there is no
# lock to hold at all: 127 where the host has no flock, a sysexits code for an
# unusable descriptor or a filesystem that cannot lock. Answering those with
# "already running" is how a host without flock reported an update it never ran
# as a success, so they refuse here, before anything is fetched.
lock="${XDG_RUNTIME_DIR:-/tmp}/uberblick-update.lock"
exec 9>"$lock"
lock_status=0
flock -n 9 || lock_status=$?
if [ "$lock_status" -eq 1 ]; then
  printf 'uberblick-update: already running; nothing to do.\n'
  exit 0
fi
if [ "$lock_status" -ne 0 ]; then
  printf 'uberblick-update: cannot lock %s (flock exited %s); refusing to update.\n' \
    "$lock" "$lock_status" >&2
  exit 1
fi

cd "$checkout"

git fetch --quiet origin main
target=$(git rev-parse --verify origin/main)
deployed=$(git rev-parse --verify --quiet "$deployed_ref" || true)

if [ "$target" = "$deployed" ]; then
  printf 'uberblick-update: up to date at %s\n' "$target"
  exit 0
fi

discarded=$(git status --porcelain --untracked-files=no)
if [ -n "$discarded" ]; then
  printf 'uberblick-update: discarding host-local changes to tracked files:\n%s\n' "$discarded"
fi

printf 'uberblick-update: deploying %s (deployed: %s)\n' "$target" "${deployed:-none}"

# Load-bearing: this script is versioned in the repository, so the commit being
# deployed may replace the file that is executing right now. `git reset --hard`
# unlinks and recreates a changed file rather than truncating it in place, so
# the shell keeps reading from its original inode and this run finishes on the
# code it started with; the new version takes over on the next run.
git reset --hard --quiet "$target"

sh remote-compose.sh up --build --detach

# Only now, and only because the build exited 0.
git update-ref "$deployed_ref" "$target"
printf 'uberblick-update: deployed %s\n' "$target"
