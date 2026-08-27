/**
 * `ub storage migrate` — the one move of a legacy macOS installation.
 *
 * What is defended here is data safety, not formatting: that a database is
 * copied through SQLite rather than through the filesystem (so the rows still
 * in a `-wal` survive), that a database another process holds open refuses the
 * run instead of being copied out from under it, that nothing is published
 * until every copy has been verified, that the originals are never touched, and
 * that after a migration every command reads the new root.
 *
 * The Mac cases resolve in-process with `platform: "darwin"` — the parameter
 * every layer takes for exactly this reason. Spawning `ub` would test the
 * platform the tests happen to run on; mocking `process.platform` inside the
 * CLI would test the mock. The one spawned case is the non-macOS refusal, which
 * is true on the machine running the suite and proves the whole wiring:
 * dispatch, plan, render, exit code.
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, describe, expect, it } from "vitest";
import { createHub, silentLogger } from "@uberblick/hub";
import { hubDatabasePath } from "@uberblick/hub/config";
import { MIGRATION_RECEIPT } from "@uberblick/hub/storage";
import { resolveMcpConfig } from "@uberblick/mcp-server";
import { resolveConfig } from "../src/config.js";
import { doctorReport } from "../src/doctor.js";
import type { MigrationReport } from "../src/storage.js";
import { planMigration, renderMigration, runMigration } from "../src/storage.js";
import { statusReport } from "../src/status.js";
import { listWorkspaces } from "../src/workspace.js";
import {
  DEAD_HUB_URL,
  PACKAGE_ROOT,
  removeTempDirs,
  runUbAsync,
  sandbox,
} from "./helpers.js";

const WORKSPACE = "0d4a1e7c-2b93-4f18-9a55-6c7e8d1b2f30";
const OTHER_WORKSPACE = "9c1b7e42-5f30-4a68-b2d1-84e6f7a9c503";
const SECRET = "migrate-test-signing-secret-4f19ab";

const FIXTURES = join(PACKAGE_ROOT, "test", "fixtures");

const tempDirs: string[] = [];

afterAll(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  removeTempDirs();
});

// --- fixtures ----------------------------------------------------------------

interface Legacy {
  /** A throwaway home with nothing of the developer's in it. */
  home: string;
  configDir: string;
  dataDir: string;
  /** Where the migration would put everything. */
  mac: string;
  env: NodeJS.ProcessEnv;
}

function home(): string {
  const dir = mkdtempSync(join(tmpdir(), "uberblick-migrate-"));
  tempDirs.push(dir);
  return dir;
}

function macRoot(root: string): string {
  return join(root, "Library", "Application Support", "Uberblick");
}

function write(path: string, text: string, mode = 0o600): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, "utf8");
  chmodSync(path, mode);
}

/** A replica database in the shape the MCP server's store leaves one. */
function replica(path: string, workspace: string | null, rows = 4): void {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  db.exec(
    "CREATE TABLE updates (seq INTEGER PRIMARY KEY AUTOINCREMENT, " +
      "room TEXT NOT NULL, payload BLOB NOT NULL)",
  );
  if (workspace !== null) {
    db.prepare("INSERT INTO meta (key, value) VALUES ('workspace', ?)").run(workspace);
  }
  const insert = db.prepare("INSERT INTO updates (room, payload) VALUES (?, ?)");
  for (let i = 0; i < rows; i += 1) {
    insert.run(`${workspace ?? "none"}/doc-${i}`, Buffer.from(`payload-${i}`));
  }
  db.close();
}

/** A hub database in the shape `@uberblick/hub`'s persistence leaves one. */
function hubDatabase(path: string, documents: string[]): void {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(
    'CREATE TABLE IF NOT EXISTS "documents" ("name" varchar(255) NOT NULL, ' +
      '"data" blob NOT NULL, UNIQUE(name))',
  );
  const insert = db.prepare('INSERT INTO "documents" ("name", "data") VALUES (?, ?)');
  for (const name of documents) {
    insert.run(name, Buffer.from(`state-of-${name}`));
  }
  db.close();
}

interface LegacyOptions {
  config?: unknown;
  rawConfig?: string;
  credentials?: unknown;
  credentialsMode?: number;
  workspaces?: (string | { file: string; claim: string | null })[];
  hub?: string[];
}

/** A Mac that has had uberblick since before Application Support was the answer. */
function legacy(options: LegacyOptions = {}): Legacy {
  const root = home();
  const configDir = join(root, ".config", "uberblick");
  const dataDir = join(root, ".local", "share", "uberblick");

  if (options.rawConfig !== undefined) {
    write(join(configDir, "config.json"), options.rawConfig);
  } else {
    write(
      join(configDir, "config.json"),
      `${JSON.stringify(options.config ?? { workspace: WORKSPACE, displayName: "Ada" }, null, 2)}\n`,
    );
  }
  write(
    join(configDir, "credentials.json"),
    `${JSON.stringify(options.credentials ?? { signingSecret: SECRET }, null, 2)}\n`,
    options.credentialsMode ?? 0o600,
  );
  for (const one of options.workspaces ?? [WORKSPACE]) {
    const file = typeof one === "string" ? `${one}.sqlite` : one.file;
    const claim = typeof one === "string" ? one : one.claim;
    replica(join(dataDir, file), claim);
  }
  if (options.hub !== undefined) {
    hubDatabase(join(dataDir, "hub.sqlite"), options.hub);
  }

  return {
    home: root,
    configDir,
    dataDir,
    mac: macRoot(root),
    // A hub nothing listens on. The fixture's credentials.json carries a
    // signing secret, so without this `ub status` would dial whatever is on
    // the default endpoint — which, on a developer's machine, is their own hub
    // and their own corpus.
    env: { HOME: root, HUB_URL: DEAD_HUB_URL },
  };
}

function darwin(box: Legacy, extra: Partial<Parameters<typeof runMigration>[0]> = {}) {
  return { env: box.env, cwd: box.home, platform: "darwin" as const, ...extra };
}

/**
 * Every file under a directory, with its digest: "nothing changed" checkable.
 *
 * `-wal` and `-shm` are left out because they are not ours to hold still: a
 * process that merely *opens* a WAL database creates them, so a test that
 * spawns a client holding one open would be asserting about the client. What
 * must not change is the database itself and the two configuration files.
 */
function tree(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { recursive: true, encoding: "utf8" })
    .filter((entry) => !entry.endsWith("-wal") && !entry.endsWith("-shm"))
    .map((entry) => {
      const path = join(root, entry);
      if (!statSync(path).isFile()) return entry;
      return `${entry} ${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
    })
    .sort();
}

/**
 * Rows in one table of a database.
 *
 * Read-write on purpose: a read-only connection to a WAL database creates a
 * `-wal` and a `-shm` beside it and leaves them there, which would make this
 * suite's "no write-ahead log was copied" assertions about files the suite
 * itself created. Closing a read-write connection cleans them up.
 */
/**
 * A pid that is certainly not in use: spawn a process and wait for it to exit.
 *
 * Picking a number and hoping is how a sweep test starts passing for the wrong
 * reason on a busy machine.
 */
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", ""]);
  await new Promise((resolve) => child.on("close", resolve));
  return child.pid as number;
}

/** A file's digest, or "absent". For "this did not change" on one path. */
function digestOf(path: string): string {
  return existsSync(path)
    ? createHash("sha256").update(readFileSync(path)).digest("hex")
    : "absent";
}

function rowsIn(path: string, table: string): number {
  const db = new DatabaseSync(path);
  try {
    return Number(
      (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n,
    );
  } finally {
    db.close();
  }
}

function refusalText(report: { refusals: { reason: string; remedy: string }[] }): string {
  return report.refusals.map((one) => `${one.reason} ${one.remedy}`).join("\n");
}

/** Run a node script from `test/fixtures` and resolve once it prints a line. */
function spawnFixture(
  script: string,
  args: string[],
  waitFor: string | null,
): Promise<{ kill: () => void }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(FIXTURES, script), ...args]);
    const kill = (): void => {
      child.kill("SIGKILL");
    };
    let seen = "";
    child.stdout.on("data", (chunk: Buffer) => {
      seen += chunk.toString("utf8");
      if (waitFor !== null && seen.includes(waitFor)) resolve({ kill });
    });
    child.on("error", reject);
    child.on("close", () => {
      if (waitFor === null) resolve({ kill });
    });
  });
}

// --- the dry run -------------------------------------------------------------

describe("`ub storage migrate --dry-run`", () => {
  it("names every source and destination, the counts and the refusals, and writes nothing", () => {
    const box = legacy({ workspaces: [WORKSPACE, OTHER_WORKSPACE] });
    const before = tree(box.home);

    const plan = planMigration(darwin(box));
    const text = renderMigration({
      ...plan,
      version: "test",
      dryRun: true,
      migrated: [],
    });

    expect(plan.state).toBe("ready");
    expect(plan.workspaces).toBe(2);
    expect(plan.hub).toBeNull();
    expect(plan.refusals).toEqual([]);
    // Every source path and every destination path, exactly.
    expect(plan.copies.map((copy) => [copy.source, copy.target])).toEqual([
      [join(box.configDir, "config.json"), "config.json"],
      [join(box.configDir, "credentials.json"), "credentials.json"],
      [
        join(box.dataDir, `${WORKSPACE}.sqlite`),
        join("data", "workspaces", `${WORKSPACE}.sqlite`),
      ],
      [
        join(box.dataDir, `${OTHER_WORKSPACE}.sqlite`),
        join("data", "workspaces", `${OTHER_WORKSPACE}.sqlite`),
      ],
    ]);
    expect(text).toContain(box.configDir);
    expect(text).toContain(box.dataDir);
    expect(text).toContain(box.mac);
    expect(text).toContain("2 workspaces");
    expect(text).toMatch(/no local hub database was moved/);
    expect(text).toMatch(/Nothing was written/);

    // Not one byte, and no destination root brought into being by asking.
    expect(tree(box.home)).toEqual(before);
    expect(existsSync(join(box.home, "Library"))).toBe(false);
  });

  it("reports the refusals it can see without opening a database, all of them", () => {
    const box = legacy({ rawConfig: "{ not json", credentialsMode: 0o644 });
    const before = tree(box.home);

    const plan = planMigration(darwin(box, { hubDb: join(box.home, "nowhere.sqlite") }));

    expect(plan.state).toBe("refused");
    // All of them, not the first: a dry run exists to be read once.
    expect(plan.refusals).toHaveLength(3);
    expect(refusalText(plan)).toContain("not a JSON object");
    expect(refusalText(plan)).toContain("0644");
    expect(refusalText(plan)).toContain("does not exist");
    expect(tree(box.home)).toEqual(before);
  });

  it("prints no credential value, in either output", () => {
    const box = legacy();
    const plan = planMigration(darwin(box));
    const report: MigrationReport = {
      ...plan,
      version: "test",
      dryRun: true,
      migrated: [],
    };

    expect(renderMigration(report)).not.toContain(SECRET);
    expect(JSON.stringify(report)).not.toContain(SECRET);
  });
});

// --- the migration -----------------------------------------------------------

describe("migrating a legacy Mac installation", () => {
  it("stages config, credentials, every replica and a named hub, verifies them, then publishes one root", async () => {
    const box = legacy({ workspaces: [WORKSPACE, OTHER_WORKSPACE] });
    const checkoutHub = join(box.home, "checkout", "hub.sqlite");
    hubDatabase(checkoutHub, ["room-a", "room-b", "room-c"]);

    const report = await runMigration(darwin(box, { hubDb: checkoutHub }));

    expect(report.state).toBe("ready");
    expect(report.refusals).toEqual([]);
    expect(report.migrated.map((file) => file.target)).toEqual([
      "config.json",
      "credentials.json",
      join("data", "workspaces", `${WORKSPACE}.sqlite`),
      join("data", "workspaces", `${OTHER_WORKSPACE}.sqlite`),
      join("data", "hub.sqlite"),
    ]);

    // The contents arrived, byte for byte where they are bytes and row for row
    // where they are rows.
    expect(readFileSync(join(box.mac, "config.json"), "utf8")).toBe(
      readFileSync(join(box.configDir, "config.json"), "utf8"),
    );
    expect(
      JSON.parse(readFileSync(join(box.mac, "credentials.json"), "utf8")),
    ).toEqual({ signingSecret: SECRET });
    expect(rowsIn(join(box.mac, "data", "hub.sqlite"), '"documents"')).toBe(3);
    for (const uuid of [WORKSPACE, OTHER_WORKSPACE]) {
      const path = join(box.mac, "data", "workspaces", `${uuid}.sqlite`);
      expect(rowsIn(path, "updates")).toBe(4);
      const db = new DatabaseSync(path);
      expect(
        (db.prepare("SELECT value FROM meta WHERE key = 'workspace'").get() as {
          value: string;
        }).value,
      ).toBe(uuid);
      db.close();
    }

    // Owner-only, all the way down: the secret is in here.
    expect(statSync(join(box.mac, "credentials.json")).mode & 0o777).toBe(0o600);
    expect(statSync(join(box.mac, "config.json")).mode & 0o777).toBe(0o600);
    for (const uuid of [WORKSPACE, OTHER_WORKSPACE]) {
      expect(
        statSync(join(box.mac, "data", "workspaces", `${uuid}.sqlite`)).mode & 0o777,
      ).toBe(0o600);
    }
    for (const directory of [
      box.mac,
      join(box.mac, "data"),
      join(box.mac, "data", "workspaces"),
    ]) {
      expect(statSync(directory).mode & 0o077).toBe(0);
    }

    // Nothing staged is left behind, and no write-ahead log was carried over as
    // an ordinary file.
    expect(readdirSync(dirname(box.mac))).toEqual(["Uberblick"]);
    expect(readdirSync(join(box.mac, "data", "workspaces")).sort()).toEqual(
      [`${OTHER_WORKSPACE}.sqlite`, `${WORKSPACE}.sqlite`].sort(),
    );

    // The originals are all still there.
    expect(existsSync(join(box.configDir, "config.json"))).toBe(true);
    expect(existsSync(join(box.configDir, "credentials.json"))).toBe(true);
    expect(existsSync(join(box.dataDir, `${WORKSPACE}.sqlite`))).toBe(true);
    expect(existsSync(checkoutHub)).toBe(true);
    expect(renderMigration(report)).toMatch(/originals are retained/);
  });

  it("carries a replica's uncheckpointed write-ahead log through SQLite's backup", async () => {
    const box = legacy({ workspaces: [] });
    const source = join(box.dataDir, `${WORKSPACE}.sqlite`);
    mkdirSync(box.dataDir, { recursive: true });
    // A process killed mid-flight: every row committed, none checkpointed.
    await spawnFixture("write-and-die.mjs", [source, "40", WORKSPACE], null);

    expect(existsSync(`${source}-wal`)).toBe(true);
    expect(statSync(`${source}-wal`).size).toBeGreaterThan(0);
    // What a file copy would have produced: the rows live in the -wal, so the
    // database file on its own does not even have the table yet.
    const naive = join(box.home, "naive.sqlite");
    copyFileSync(source, naive);
    expect(() => rowsIn(naive, "updates")).toThrow();

    const report = await runMigration(darwin(box));

    expect(report.state).toBe("ready");
    const migrated = join(box.mac, "data", "workspaces", `${WORKSPACE}.sqlite`);
    expect(rowsIn(migrated, "updates")).toBe(40);
    // And no `-wal`/`-shm` bytes were copied as ordinary files.
    expect(readdirSync(join(box.mac, "data", "workspaces"))).toEqual([
      `${WORKSPACE}.sqlite`,
    ]);
  });
});

// --- a live client -----------------------------------------------------------

describe("a database another process has open", () => {
  it("refuses naming the file, and leaves the target and the sources untouched", async () => {
    const box = legacy();
    const source = join(box.dataDir, `${WORKSPACE}.sqlite`);
    const before = tree(box.home);
    const holder = await spawnFixture("hold-database.mjs", [source], "open");

    let report: MigrationReport;
    try {
      report = await runMigration(darwin(box));
    } finally {
      holder.kill();
    }

    expect(report.state).toBe("refused");
    expect(refusalText(report)).toContain(source);
    expect(refusalText(report)).toMatch(/open in another process/);
    expect(refusalText(report)).toMatch(/close everything using uberblick/);
    // Byte for byte: the sources, and no destination root at all.
    expect(tree(box.home)).toEqual(before);
    expect(existsSync(box.mac)).toBe(false);
  });
});

// --- what a refusal does to the sources it never copied -----------------------

describe("a refusal during inspection", () => {
  it("leaves a crashed replica's write-ahead log exactly as it was", async () => {
    // The two halves of the fixture: one replica a client is holding open, and
    // one left dirty by a killed writer. The held one sorts first, so the run
    // refuses before it ever reaches the crashed one — which is the case that
    // would otherwise be silently checkpointed by being looked at.
    const box = legacy({ workspaces: [] });
    mkdirSync(box.dataDir, { recursive: true });
    const held = join(box.dataDir, `${WORKSPACE}.sqlite`);
    const crashed = join(box.dataDir, `${OTHER_WORKSPACE}.sqlite`);
    replica(held, WORKSPACE);
    await spawnFixture("write-and-die.mjs", [crashed, "40", OTHER_WORKSPACE], null);

    expect(existsSync(`${crashed}-wal`)).toBe(true);
    const walBefore = digestOf(`${crashed}-wal`);
    const dbBefore = digestOf(crashed);

    const holder = await spawnFixture("hold-database.mjs", [held], "open");
    let report: MigrationReport;
    try {
      report = await runMigration(darwin(box));
    } finally {
      holder.kill();
    }

    expect(report.state).toBe("refused");
    expect(refusalText(report)).toContain(held);
    // Byte for byte, the database *and* its uncheckpointed log: the checks that
    // could have refused this file read it without writing to it.
    expect(digestOf(crashed)).toBe(dbBefore);
    expect(digestOf(`${crashed}-wal`)).toBe(walBefore);
    expect(existsSync(box.mac)).toBe(false);
  });
});

// --- the hub database --------------------------------------------------------

describe("the hub database, which is never guessed at", () => {
  it("moves none, and says so, when nothing names one", async () => {
    const box = legacy();

    const report = await runMigration(darwin(box));

    expect(report.state).toBe("ready");
    expect(report.hub).toBeNull();
    expect(existsSync(join(box.mac, "data", "hub.sqlite"))).toBe(false);
    expect(renderMigration(report)).toMatch(/no local hub database was moved/);
  });

  it("moves the one in the legacy layout, which is not a guess", async () => {
    const box = legacy({ hub: ["room-a", "room-b"] });

    const report = await runMigration(darwin(box));

    expect(report.hub).toBe(join(box.dataDir, "hub.sqlite"));
    expect(rowsIn(join(box.mac, "data", "hub.sqlite"), '"documents"')).toBe(2);
  });

  const refusals: {
    name: string;
    hubDb: (box: Legacy) => string;
    layoutHub?: string[];
    matches: RegExp;
  }[] = [
    {
      name: "a path that does not exist",
      hubDb: (box) => join(box.home, "checkout", "gone.sqlite"),
      matches: /does not exist/,
    },
    {
      name: "a file that is not SQLite",
      hubDb: (box) => {
        const path = join(box.home, "checkout", "notes.txt");
        write(path, "this is not a database\n", 0o644);
        return path;
      },
      matches: /not a SQLite database/,
    },
    {
      name: "a database that fails SQLite's integrity check",
      hubDb: (box) => {
        const path = join(box.home, "checkout", "damaged.sqlite");
        hubDatabase(path, Array.from({ length: 200 }, (_, i) => `room-${i}`));
        // Scribbled well past the header, so it still opens and still passes
        // the magic-bytes check: the damage is only found by looking.
        const fd = openSync(path, "r+");
        writeSync(fd, Buffer.alloc(1024, 0x5a), 0, 1024, 4096 * 3 + 100);
        closeSync(fd);
        return path;
      },
      matches: /fails SQLite's integrity check/,
    },
    {
      name: "a directory rather than a file",
      hubDb: (box) => {
        const path = join(box.home, "checkout", "not-a-file");
        mkdirSync(path, { recursive: true });
        return path;
      },
      matches: /not a SQLite database/,
    },
    {
      name: "the file the migration would write",
      hubDb: (box) => join(box.mac, "data", "hub.sqlite"),
      matches: /is the file the migration would write/,
    },
    {
      name: "a second candidate beside the layout's own",
      hubDb: (box) => {
        const path = join(box.home, "checkout", "hub.sqlite");
        hubDatabase(path, ["room-a"]);
        return path;
      },
      layoutHub: ["room-z"],
      matches: /two hub databases/,
    },
  ];

  for (const one of refusals) {
    it(`refuses ${one.name}, before anything is published`, async () => {
      const box = legacy(one.layoutHub === undefined ? {} : { hub: one.layoutHub });
      // After the case has planted whatever it is about to be refused for, so
      // that what is compared is the run's doing and nothing else.
      const hubDb = one.hubDb(box);
      const before = tree(box.home);

      const report = await runMigration(darwin(box, { hubDb }));

      expect(report.state).toBe("refused");
      expect(refusalText(report)).toMatch(one.matches);
      expect(report.refusals[0]?.remedy).toBeTruthy();
      expect(existsSync(box.mac)).toBe(false);
      expect(tree(box.home)).toEqual(before);
    });
  }
});

// --- everything that refuses -------------------------------------------------

describe("what refuses, and what each refusal says", () => {
  interface Case {
    name: string;
    build: () => { plan: () => MigrationReport | Promise<MigrationReport>; root: string; mac: string };
    matches: RegExp;
  }

  const cases: Case[] = [
    {
      name: "a destination that already holds uberblick files",
      build: () => {
        const box = legacy();
        write(join(box.mac, "config.json"), "{}\n");
        return {
          plan: () => runMigration(darwin(box)),
          root: box.home,
          mac: box.mac,
        };
      },
      matches: /already holds uberblick files/,
    },
    {
      name: "an explicit XDG_CONFIG_HOME",
      build: () => {
        const box = legacy();
        const env = { ...box.env, XDG_CONFIG_HOME: join(box.home, "elsewhere") };
        return {
          plan: () =>
            runMigration({ env, cwd: box.home, platform: "darwin" }),
          root: box.home,
          mac: box.mac,
        };
      },
      matches: /XDG_CONFIG_HOME is set/,
    },
    {
      name: "an explicit XDG_DATA_HOME",
      build: () => {
        const box = legacy();
        const env = { ...box.env, XDG_DATA_HOME: join(box.home, "elsewhere") };
        return {
          plan: () => runMigration({ env, cwd: box.home, platform: "darwin" }),
          root: box.home,
          mac: box.mac,
        };
      },
      matches: /XDG_DATA_HOME is set/,
    },
    {
      name: "a platform that is not macOS",
      build: () => {
        const box = legacy();
        return {
          plan: () => runMigration({ env: box.env, cwd: box.home, platform: "linux" }),
          root: box.home,
          mac: box.mac,
        };
      },
      matches: /not macOS/,
    },
    {
      name: "a legacy config.json that is not a JSON object",
      build: () => {
        const box = legacy({ rawConfig: "[1, 2, 3]\n" });
        return { plan: () => runMigration(darwin(box)), root: box.home, mac: box.mac };
      },
      matches: /not a JSON object/,
    },
    {
      name: "a credentials.json other users can read",
      build: () => {
        const box = legacy({ credentialsMode: 0o640 });
        return { plan: () => runMigration(darwin(box)), root: box.home, mac: box.mac };
      },
      matches: /mode 0640/,
    },
    {
      name: "a replica whose recorded workspace is not the one in its filename",
      build: () => {
        const box = legacy({
          workspaces: [{ file: `${WORKSPACE}.sqlite`, claim: OTHER_WORKSPACE }],
        });
        return { plan: () => runMigration(darwin(box)), root: box.home, mac: box.mac };
      },
      matches: /is the replica of workspace/,
    },
  ];

  const seen = new Set<string>();
  for (const one of cases) {
    it(`refuses ${one.name}, with its own remedy and no writes`, async () => {
      const { plan, root, mac } = one.build();
      const before = tree(root);

      const report = await plan();

      expect(report.state).toBe("refused");
      expect(refusalText(report)).toMatch(one.matches);
      const reason = report.refusals[0]?.reason ?? "";
      expect(report.refusals[0]?.remedy ?? "").not.toBe("");
      // Distinct: a table of refusals that all say the same thing is one
      // refusal wearing seven hats.
      expect(seen.has(reason)).toBe(false);
      seen.add(reason);
      // Nothing written, including the destination root — except where the
      // case itself put a file there to be refused.
      expect(tree(root)).toEqual(before);
      expect(renderMigration({ ...report, version: "test", dryRun: false, migrated: [] }))
        .toContain("refused");
      expect(mac).toBeTruthy();
    });
  }

  it("exits 1 and says which platform it is on, run as a real process", async () => {
    // The one case that is true on the machine running the suite, and the only
    // one that can prove the wiring end to end: dispatch, plan, render, code.
    const box = sandbox();
    // Async, not `runUb`: this suite owns an in-process hub in the end-to-end
    // case below, and spawnSync would block the event loop it runs on.
    const run = await runUbAsync(["storage", "migrate", "--dry-run"], box);

    expect(run.status).toBe(1);
    expect(run.stdout).toMatch(/refused/);
    expect(run.stdout).toMatch(/not macOS/);
  });
});

// --- what a killed run leaves behind ------------------------------------------

describe("staging left by a run that died", () => {
  /** A staging directory of the shape a killed run leaves, holding a secret. */
  function stale(box: Legacy, pid: number): string {
    const path = join(dirname(box.mac), `.Uberblick.${pid}.abc123def456.tmp`);
    mkdirSync(path, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(path, "credentials.json"),
      `${JSON.stringify({ signingSecret: SECRET })}\n`,
      "utf8",
    );
    return path;
  }

  it("sweeps it, because it holds a copy of the signing secret", async () => {
    const box = legacy();
    // pid 1 is init: it exists, so use a pid nothing can be using. A freshly
    // created and reaped child's pid is the closest thing to a guarantee.
    const dead = await deadPid();
    const left = stale(box, dead);

    const report = await runMigration(darwin(box));

    expect(report.state).toBe("ready");
    expect(existsSync(left)).toBe(false);
    // And the publication still happened, in the same parent directory.
    expect(readdirSync(dirname(box.mac))).toEqual(["Uberblick"]);
  });

  it("leaves one whose process is still running alone", async () => {
    const box = legacy();
    // This process is alive by definition, and stands in for a second
    // `ub storage migrate` copying right now: sweeping its staging would pull
    // the files out from under a run that is going to publish them.
    const live = stale(box, process.pid);

    const report = await runMigration(darwin(box));

    expect(report.state).toBe("ready");
    expect(existsSync(join(live, "credentials.json"))).toBe(true);
  });
});

// --- afterwards --------------------------------------------------------------

describe("after a migration", () => {
  it("puts every command, and a hub, on the Application Support copies", async () => {
    // No signing secret in this one: with one, every `ub status` below would
    // spend its whole sync budget dialling a hub that is deliberately not
    // there. That the secret itself is carried over, at 0600, is the
    // integration test above.
    const box = legacy({ workspaces: [], credentials: { note: "not a secret" } });
    const env = { ...box.env, WORKSPACE_ID: WORKSPACE };

    // A real replica, made where a legacy installation has one: `ub status`
    // opens the MCP server's own store, so this is the file the migration will
    // have to carry.
    const before = await statusReport({ env, cwd: box.home, platform: "darwin" });
    expect(before.report.storage.layout).toBe("legacy-xdg");
    expect(before.report.databasePath).toBe(join(box.dataDir, `${WORKSPACE}.sqlite`));

    // A hub database written by a real hub, so what is migrated is the real
    // schema rather than this suite's idea of it.
    const checkoutHub = join(box.home, "checkout", "hub.sqlite");
    mkdirSync(dirname(checkoutHub), { recursive: true });
    const first = await createHub({
      port: 0,
      databasePath: checkoutHub,
      authSecret: SECRET,
      log: silentLogger,
    });
    await first.stop();

    const report = await runMigration({
      env,
      cwd: box.home,
      platform: "darwin",
      hubDb: checkoutHub,
    });
    expect(report.state).toBe("ready");

    // `ub status`: the layout is the Mac one and the database is the copy.
    const after = await statusReport({ env, cwd: box.home, platform: "darwin" });
    expect(after.report.storage.layout).toBe("mac");
    expect(after.report.databasePath).toBe(
      join(box.mac, "data", "workspaces", `${WORKSPACE}.sqlite`),
    );
    expect(after.report.storage.config).toBe(join(box.mac, "config.json"));
    expect(after.report.storage.hub).toBe(join(box.mac, "data", "hub.sqlite"));

    // `ub doctor`: the legacy warning is gone, replaced by the completed state.
    const doctor = await doctorReport({ env, cwd: box.home, platform: "darwin" });
    const layout = doctor.report.checks.find((one) => one.name === "storage-layout");
    expect(layout?.status).toBe("pass");
    expect(layout?.reason).toContain("mac");
    expect(layout?.reason).not.toContain("legacy-xdg");
    // The note under the check is now the completed state — where the
    // originals are and that removing them is the reader's call — rather than
    // the legacy layout's "this will move them".
    expect(layout?.remedy ?? "").toMatch(/^migrated/);
    expect(layout?.remedy ?? "").toContain(box.configDir);
    expect(layout?.remedy ?? "").toMatch(/remove them yourself/);
    expect(layout?.remedy ?? "").not.toMatch(/moves these under/);

    // `ub workspace list`: the replica it finds is the migrated one.
    const listed = listWorkspaces({ env, cwd: box.home, platform: "darwin" });
    expect(listed.entries.map((entry) => entry.databasePath)).toEqual([
      join(box.mac, "data", "workspaces", `${WORKSPACE}.sqlite`),
    ]);

    // `ub mcp serve` resolves its configuration through exactly this path.
    const resolved = resolveConfig({ env, cwd: box.home, platform: "darwin" });
    expect(resolveMcpConfig(resolved.env, "darwin").databasePath).toBe(
      join(box.mac, "data", "workspaces", `${WORKSPACE}.sqlite`),
    );

    // A hub started with this environment opens the migrated database.
    expect(hubDatabasePath(env, "darwin")).toBe(join(box.mac, "data", "hub.sqlite"));
    const hub = await createHub({
      port: 0,
      databasePath: hubDatabasePath(env, "darwin"),
      authSecret: SECRET,
      log: silentLogger,
    });
    await hub.stop();

    // And the originals are still there, with the report saying what to do
    // about them and never doing it.
    expect(existsSync(join(box.dataDir, `${WORKSPACE}.sqlite`))).toBe(true);
    expect(existsSync(join(box.configDir, "credentials.json"))).toBe(true);
    expect(existsSync(checkoutHub)).toBe(true);
    const text = renderMigration(report);
    expect(text).toContain(box.configDir);
    expect(text).toContain(box.dataDir);
    expect(text).toMatch(/remove them yourself/);
  });

  it("re-runs to `already migrated`, and copies nothing a second time", async () => {
    const box = legacy();
    const first = await runMigration(darwin(box));
    expect(first.state).toBe("ready");
    const published = tree(box.mac);

    const again = await runMigration(darwin(box));

    expect(again.state).toBe("already-migrated");
    expect(again.migrated).toEqual([]);
    expect(again.refusals).toEqual([]);
    expect(tree(box.mac)).toEqual(published);
    const text = renderMigration(again);
    expect(text).toMatch(/already migrated/);
    expect(text).toContain(box.mac);
    expect(text).not.toContain(SECRET);
  });

  it("refuses `already migrated` when the destination lost a recorded file", async () => {
    const box = legacy();
    expect((await runMigration(darwin(box))).state).toBe("ready");
    unlinkSync(join(box.mac, "data", "workspaces", `${WORKSPACE}.sqlite`));
    const before = tree(box.mac);

    const again = await runMigration(darwin(box));

    expect(again.state).toBe("refused");
    expect(refusalText(again)).toContain(`${WORKSPACE}.sqlite`);
    expect(refusalText(again)).toContain(box.configDir);
    // It did not quietly re-migrate over a destination somebody has edited.
    expect(tree(box.mac)).toEqual(before);
    expect(existsSync(join(box.mac, MIGRATION_RECEIPT))).toBe(true);
  });
});
