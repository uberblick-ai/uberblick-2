#!/bin/sh
#
# Copy the hub's SQLite database out of this host's deployment, into a file you
# name. Run it in the deployment directory: `sh bin/hub-backup.sh ~/hub-2026-08-28.sqlite`.
#
# **Stop, then copy.** Hocuspocus debounces the store (2s, at most 10s; the hub
# leaves both at their defaults), so a document edited a moment ago may exist
# only in memory. The one flush an operator can reach is a shutdown: SIGTERM
# makes the hub flush every pending update and close the database, and it exits
# non-zero if any store failed. `stop_grace_period: 30s` already exceeds that
# 10s ceiling, so the flush has room to finish. Copying a *live* file instead
# would take whatever SQLite happened to have written, mid-transaction and
# without the pending updates — a file that opens cleanly and is missing work.
#
# `docker compose stop` exits 0 whatever the container did, so the hub's own
# verdict is read separately, from `ps -a --format json` → `ExitCode`. A
# non-zero code — including 137, the grace period expiring — means the flush did
# not complete, and no file is written at all: a backup nobody can trust is
# worse than none, because it is the one that gets restored.
#
# Every compose call goes through `bin/remote-compose.sh`, which resolves and checks
# this extracted hub release's settings.
#
# The hub is restarted from a trap on every path after the stop — on the normal
# exit and on HUP/INT/TERM, because in POSIX `sh` an EXIT-only trap does not run
# when a signal kills the script. With `restart: unless-stopped`, a manual stop
# survives a daemon restart, so a run that died between the stop and the start
# would leave the hub down for good. If both restart attempts fail the script
# exits non-zero however well the copy went: a backup taken at the price of a
# hub nobody noticed is not a success.
#
# The file appears at its name only once it is whole. The copy goes to a
# temporary sibling and is renamed onto the target, so an interrupted run leaves
# the previous backup exactly as it was rather than a truncated file wearing its
# name.
#
# While the hub is stopped, Caddy stays up and clients keep working: they edit
# offline against their own replicas and converge when the socket comes back.

set -eu

case "${1-}" in
  -h | --help)
    printf 'usage: sh bin/hub-backup.sh <target-file>\n'
    exit 0
    ;;
esac

if [ $# -ne 1 ]; then
  printf 'usage: sh bin/hub-backup.sh <target-file>\n' >&2
  exit 2
fi

# Resolved before the `cd` below, so a relative path means what the operator
# typed it in, not something inside the deployment directory.
target=$1
case "$target" in
  /*) ;;
  *) target="$PWD/$target" ;;
esac

# Checked before the hub is touched, so a mistyped path costs nobody an outage.
# A directory is the one that would otherwise half-work: Compose would copy
# `hub.sqlite` *into* it and the chmod would then strip the directory's execute
# bits, leaving no backup and a directory nobody can enter.
if [ -d "$target" ]; then
  printf 'hub-backup: %s is a directory — name the file to write. Nothing was stopped.\n' "$target" >&2
  exit 2
fi

parent=$(dirname -- "$target")
if [ ! -d "$parent" ] || [ ! -w "$parent" ]; then
  printf 'hub-backup: %s is not a directory this user can write to. Nothing was stopped.\n' "$parent" >&2
  exit 2
fi

# The file is every document in the corpus. Nothing this script creates is
# readable by anyone else, not even for the instant before the chmod.
umask 077

deployment=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$deployment"

compose() {
  sh bin/remote-compose.sh "$@"
}

hub_stopped=
temp=

# Takes the status to exit with, so the signal traps can report a failure the
# `$?` of an interrupted command would not.
finish() {
  # First, so a second Ctrl-C during the restart below cannot re-enter this and
  # leave the hub down while two copies of it argue about whose status wins.
  trap '' HUP INT TERM
  status=$1
  # A half-copied file, killed mid-copy, is not something to leave lying next to
  # the backups. Gone by the time the target is looked at either way — and best
  # effort, because a cleanup that fails must not skip the restart below, which
  # is the part somebody is depending on.
  if [ -n "$temp" ]; then
    rm -f "$temp" || true
  fi
  if [ -n "$hub_stopped" ]; then
    hub_stopped=
    if ! compose start hub; then
      if ! compose up --detach hub; then
        printf 'hub-backup: THE HUB IS STILL DOWN. Start it with: sh bin/remote-compose.sh up --detach hub\n' >&2
        if [ "$status" -eq 0 ]; then
          status=1
        fi
      fi
    fi
  fi
  trap - 0
  exit "$status"
}

# Set before the stop is issued, not after it succeeds: a stop that fails
# halfway has still taken the container down.
hub_stopped=yes
trap 'finish $?' 0
trap 'finish 1' HUP INT TERM
compose stop hub

# `tr` splits the object into one field per line so the code is read whether
# Compose prints an array or one JSON object per line, and whether there is one
# container or several.
ps_json=$(compose ps -a --format json hub)
codes=$(printf '%s\n' "$ps_json" | tr ',' '\n' |
  sed -n 's/.*"ExitCode":[[:space:]]*\([0-9][0-9]*\).*/\1/p')

if [ -z "$codes" ]; then
  printf 'hub-backup: could not read the hub container exit code from `compose ps -a --format json hub`; no backup written.\n' >&2
  exit 1
fi

for code in $codes; do
  if [ "$code" -ne 0 ]; then
    printf 'hub-backup: the hub exited %s, so its shutdown flush did not complete and the database may be missing recent edits; no backup written. Check `sh bin/remote-compose.sh logs hub`.\n' "$code" >&2
    exit 1
  fi
done

# A sibling, so the rename below is within one filesystem and therefore atomic.
temp="$target.tmp.$$"
rm -f "$temp"

# Every exit from here on removes the temporary file — `finish` does it, so the
# signal paths are covered by the same line as the failure paths.
if ! compose cp hub:/data/hub.sqlite "$temp"; then
  printf 'hub-backup: copying the database out of the container failed; %s is unchanged.\n' "$target" >&2
  exit 1
fi

# `umask` does not reach this file: `docker compose cp` reproduces the mode the
# file has in the container. The hub creates its database 0600 and this keeps
# the copy there whatever the container end turns out to hold — and it is set
# before the rename, so the file is never readable by anyone else under the name
# an operator will reach for.
if ! chmod 600 "$temp" || ! mv -f "$temp" "$target"; then
  printf 'hub-backup: could not put the copy in place at %s; it is unchanged.\n' "$target" >&2
  exit 1
fi

printf 'hub-backup: wrote %s\n' "$target"
