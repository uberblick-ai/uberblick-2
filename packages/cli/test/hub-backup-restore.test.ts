/**
 * `hub-backup.sh` and `hub-restore.sh`, run for real.
 *
 * These two scripts are the only thing standing between a bad day and a lost
 * corpus, so the properties worth defending are the refusals: a backup must not
 * be written when the hub's shutdown flush failed, and a restore must not touch
 * the volume for a file it has not read. Neither survives being mocked, so the
 * scripts are run as themselves against a stub `remote-compose.sh` — the wrapper
 * is the only thing a checkout ever drives Docker through, which is exactly why
 * it is the seam (`remote-update.test.ts` uses the same one). No Docker runs
 * here.
 *
 * The verification step is not faked: the stub takes the `sh -c` payload the
 * restore script hands the hub image, rewrites the container path to a file in
 * the sandbox, and runs it with the real `node` — so `PRAGMA integrity_check`
 * and the `documents` count are performed by the same `node:sqlite` the hub
 * persists with, against real fixture databases.
 */

import { spawnSync } from "node:child_process";
import type { SpawnSyncReturns } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
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
    printf '{"Name":"uberblick-remote-hub-1","Service":"hub","State":"exited","ExitCode":%s}\\n' \\
      "\${UB_TEST_HUB_EXIT:-0}"
    ;;
  cp)
    case "$2" in
      hub:*)
        cp "$UB_TEST_VOLUME/hub.sqlite" "$3"
        chmod 644 "$3"
        ;;
      *)
        cp "$2" "$UB_TEST_VOLUME/hub.sqlite"
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
    esac
    ;;
esac
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

  writeFileSync(join(checkout, "remote-compose.sh"), COMPOSE_STUB, { mode: 0o755 });
  // The real scripts, verbatim — the files under test.
  for (const script of ["hub-backup.sh", "hub-restore.sh"]) {
    copyFileSync(join(REPO_ROOT, script), join(checkout, script));
  }

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
    },
  };
}

/** Write a hub-shaped SQLite database with `rows` documents in it. */
function hubDatabase(path: string, rows: number): void {
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE "documents" ("name" varchar(255) NOT NULL, "data" blob NOT NULL, UNIQUE(name))`);
  const insert = db.prepare(`INSERT INTO "documents" ("name", "data") VALUES ($name, $data)`);
  for (let index = 0; index < rows; index += 1) {
    insert.run({ name: `workspace/doc-${index}`, data: new Uint8Array([1, 2, 3]) });
  }
  db.close();
}

function run(fix: Fixture, script: string, args: string[]): SpawnSyncReturns<string> {
  return spawnSync("sh", [join(fix.checkout, script), ...args], {
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

describe("hub-backup.sh", () => {
  it("stops, reads the exit code, copies and starts again — at mode 0600", () => {
    const fix = fixture();
    hubDatabase(join(fix.volume, "hub.sqlite"), 3);
    const target = join(fix.checkout, "backup.sqlite");

    const ran = run(fix, "hub-backup.sh", [target]);

    expect(ran.status).toBe(0);
    expect(subcommands(fix)).toEqual(["stop", "ps", "cp", "start"]);
    expect(calls(fix)[0]).toBe("stop hub");
    expect(calls(fix)[2]).toBe(`cp hub:/data/hub.sqlite ${target}`);
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
    const target = join(fix.checkout, "backup.sqlite");

    const ran = run(fix, "hub-backup.sh", [target]);
    expect(ran.status).toBe(0);

    const failing = fixture();
    hubDatabase(join(failing.volume, "hub.sqlite"), 3);
    failing.env.UB_TEST_HUB_EXIT = "137";
    const refused = run(failing, "hub-backup.sh", [join(failing.checkout, "backup.sqlite")]);

    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toContain("137");
    expect(existsSync(join(failing.checkout, "backup.sqlite"))).toBe(false);
    expect(subcommands(failing)).toEqual(["stop", "ps", "start"]);
  });
});

describe("hub-restore.sh", () => {
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

  /** A valid database with nothing in it passes the pragma, so the count is the check. */
  it("refuses a backup whose documents table is empty", () => {
    const fix = fixture();
    const backup = join(fix.checkout, "empty.sqlite");
    hubDatabase(backup, 0);

    const ran = run(fix, "hub-restore.sh", [backup]);

    expect(ran.status).not.toBe(0);
    expect(ran.stderr).toContain("empty");
    expect(subcommands(fix)).toEqual(["run"]);
    expect(existsSync(join(fix.volume, "hub.sqlite"))).toBe(false);
  });

  it("verifies, then stops, copies in and starts again", () => {
    const fix = fixture();
    const backup = join(fix.checkout, "good.sqlite");
    hubDatabase(backup, 2);

    const ran = run(fix, "hub-restore.sh", [backup]);

    expect(ran.status).toBe(0);
    expect(subcommands(fix)).toEqual(["run", "stop", "ps", "cp", "run", "start"]);
    expect(calls(fix)[3]).toBe(`cp ${backup} hub:/data/hub.sqlite`);
    expect(readFileSync(join(fix.volume, "hub.sqlite"))).toEqual(readFileSync(backup));
  });
});
