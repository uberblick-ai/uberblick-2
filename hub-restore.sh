#!/bin/sh
#
# Put a backup taken by `hub-backup.sh` back into this host's deployment. Run it
# in the host's checkout: `sh hub-restore.sh ~/hub-2026-08-28.sqlite`.
#
# **Verified before anything is touched.** A restore runs on the worst day
# somebody has, against a file nobody has opened since it was written, and it
# overwrites the only copy left. So the backup is read first — `PRAGMA
# integrity_check` and a non-empty `documents` table, because an empty but
# perfectly valid database passes the pragma and would restore a corpus of
# nothing. The check runs inside the hub's own image through `node:sqlite`,
# which is the module the hub itself persists with: the image is
# `node:26-bookworm-slim` and carries no `sqlite3` CLI, and this needs no new
# dependency anywhere. It writes the candidate to the container's `/tmp`, never
# to `/data`. A missing, corrupt or empty backup exits non-zero here, with the
# hub still running and the volume untouched.
#
# **And it never writes over the live database.** The candidate is copied in
# under a name the hub does not open, `/data/hub.sqlite.restoring`; only once
# that file is complete and owned correctly does a single `mv -f` put it in
# place, which within one filesystem is atomic. A copy that dies half way — a
# full disk, a killed daemon, an interrupted script — therefore leaves the
# database that is already there whole, and the script says so and exits
# non-zero rather than leaving a torn file where the hub will look. A `cp`
# straight onto `hub.sqlite` has no such moment.
#
# So: stop the hub (its exit code is reported — a hub that crashed on the way
# down is usually *why* somebody is restoring, so it does not block the
# restore), stage the file, then one root container that owns it to `node`,
# moves any rollback journal of the database being replaced *aside*, renames the
# staged file into place, and only then drops the aside copies — putting them
# back if the rename failed, so a database and the journal it needs are never
# separated. The trap starts the hub again on every path after the
# stop — on the normal exit and on HUP/INT/TERM, because in POSIX `sh` an
# EXIT-only trap does not run when a signal kills the script — because
# `restart: unless-stopped` makes a manual stop survive a daemon restart. If
# both restart attempts fail the script exits non-zero however well the restore
# went.
#
# Every compose call goes through `remote-compose.sh`: `docker-compose.yml`
# gates Caddy's secret on a variable only the wrapper exports and Compose
# interpolates the whole model for every subcommand, so a bare
# `docker compose stop hub` fails on this host.

set -eu

case "${1-}" in
  -h | --help)
    printf 'usage: sh hub-restore.sh <backup-file>\n'
    exit 0
    ;;
esac

if [ $# -ne 1 ]; then
  printf 'usage: sh hub-restore.sh <backup-file>\n' >&2
  exit 2
fi

# Resolved before the `cd` below, so a relative path means what the operator
# typed it in, not something inside the checkout.
backup=$1
case "$backup" in
  /*) ;;
  *) backup="$PWD/$backup" ;;
esac

if [ ! -f "$backup" ]; then
  printf 'hub-restore: %s is not a file; nothing was stopped and nothing was changed.\n' "$backup" >&2
  exit 1
fi

umask 077

checkout=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$checkout"

compose() {
  sh remote-compose.sh "$@"
}

# One argument for the container's `sh -c`: read the candidate off stdin, then
# let the hub's own SQLite say whether it is a database worth restoring.
verify_command=$(
  cat <<'CONTAINER'
set -e
cat > /tmp/uberblick-restore-check.sqlite
exec node -e '
const { DatabaseSync } = require("node:sqlite");
const path = "/tmp/uberblick-restore-check.sqlite";
try {
  const db = new DatabaseSync(path, { readOnly: true });
  const verdict = Object.values(db.prepare("PRAGMA integrity_check").get())[0];
  if (verdict !== "ok") {
    console.error("integrity_check says: " + verdict);
    process.exit(1);
  }
  const count = db.prepare("SELECT count(*) AS documents FROM documents").get().documents;
  if (count < 1) {
    console.error("the documents table is empty, so this backup would restore nothing");
    process.exit(1);
  }
  console.log("backup holds " + count + " documents and passes integrity_check");
} catch (error) {
  console.error("not a usable hub database: " + error.message);
  process.exit(1);
}
'
CONTAINER
)

if ! compose run --rm --no-deps -T --entrypoint sh hub -c "$verify_command" <"$backup"; then
  printf 'hub-restore: %s did not verify (see above); nothing was stopped and nothing was changed.\n' "$backup" >&2
  exit 1
fi

hub_stopped=
staged=

# Best effort, and deliberately not fatal: the staged file is inert — the hub
# never opens that name — so failing to remove it costs disk, not correctness.
discard_staged() {
  compose run --rm --no-deps --user 0 --entrypoint sh hub \
    -c 'rm -f /data/hub.sqlite.restoring' || true
}

# Takes the status to exit with, so the signal traps can report a failure the
# `$?` of an interrupted command would not.
finish() {
  # First, so a second Ctrl-C during the restart below cannot re-enter this and
  # leave the hub down while two copies of it argue about whose status wins.
  trap '' HUP INT TERM
  status=$1
  if [ -n "$staged" ]; then
    staged=
    discard_staged
  fi
  if [ -n "$hub_stopped" ]; then
    hub_stopped=
    if ! compose start hub; then
      if ! compose up --detach hub; then
        printf 'hub-restore: THE HUB IS STILL DOWN. Start it with: sh remote-compose.sh up --detach hub\n' >&2
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

ps_json=$(compose ps -a --format json hub)
codes=$(printf '%s\n' "$ps_json" | tr ',' '\n' |
  sed -n 's/.*"ExitCode":[[:space:]]*\([0-9][0-9]*\).*/\1/p')
for code in $codes; do
  if [ "$code" -ne 0 ]; then
    printf 'hub-restore: note — the hub exited %s, so whatever it held unflushed is gone. Restoring anyway: that is what the backup is for.\n' "$code" >&2
  fi
done

staged=yes
if ! compose cp "$backup" hub:/data/hub.sqlite.restoring; then
  printf 'hub-restore: copying %s into the volume failed; the live database was NOT replaced.\n' "$backup" >&2
  exit 1
fi

# One container, as root, for everything that must be true before the hub sees
# the file. The order is the whole of the correctness:
#
# - `chown node:node`, because `docker compose cp` carries the *host* file's
#   ownership into the volume and the hub runs as the image's `node` user — a
#   host account with any other uid would hand it a database it cannot open;
# - any sidecar of the database being replaced moved *aside*, not deleted. A
#   rollback journal belongs to the file it was written for: delete it and the
#   old database loses the half-finished transaction it needs to roll back, and
#   between that delete and the rename there is a window where a failure leaves
#   exactly that. Moving it aside keeps the pair together until the rename has
#   actually happened;
# - the rename, which is the only moment `hub.sqlite` changes at all;
# - and only then the aside files, dropped — a stale journal beside the restored
#   database would be replayed over the file that just arrived.
#
# If the rename fails the aside files go back where they were and the container
# exits non-zero, so the old database and its journal are found together.
place_command=$(
  cat <<'CONTAINER'
set -e
chown node:node /data/hub.sqlite.restoring
chmod 600 /data/hub.sqlite.restoring
for sidecar in /data/hub.sqlite-*; do
  if [ -e "$sidecar" ]; then mv -f "$sidecar" "$sidecar.aside"; fi
done
if mv -f /data/hub.sqlite.restoring /data/hub.sqlite; then
  rm -f /data/hub.sqlite-*.aside
else
  for aside in /data/hub.sqlite-*.aside; do
    if [ -e "$aside" ]; then mv -f "$aside" "${aside%.aside}"; fi
  done
  exit 1
fi
CONTAINER
)

if ! compose run --rm --no-deps --user 0 --entrypoint sh hub -c "$place_command"; then
  printf 'hub-restore: putting %s in place failed; the live database was NOT replaced.\n' "$backup" >&2
  exit 1
fi
staged=

printf 'hub-restore: restored %s into hub:/data/hub.sqlite\n' "$backup"
