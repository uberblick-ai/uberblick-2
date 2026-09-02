#!/bin/sh
#
# Bring this host's checkout, and the containers running from it, to origin/main.
#
# Runs only when somebody means it: by hand on the host, from
# `ub remote update <ssh-target>`, or through the internal mode an explicit
# `ub remote init` re-run uses. Nothing schedules it; there is no timer (owner
# decision, 2026-08-25).
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
# survives ordinary updates — nothing here runs `git clean`; only the init
# re-run mode explicitly replaces it with the configuration received on stdin.

mode=update
case "${1-}" in
  "") ;;
  --remote-init-rerun) mode=remote-init-rerun ;;
  *)
    printf 'usage: sh remote-update.sh [--remote-init-rerun]\n' >&2
    exit 2
    ;;
esac

set -u

checkout=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
deployed_ref=refs/uberblick/deployed

# The lock is the checkout directory itself, because one checkout is exactly
# what two runs must not rewrite and build at once. A path under
# `$XDG_RUNTIME_DIR` excluded only runs that shared a session, so a sudoed
# by-hand run and an `ub remote update` each took their own lock and both built
# (#574); a path keyed to the host would tell the mirror-image lie, and two
# independent checkouts would report "already running" having deployed nothing.
# The directory outlives the `git reset --hard` below, which rewrites the files
# under it and not the directory, and opening it for *reading* is enough to lock
# it — so a run never needs to own a lock file some other user created first.
# The fd is held for the life of the script, so a run that is still building
# keeps it.
#
# Contention is told apart from a broken lock by a status nothing else answers
# with. `-E` makes flock report "somebody else holds it" as 100, so 0 is ours,
# 100 is theirs, and every other status is the lock failing to exist rather than
# being busy: 127 where the host has no flock, a sysexits code for an unusable
# descriptor or a filesystem that cannot lock, and 1 from a flock that reports
# every failure that way (busybox) or does not understand `-E` at all. Reading
# any of those as "already running" is how a host without flock reported an
# update it never ran as a success, so they refuse, before anything is fetched.
busy=100
exec 9<"$checkout"
lock_status=0
flock -n -E "$busy" 9 || lock_status=$?
if [ "$lock_status" -eq "$busy" ]; then
  if [ "$mode" = remote-init-rerun ]; then exit "$busy"; fi
  printf 'uberblick-update: already running; nothing to do.\n'
  exit 0
fi
if [ "$lock_status" -ne 0 ]; then
  if [ "$mode" = remote-init-rerun ]; then exit 101; fi
  printf 'uberblick-update: cannot lock %s (flock exited %s); refusing to update.\n' \
    "$checkout" "$lock_status" >&2
  exit 1
fi

cd "$checkout"

# An existing `ub remote init` checkout uses this internal mode so its fetch,
# replacement `.env`, build and deployed ref share this script's one lock. Read
# the secret-bearing stdin into a private staging file before any child runs;
# no later command inherits payload bytes it could mistake for its own input.
# Each failure has a reserved status so the local CLI can name the cause in its
# own words without relaying bytes from the secret-bearing SSH connection.
if [ "$mode" = remote-init-rerun ]; then
  staged_env=.env.uberblick-init
  umask 077
  trap 'rm -f "$staged_env"' 0 HUP INT TERM
  cat > "$staged_env" || exit 103
  chmod 600 "$staged_env" || exit 103

  git config core.sshCommand 'ssh -i ~/.ssh/uberblick-deploy -o IdentitiesOnly=yes' || exit 102
  git fetch --quiet origin main || exit 102
  git merge --ff-only origin/main || exit 102
  mv "$staged_env" .env || exit 103
  sh remote-compose.sh up --build --detach || exit 104
  git update-ref "$deployed_ref" HEAD || exit 105
  exit 0
fi

set -e

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
