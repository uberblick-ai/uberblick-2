#!/bin/sh
#
# Bring this host's checkout, and the containers running from it, to origin/main.
#
# Runs unattended on the remote host: from the `uberblick-update.timer` systemd
# user unit every five minutes, and from `ub remote update <ssh-target>` on
# demand. Polling, not a webhook — the host has no inbound port by design.
#
# The comparison is against the last *successfully deployed* commit, recorded in
# refs/uberblick/deployed and moved only after a build exits 0 — never against
# HEAD. Resetting to origin/main and then failing the build would otherwise
# leave the checkout at the new commit, the containers at the old one, and every
# later run concluding it is current: one bad commit would wedge the host
# permanently, with the only evidence in the journal.
#
# `git reset --hard` discards host-local edits to tracked files, deliberately:
# the host mirrors main and is not a place to edit. What it discarded is printed
# so the loss is visible rather than silent. The host's `.env` is untracked and
# survives — nothing here runs `git clean`.

set -eu

checkout=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
deployed_ref=refs/uberblick/deployed

# Outside the checkout, which this script rewrites underneath itself. systemd
# already refuses a second instance of the unit; this lock is what protects
# `ub remote update` racing a timer tick. The fd is held for the life of the
# script, so a run that is still building keeps it.
lock="${XDG_RUNTIME_DIR:-/tmp}/uberblick-update.lock"
exec 9>"$lock"
if ! flock -n 9; then
  printf 'uberblick-update: already running; nothing to do.\n'
  exit 0
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
# code it started with; the new version takes over on the next tick.
git reset --hard --quiet "$target"

sh remote-compose.sh up --build --detach

# Only now, and only because the build exited 0.
git update-ref "$deployed_ref" "$target"
printf 'uberblick-update: deployed %s\n' "$target"
