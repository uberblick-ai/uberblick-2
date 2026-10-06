#!/bin/sh
#
# Put a backup taken by `bin/hub-backup.sh` back into this host's deployment. Run it
# in the deployment directory: `sh bin/hub-restore.sh ~/hub-2026-08-28.sqlite`.
#
# **Verified before anything is touched.** A restore runs on the worst day
# somebody has, against a file nobody has opened since it was written, and it
# overwrites the only copy left. So the backup is read first — `PRAGMA
# integrity_check` and documents or private access state, because a hub can
# hold identities, credentials, memberships, setup receipts or claim state before its first
# document. A truly empty database passes the pragma but restores nothing.
# The check runs inside the hub's own image through `node:sqlite`,
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
# **And it refuses to work around a rollback journal.** If `/data/hub.sqlite-*`
# exists after the stop, the database is mid-transaction and the journal is the
# half of it that says what to undo — one unit, and not one this script will take
# apart. Every way of getting the new file past it has a window where a failure
# leaves either a journal describing a database that is gone or a database
# stripped of the rollback it needs. So it stops there, touching nothing, and
# says the one thing that clears it: let SQLite recover the journal itself by
# starting the hub once and stopping it cleanly, then run the restore again.
#
# So: stop the hub (a non-zero exit is reported but does not block the restore —
# a hub that crashed on the way down is usually *why* somebody is restoring),
# check for a journal, stage the file, then one root container that owns it to
# `node` and renames it into place. The trap starts the hub again on every path
# after the stop — on the normal exit and on HUP/INT/TERM, because in POSIX `sh`
# an EXIT-only trap does not run when a signal kills the script — because
# `restart: unless-stopped` makes a manual stop survive a daemon restart. If
# both restart attempts fail the script exits non-zero however well the restore
# went.
#
# Every compose call goes through `bin/remote-compose.sh`, which resolves and checks
# this extracted hub release's settings.

set -eu

case "${1-}" in
  -h | --help)
    printf 'usage: sh bin/hub-restore.sh <backup-file>\n'
    exit 0
    ;;
esac

if [ $# -ne 1 ]; then
  printf 'usage: sh bin/hub-restore.sh <backup-file>\n' >&2
  exit 2
fi

# Resolved before the `cd` below, so a relative path means what the operator
# typed it in, not something inside the deployment directory.
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

deployment=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$deployment"

compose() {
  sh bin/remote-compose.sh "$@"
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
  // Older document-only backups need not have these private tables. Check
  // only known hub records, without reading their identities or signing keys.
  const hasPrivateAccessState = [
    "hub_principals", "hub_credentials", "hub_memberships", "hub_admin_setup_grants", "hub_claim_state",
  ].some((table) =>
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = ? AND name = ?").get("table", table) !== undefined &&
    db.prepare("SELECT 1 FROM " + table + " LIMIT 1").get() !== undefined
  );
  if (count < 1 && !hasPrivateAccessState) {
    console.error("the hub has no documents or private access state, so this empty backup would restore nothing");
    process.exit(1);
  }
  console.log("backup holds " + count + " documents" +
    (hasPrivateAccessState ? " and private access state" : "") + " and passes integrity_check");
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
  # Best effort, every one of them: a cleanup that fails must not skip the
  # restart below, which is the part somebody is depending on.
  if [ -n "$staged" ]; then
    staged=
    discard_staged || true
  fi
  if [ -n "$hub_stopped" ]; then
    hub_stopped=
    if ! compose start hub; then
      if ! compose up --detach hub; then
        printf 'hub-restore: THE HUB IS STILL DOWN. Start it with: sh bin/remote-compose.sh up --detach hub\n' >&2
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
hub_exit=0
for code in $codes; do
  if [ "$code" -ne 0 ]; then
    hub_exit=$code
  fi
done

# Reported whatever happens next, because it is true whatever happens next: the
# hub did not shut down cleanly, and the operator should hear that whether the
# restore then goes ahead or refuses.
if [ "$hub_exit" -ne 0 ]; then
  printf 'hub-restore: the hub exited %s, so it did not shut down cleanly.\n' "$hub_exit" >&2
fi

# A `hub.sqlite-journal` beside the database means SQLite was interrupted
# mid-transaction and the pair is one unit: the journal holds what the database
# has to undo. This script will not take that on. Replacing the database while
# its journal is there leaves a journal that describes a file which no longer
# exists; deleting the journal first strips the old database of the rollback it
# needs, and every variant of moving it out of the way has a window where a
# failure — or a Ctrl-C — leaves exactly one of those two states behind.
#
# So the restore refuses, and says how to clear it: SQLite recovers a journal
# itself, on the next clean open. Read-only; nothing in the volume is touched.
probe=0
compose run --rm --no-deps --entrypoint sh hub \
  -c 'for sidecar in /data/hub.sqlite-*; do if [ -e "$sidecar" ]; then exit 3; fi; done; exit 0' ||
  probe=$?

if [ "$probe" -eq 3 ]; then
  printf 'hub-restore: there is a rollback journal beside the hub database.\n' >&2
  printf 'hub-restore: nothing was copied and the volume was not touched. Let SQLite finish that transaction — start the hub once and stop it cleanly, then run this restore again:\n' >&2
  printf '  sh bin/remote-compose.sh up --detach hub\n  sh bin/remote-compose.sh stop hub\n  sh bin/hub-restore.sh %s\n' "$backup" >&2
  exit 1
fi

if [ "$probe" -ne 0 ]; then
  printf 'hub-restore: could not check the volume for a rollback journal (exit %s); nothing was copied and the volume was not touched.\n' "$probe" >&2
  exit 1
fi

staged=yes
if ! compose cp "$backup" hub:/data/hub.sqlite.restoring; then
  printf 'hub-restore: copying %s into the volume failed; the live database was NOT replaced.\n' "$backup" >&2
  exit 1
fi

# One container, as root, and only two things in it. `chown node:node` because
# `docker compose cp` carries the *host* file's ownership into the volume and the
# hub runs as the image's `node` user — a host account with any other uid would
# hand it a database it cannot open. Then the rename, which is the only moment
# `hub.sqlite` changes at all, and is a single atomic step within one filesystem.
# There is no sidecar to deal with here: the probe above refused if there was.
if ! compose run --rm --no-deps --user 0 --entrypoint sh hub \
  -c 'chown node:node /data/hub.sqlite.restoring && chmod 600 /data/hub.sqlite.restoring && mv -f /data/hub.sqlite.restoring /data/hub.sqlite'; then
  printf 'hub-restore: putting %s in place failed; the live database was NOT replaced.\n' "$backup" >&2
  exit 1
fi
staged=

printf 'hub-restore: restored %s into hub:/data/hub.sqlite\n' "$backup"
