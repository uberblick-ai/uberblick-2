#!/bin/sh
#
# Copy the hub's SQLite database out of this host's deployment, into a file you
# name. Run it in the host's checkout: `sh hub-backup.sh ~/hub-2026-08-28.sqlite`.
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
# Every compose call goes through `remote-compose.sh`. That is not a style
# choice: `docker-compose.yml` gates Caddy's secret on a variable only the
# wrapper exports, and Compose interpolates the whole model for every
# subcommand, so a bare `docker compose stop hub` fails on this host.
#
# The hub is restarted from an EXIT trap on every path after the stop. With
# `restart: unless-stopped`, a manual stop survives a daemon restart, so a run
# that died between the stop and the start would leave the hub down for good.
#
# While the hub is stopped, Caddy stays up and clients keep working: they edit
# offline against their own replicas and converge when the socket comes back.

set -eu

case "${1-}" in
  -h | --help)
    printf 'usage: sh hub-backup.sh <target-file>\n'
    exit 0
    ;;
esac

if [ $# -ne 1 ]; then
  printf 'usage: sh hub-backup.sh <target-file>\n' >&2
  exit 2
fi

# Resolved before the `cd` below, so a relative path means what the operator
# typed it in, not something inside the checkout.
target=$1
case "$target" in
  /*) ;;
  *) target="$PWD/$target" ;;
esac

# The file is every document in the corpus. Nothing this script creates is
# readable by anyone else, not even for the instant before the chmod.
umask 077

checkout=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$checkout"

compose() {
  sh remote-compose.sh "$@"
}

hub_stopped=

restart_hub() {
  if [ -n "$hub_stopped" ]; then
    hub_stopped=
    if ! compose start hub; then
      if ! compose up --detach hub; then
        printf 'hub-backup: THE HUB IS STILL DOWN. Start it with: sh remote-compose.sh up --detach hub\n' >&2
      fi
    fi
  fi
}

# Set before the stop is issued, not after it succeeds: a stop that fails
# halfway has still taken the container down.
hub_stopped=yes
trap restart_hub EXIT
compose stop hub

# `tr` splits the object into one field per line so the code is read whether
# Compose prints an array or one JSON object per line, and whether there is one
# container or several.
status=$(compose ps -a --format json hub)
codes=$(printf '%s\n' "$status" | tr ',' '\n' |
  sed -n 's/.*"ExitCode":[[:space:]]*\([0-9][0-9]*\).*/\1/p')

if [ -z "$codes" ]; then
  printf 'hub-backup: could not read the hub container exit code from `compose ps -a --format json hub`; no backup written.\n' >&2
  exit 1
fi

for code in $codes; do
  if [ "$code" -ne 0 ]; then
    printf 'hub-backup: the hub exited %s, so its shutdown flush did not complete and the database may be missing recent edits; no backup written. Check `sh remote-compose.sh logs hub`.\n' "$code" >&2
    exit 1
  fi
done

compose cp hub:/data/hub.sqlite "$target"
# `umask` does not reach this file: `docker compose cp` reproduces the mode the
# file has in the container. The hub creates its database 0600 and this keeps
# the copy there whatever the container end turns out to hold.
chmod 600 "$target"

printf 'hub-backup: wrote %s\n' "$target"
