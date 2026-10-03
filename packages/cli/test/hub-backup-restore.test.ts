/**
 * `bin/hub-backup.sh` and `bin/hub-restore.sh`, run for real.
 *
 * These two scripts are the only thing standing between a bad day and a lost
 * corpus, so the properties worth defending are the refusals: a backup must not
 * be written when the hub's shutdown flush failed, and a restore must not touch
 * the volume for a file it has not read. Neither survives being mocked, so the
 * scripts are run as themselves against a stub `bin/remote-compose.sh` — the wrapper
 * is the only thing a checkout ever drives Docker through, which is exactly why
 * it is the seam (`remote-update.test.ts` uses the same one). No Docker runs
 * here.
 *
 * Nothing the scripts hand the hub image is faked either. The stub executes the
 * `sh -c` payload it is given, with the container paths rewritten into the
 * sandbox: the verification runs under the real `node`, so `PRAGMA
 * integrity_check` and the document/access-state checks use the same
 * `node:sqlite` the hub persists with; the placement payload runs against a
 * directory standing in for the volume, so its ordering, its globs and its
 * failure handling are the script's own. Only `chown` is answered rather than
 * executed — the container is root and the test runner is not.
 */

import { spawnSync } from "node:child_process";
import type { SpawnSyncReturns } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, describe, expect, it } from "vitest";
import { REPO_ROOT, removeTempDirs, sandbox } from "./helpers.js";

afterAll(removeTempDirs);

/**
 * Stands in for the compose wrapper.
 *
 * `ps` answers with the shape Compose prints and the exit code the test asked
 * for; `cp` moves real bytes, and models `docker compose cp` reproducing the
 * mode of the file it copied rather than obeying the caller's umask — which is
 * why the backup script's own `chmod` is what the 0600 assertion proves; `run`
 * with a `node -e` payload is the verification, executed for real.
 */
const COMPOSE_STUB = `#!/bin/sh
printf '%s' "$*" | tr '\\n' ' ' >> "$UB_TEST_COMPOSE_LOG"
printf '\\n' >> "$UB_TEST_COMPOSE_LOG"

case "$1" in
  ps)
    if [ "\${UB_TEST_HUB_EXIT:-0}" = "none" ]; then
      printf '{"Name":"uberblick-remote-hub-1","Service":"hub","State":"exited"}\\n'
    else
      printf '{"Name":"uberblick-remote-hub-1","Service":"hub","State":"exited","ExitCode":%s}\\n' \\
        "\${UB_TEST_HUB_EXIT:-0}"
    fi
    ;;
  start | up)
    if [ -n "\${UB_TEST_START_FAIL:-}" ]; then exit 1; fi
    ;;
  cp)
    if [ -n "\${UB_TEST_CP_FAIL:-}" ]; then exit 1; fi
    case "$2" in
      hub:*)
        cp "$UB_TEST_VOLUME/hub.sqlite" "$3"
        chmod 644 "$3"
        ;;
      *)
        cp "$2" "$UB_TEST_VOLUME/\${3#hub:/data/}"
        ;;
    esac
    ;;
  run)
    for payload in "$@"; do :; done
    case "$payload" in
      *"node -e"*)
        script=$(printf '%s' "$payload" |
          sed "s#/tmp/uberblick-restore-check.sqlite#$UB_TEST_VERIFY_DB#g")
        PATH="$UB_TEST_NODE_DIR:$PATH" sh -c "$script"
        exit $?
        ;;
      *"rm -f /data/hub.sqlite.restoring"*)
        if [ -n "\${UB_TEST_DISCARD_FAIL:-}" ]; then exit 1; fi
        rm -f "$UB_TEST_VOLUME/hub.sqlite.restoring"
        ;;
      *)
        # The payload verbatim, with /data pointing at the directory standing in
        # for the volume — so the ordering, the globs and the failure handling
        # under test are the script's own and not this stub's idea of them.
        # UB_TEST_BIN holds a chown that always succeeds (the container is root;
        # the test runner is not).
        script=$(printf '%s' "$payload" | sed "s#/data#$UB_TEST_VOLUME#g")
        PATH="$UB_TEST_BIN:$PATH" sh -c "$script"
        exit $?
        ;;
    esac
    ;;
esac
exit 0
`;

/**
 * The container runs as root and the test runner does not, so `chown` is the one
 * command in the payload that cannot be executed for real. It is answered rather
 * than edited out, which keeps the payload the script's own text.
 */
const CHOWN_STUB = `#!/bin/sh
exit 0
`;

interface Fixture {
  /** The stand-in host checkout the scripts run from. */
  checkout: string;
  /** Stands in for the `hub-data` volume: what `cp` copies out of and into. */
  volume: string;
  composeLog: string;
  env: NodeJS.ProcessEnv;
}

function fixture(): Fixture {
  const box = sandbox();
  const checkout = box.cwd;
  const volume = join(checkout, "volume");
  mkdirSync(volume, { recursive: true });

  mkdirSync(join(checkout, "bin"));
  writeFileSync(join(checkout, "bin", "remote-compose.sh"), COMPOSE_STUB, { mode: 0o755 });
  // The real scripts, verbatim — the files under test.
  for (const script of ["hub-backup.sh", "hub-restore.sh"]) {
    copyFileSync(join(REPO_ROOT, "bin", script), join(checkout, "bin", script));
  }

  const stubs = join(checkout, "stubs");
  mkdirSync(stubs, { recursive: true });
  writeFileSync(join(stubs, "chown"), CHOWN_STUB, { mode: 0o755 });

  return {
    checkout,
    volume,
    composeLog: join(checkout, "compose.log"),
    env: {
      ...box.env,
      UB_TEST_COMPOSE_LOG: join(checkout, "compose.log"),
      UB_TEST_VOLUME: volume,
      UB_TEST_VERIFY_DB: join(checkout, "verify.sqlite"),
      UB_TEST_NODE_DIR: dirname(process.execPath),
      UB_TEST_BIN: stubs,
    },
  };
}

/** Write a hub-shaped SQLite database with `rows` documents in it. */
function hubDatabase(path: string, rows: number, privateTables = false): void {
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE "documents" ("name" varchar(255) NOT NULL, "data" blob NOT NULL, UNIQUE(name))`);
  const insert = db.prepare(`INSERT INTO "documents" ("name", "data") VALUES ($name, $data)`);
  for (let index = 0; index < rows; index += 1) {
    insert.run({ name: `workspace/doc-${index}`, data: new Uint8Array([1, 2, 3]) });
  }
  // Backup/restore treats these records as opaque bytes. Use the hub's table
  // shapes without importing its authority into a client package.
  if (privateTables) db.exec(`
    CREATE TABLE hub_principals (
      id TEXT PRIMARY KEY NOT NULL, github_account_id TEXT UNIQUE NOT NULL,
      github_username TEXT NOT NULL
    );
    CREATE TABLE hub_credentials (
      id TEXT PRIMARY KEY NOT NULL, principal_id TEXT NOT NULL,
      device_id TEXT NOT NULL, workspaces TEXT NOT NULL,
      signing_key BLOB NOT NULL CHECK(length(signing_key) = 32),
      issued_at INTEGER NOT NULL, revoked_at INTEGER
    );
    CREATE TABLE hub_memberships (
      workspace_id TEXT NOT NULL, principal_id TEXT NOT NULL CHECK(length(principal_id) > 0),
      role TEXT NOT NULL CHECK(role IN ('admin', 'member')), PRIMARY KEY (workspace_id, principal_id)
    );
    CREATE TABLE hub_admin_setup_grants (
      setup_id TEXT PRIMARY KEY NOT NULL, workspace_id TEXT NOT NULL,
      principal_id TEXT NOT NULL, github_account_id TEXT NOT NULL,
      github_username TEXT NOT NULL, had_documents INTEGER NOT NULL CHECK(had_documents IN (0, 1))
    );
  `);
  db.close();
}

function run(fix: Fixture, script: string, args: string[]): SpawnSyncReturns<string> {
  return spawnSync("sh", [join(fix.checkout, "bin", script), ...args], {
    cwd: fix.checkout,
    encoding: "utf8",
    env: fix.env,
    timeout: 20_000,
  });
}

/** Every wrapper invocation so far, one per line. */
function calls(fix: Fixture): string[] {
  if (!existsSync(fix.composeLog)) return [];
  return readFileSync(fix.composeLog, "utf8").trimEnd().split("\n").filter(Boolean);
}

/** Just the subcommands, which is what the ordering assertions are about. */
function subcommands(fix: Fixture): string[] {
  return calls(fix).map((line) => line.split(" ")[0] ?? "");
}

function mode(path: string): string {
  return (statSync(path).mode & 0o777).toString(8);
}

describe("bin/hub-backup.sh", () => {
  it("stops, reads the exit code, copies and starts again — at mode 0600", () => {
    const fix = fixture();
    hubDatabase(join(fix.volume, "hub.sqlite"), 3);
    const target = join(fix.checkout, "backup.sqlite");

    const ran = run(fix, "hub-backup.sh", [target]);

    expect(ran.status).toBe(0);
    expect(subcommands(fix)).toEqual(["stop", "ps", "cp", "start"]);
    expect(calls(fix)[0]).toBe("stop hub");
    // Copied to a temporary sibling and renamed, so the target never wears a
    // half-written file's name.
    expect(calls(fix)[2]).toMatch(
      new RegExp(`^cp hub:/data/hub\\.sqlite ${target}\\.tmp\\.[0-9]+$`),
    );
    expect(mode(target)).toBe("600");
    expect(readFileSync(target)).toEqual(readFileSync(join(fix.volume, "hub.sqlite")));
  });

  /**
   * The hub exits non-zero when its shutdown flush failed, and `docker compose
   * stop` reports 0 regardless — so this is the only thing between an operator
   * and a backup that is quietly missing the last edits.
   */
  it("writes no file when the hub's exit code is non-zero, and starts it again", () => {
    const fix = fixture();
    hubDatabase(join(fix.volume, "hub.sqlite"), 3);
    fix.env.UB_TEST_HUB_EXIT = "137";

    const refused = run(fix, "hub-backup.sh", [join(fix.checkout, "backup.sqlite")]);

    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toContain("137");
    expect(existsSync(join(fix.checkout, "backup.sqlite"))).toBe(false);
    expect(subcommands(fix)).toEqual(["stop", "ps", "start"]);
  });

  /** An interrupted copy must not leave a truncated file wearing the backup's name. */
  it("leaves the previous backup untouched when the copy fails", () => {
    const fix = fixture();
    hubDatabase(join(fix.volume, "hub.sqlite"), 3);
    const target = join(fix.checkout, "backup.sqlite");
    writeFileSync(target, "the backup from yesterday", "utf8");
    fix.env.UB_TEST_CP_FAIL = "1";

    const ran = run(fix, "hub-backup.sh", [target]);

    expect(ran.status).not.toBe(0);
    expect(readFileSync(target, "utf8")).toBe("the backup from yesterday");
    expect(subcommands(fix)).toEqual(["stop", "ps", "cp", "start"]);
  });

  it("refuses a target that is a directory, before stopping anything", () => {
    const fix = fixture();
    hubDatabase(join(fix.volume, "hub.sqlite"), 3);
    const target = join(fix.checkout, "a-directory");
    mkdirSync(target);
    // Whatever `0o777 & ~umask` made it on this runner. The behaviour worth
    // defending is that the refusal leaves the directory exactly as it found
    // it — the script's own comment names the failure mode: a chmod here
    // would strip the execute bits and leave a directory nobody can enter.
    // An absolute mode would assert the runner's umask instead.
    const before = mode(target);

    const ran = run(fix, "hub-backup.sh", [target]);

    expect(ran.status).not.toBe(0);
    expect(ran.stderr).toContain("Nothing was stopped");
    expect(calls(fix)).toEqual([]);
    expect(mode(target)).toBe(before);
  });

  /** A backup taken at the price of a hub nobody noticed is not a success. */
  /**
   * A `ps` answer with no `ExitCode` in it is not a zero: the hub's verdict was
   * not read, so there is nothing to say the file is trustworthy.
   */
  it("writes no file when the exit code cannot be read at all", () => {
    const fix = fixture();
    hubDatabase(join(fix.volume, "hub.sqlite"), 3);
    fix.env.UB_TEST_HUB_EXIT = "none";

    const ran = run(fix, "hub-backup.sh", [join(fix.checkout, "backup.sqlite")]);

    expect(ran.status).not.toBe(0);
    expect(ran.stderr).toContain("could not read the hub container exit code");
    expect(existsSync(join(fix.checkout, "backup.sqlite"))).toBe(false);
    expect(subcommands(fix)).toEqual(["stop", "ps", "start"]);
  });

  it("exits non-zero, loudly, when the hub cannot be started again", () => {
    const fix = fixture();
    hubDatabase(join(fix.volume, "hub.sqlite"), 3);
    fix.env.UB_TEST_START_FAIL = "1";

    const ran = run(fix, "hub-backup.sh", [join(fix.checkout, "backup.sqlite")]);

    expect(ran.status).not.toBe(0);
    expect(ran.stderr).toContain("THE HUB IS STILL DOWN");
    expect(subcommands(fix)).toEqual(["stop", "ps", "cp", "start", "up"]);
  });
});

describe("bin/hub-restore.sh", () => {
  it("refuses a backup that is not there, without stopping the hub", () => {
    const fix = fixture();
    const ran = run(fix, "hub-restore.sh", [join(fix.checkout, "absent.sqlite")]);

    expect(ran.status).not.toBe(0);
    expect(calls(fix)).toEqual([]);
  });

  it("refuses a corrupt backup, without stopping the hub or touching the volume", () => {
    const fix = fixture();
    const backup = join(fix.checkout, "corrupt.sqlite");
    writeFileSync(backup, Buffer.from(Array.from({ length: 4096 }, (_, i) => (i * 37) % 251)));

    const ran = run(fix, "hub-restore.sh", [backup]);

    expect(ran.status).not.toBe(0);
    expect(subcommands(fix)).toEqual(["run"]);
    expect(existsSync(join(fix.volume, "hub.sqlite"))).toBe(false);
  });

  /** Empty private tables do not make an empty hub worth restoring. */
  it.each(["legacy", "current"])("refuses a truly empty %s hub without touching the live database", (schema) => {
    const fix = fixture();
    const live = join(fix.volume, "hub.sqlite");
    hubDatabase(live, 3);
    const before = readFileSync(live);
    const backup = join(fix.checkout, "empty.sqlite");
    hubDatabase(backup, 0, schema === "current");

    const ran = run(fix, "hub-restore.sh", [backup]);

    expect(ran.status).not.toBe(0);
    expect(ran.stderr).toContain("empty");
    expect(subcommands(fix)).toEqual(["run"]);
    expect(readFileSync(live)).toEqual(before);
  });

  it("backs up and restores a first-admin grant and receipt with no documents", () => {
    const fix = fixture();
    const live = join(fix.volume, "hub.sqlite");
    const workspaceId = "00000000-0000-4000-8000-000000000001";
    const setupId = "00000000-0000-4000-8000-000000000002";
    const identity = { id: crypto.randomUUID(), github_account_id: "1234", github_username: "first-admin" };
    const membership = { workspace_id: workspaceId, principal_id: identity.id, role: "admin" };
    const grant = { setup_id: setupId, workspace_id: workspaceId, principal_id: identity.id,
      github_account_id: identity.github_account_id,
      github_username: identity.github_username, had_documents: 0 };
    hubDatabase(live, 0, true);
    const database = new DatabaseSync(live);
    try {
      database.prepare("INSERT INTO hub_principals VALUES (?, ?, ?)")
        .run(identity.id, identity.github_account_id, identity.github_username);
      database.prepare("INSERT INTO hub_memberships VALUES (?, ?, ?)")
        .run(workspaceId, identity.id, membership.role);
      database.prepare("INSERT INTO hub_admin_setup_grants VALUES (?, ?, ?, ?, ?, ?)")
        .run(setupId, workspaceId, identity.id, identity.github_account_id, identity.github_username, 0);
    } finally {
      database.close();
    }

    const backup = join(fix.checkout, "access-only.sqlite");
    const backedUp = run(fix, "hub-backup.sh", [backup]);
    expect(backedUp.status).toBe(0);
    // Stand in for loss of the original access records before recovery.
    hubDatabase(join(fix.checkout, "replacement.sqlite"), 2);
    copyFileSync(join(fix.checkout, "replacement.sqlite"), live);

    const restored = run(fix, "hub-restore.sh", [backup]);

    expect(restored.status, restored.stderr).toBe(0);
    expect(restored.stdout).toContain("private access state");
    expect(readFileSync(live)).toEqual(readFileSync(backup));
    const recovered = new DatabaseSync(live, { readOnly: true });
    try {
      expect(recovered.prepare("SELECT * FROM hub_principals WHERE github_account_id = ?")
        .get(identity.github_account_id)).toEqual(identity);
      expect(recovered.prepare("SELECT * FROM hub_memberships").get()).toEqual(membership);
      expect(recovered.prepare("SELECT * FROM hub_admin_setup_grants WHERE setup_id = ?").get(setupId)).toEqual(grant);
      expect(recovered.prepare("SELECT count(*) AS count FROM documents").get()?.count).toBe(0);
      expect(recovered.prepare("SELECT count(*) AS count FROM hub_credentials").get()?.count).toBe(0);
    } finally {
      recovered.close();
    }
  });

  it("verifies, then stops, stages, renames into place and starts again", () => {
    const fix = fixture();
    const live = join(fix.volume, "hub.sqlite");
    hubDatabase(live, 9);
    const backup = join(fix.checkout, "good.sqlite");
    hubDatabase(backup, 2);
    // A hub that crashed on the way down is often exactly why somebody is
    // restoring, so with no journal beside the database this proceeds — and
    // still says what the hub did.
    fix.env.UB_TEST_HUB_EXIT = "137";

    const ran = run(fix, "hub-restore.sh", [backup]);

    expect(ran.status).toBe(0);
    expect(ran.stderr).toContain("the hub exited 137");
    // Verify, stop, ps, the journal probe, cp, the placement, and the restart.
    expect(subcommands(fix)).toEqual(["run", "stop", "ps", "run", "cp", "run", "start"]);
    // Never onto the name the hub opens: staged first, renamed by the container.
    expect(calls(fix)[4]).toBe(`cp ${backup} hub:/data/hub.sqlite.restoring`);
    expect(readFileSync(live)).toEqual(readFileSync(backup));
    expect(readdirSync(fix.volume)).toEqual(["hub.sqlite"]);
  });

  /**
   * A journal is the half of an interrupted transaction that says what to undo.
   * Every way of getting a new database past it can leave the pair broken, so
   * the restore refuses and tells the operator to let SQLite recover it.
   */
  it("refuses while a rollback journal is beside the database, touching nothing", () => {
    const fix = fixture();
    const live = join(fix.volume, "hub.sqlite");
    hubDatabase(live, 9);
    const liveBefore = readFileSync(live);
    const journal = join(fix.volume, "hub.sqlite-journal");
    writeFileSync(journal, "a rollback journal for the old database", "utf8");
    const journalBefore = readFileSync(journal);
    const backup = join(fix.checkout, "good.sqlite");
    hubDatabase(backup, 2);

    const ran = run(fix, "hub-restore.sh", [backup]);

    expect(ran.status).not.toBe(0);
    expect(ran.stderr).toContain("rollback journal");
    expect(ran.stderr).toContain("sh bin/remote-compose.sh up --detach hub");
    expect(readFileSync(live)).toEqual(liveBefore);
    expect(readFileSync(journal)).toEqual(journalBefore);
    // Nothing was copied and nothing was placed; the hub is running again.
    expect(subcommands(fix)).toEqual(["run", "stop", "ps", "run", "start"]);
    expect(calls(fix).some((line) => line.startsWith("cp "))).toBe(false);
  });

  /**
   * The reason the copy is staged: a copy that dies half way must leave the
   * database that is already there whole, and say so.
   */
  it("leaves the live database alone when the copy into the volume fails", () => {
    const fix = fixture();
    const live = join(fix.volume, "hub.sqlite");
    hubDatabase(live, 7);
    const before = readFileSync(live);
    const backup = join(fix.checkout, "good.sqlite");
    hubDatabase(backup, 2);
    fix.env.UB_TEST_CP_FAIL = "1";

    const ran = run(fix, "hub-restore.sh", [backup]);

    expect(ran.status).not.toBe(0);
    expect(ran.stderr).toContain("NOT replaced");
    expect(readFileSync(live)).toEqual(before);
    expect(calls(fix).some((line) => line.includes("mv -f /data/hub.sqlite.restoring"))).toBe(
      false,
    );
    // Verify, stop, ps, probe, the failed cp, the discard, and the restart.
    expect(subcommands(fix)).toEqual(["run", "stop", "ps", "run", "cp", "run", "start"]);
  });

  /**
   * The restart is the part somebody is depending on, so nothing in `finish` may
   * stand in front of it — here the best-effort discard of the staged file fails
   * and the hub still comes back.
   */
  it("restarts the hub even when the staged file cannot be discarded", () => {
    const fix = fixture();
    hubDatabase(join(fix.volume, "hub.sqlite"), 7);
    const backup = join(fix.checkout, "good.sqlite");
    hubDatabase(backup, 2);
    fix.env.UB_TEST_CP_FAIL = "1";
    fix.env.UB_TEST_DISCARD_FAIL = "1";

    const ran = run(fix, "hub-restore.sh", [backup]);

    expect(ran.status).not.toBe(0);
    expect(ran.stderr).not.toContain("THE HUB IS STILL DOWN");
    expect(subcommands(fix)).toEqual(["run", "stop", "ps", "run", "cp", "run", "start"]);
  });
});
