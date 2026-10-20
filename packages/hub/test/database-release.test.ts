import { copyFileSync, lstatSync, readFileSync, readdirSync, readlinkSync, realpathSync, statSync, symlinkSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import type { HubConfig } from "../src/config.js";
import type { HubLogRecord } from "../src/log.js";
import { createTeamHub, type TeamHub } from "../src/team.js";
import { removeTempDatabases, tempDatabasePath, TEST_SECRET, WORKSPACE } from "./helpers.js";

const filesystem = vi.hoisted(() => ({ failPublish: false }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    linkSync: (...args: Parameters<typeof actual.linkSync>) => {
      if (filesystem.failPublish) {
        throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
      }
      return actual.linkSync(...args);
    },
  };
});

const hubs: TeamHub[] = [];
let loopTick: NodeJS.Timeout;

beforeEach(() => {
  // Native sqlite promises need an event-loop tick in Vitest's VM context.
  loopTick = setInterval(() => {}, 10);
});

afterEach(async () => {
  filesystem.failPublish = false;
  for (const hub of hubs.splice(0)) await hub.stop();
  clearInterval(loopTick);
  removeTempDatabases();
});

async function start(
  databasePath: string,
  hubVersion?: string,
  config: Partial<HubConfig> = {},
): Promise<TeamHub> {
  const hub = await createTeamHub({
    authSecret: TEST_SECRET,
    databasePath,
    port: 0,
    log: () => {},
    ...config,
  }, {
    operatorSetup: true,
    initializeDefaultWorkspace: true,
    ...(hubVersion === undefined ? {} : { hubVersion }),
  });
  hubs.push(hub);
  return hub;
}

async function stop(hub: TeamHub): Promise<void> {
  hubs.splice(hubs.indexOf(hub), 1);
  await hub.stop();
}

function read<T>(databasePath: string, inspect: (database: DatabaseSync) => T): T {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try { return inspect(database); }
  finally { database.close(); }
}

function tables(databasePath: string): string[] {
  return read(databasePath, database => database.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name")
    .all().map(row => String(row.name)));
}

function release(databasePath: string): string | undefined {
  return read(databasePath, database => {
    if (database.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'hub_release'").get() === undefined) return undefined;
    return database.prepare("SELECT version FROM hub_release WHERE id = 1").get()?.version as string | undefined;
  });
}

function backups(databasePath: string): string[] {
  return readdirSync(dirname(databasePath))
    .filter(name => name !== basename(databasePath) && name.endsWith(".sqlite"))
    .map(name => realpathSync(join(dirname(databasePath), name)));
}

function legacyDatabase(version?: string): string {
  const databasePath = tempDatabasePath();
  const document = new Y.Doc();
  const database = new DatabaseSync(databasePath);
  try {
    document.getText("body").insert(0, "saved before the update");
    database.exec(`
      CREATE TABLE documents (name varchar(255) NOT NULL, data blob NOT NULL, UNIQUE(name));
      CREATE TABLE hub_credentials (
        id TEXT PRIMARY KEY NOT NULL, principal_id TEXT NOT NULL, device_id TEXT NOT NULL,
        workspaces TEXT NOT NULL, signing_key BLOB NOT NULL, issued_at INTEGER NOT NULL,
        revoked_at INTEGER
      );
    `);
    database.prepare("INSERT INTO documents VALUES (?, ?)")
      .run(`${WORKSPACE}/a36ca6f0-38ba-4158-b732-33024db524ef`, Y.encodeStateAsUpdate(document));
    database.prepare("INSERT INTO hub_credentials VALUES (?, ?, ?, ?, ?, ?, NULL)")
      .run("old-credential", "principal", "device", JSON.stringify([WORKSPACE]), new Uint8Array([1, 2, 3]), 123);
    if (version !== undefined) {
      database.exec("CREATE TABLE hub_release (id INTEGER PRIMARY KEY CHECK (id = 1), version TEXT NOT NULL)");
      database.prepare("INSERT INTO hub_release VALUES (1, ?)").run(version);
    }
  } finally {
    database.close();
    document.destroy();
  }
  return databasePath;
}

function crashLeftWalDatabase(previous: string, current: string, write?: (database: DatabaseSync) => void): string {
  const source = legacyDatabase(previous);
  const databasePath = tempDatabasePath();
  const writer = new DatabaseSync(source);
  try {
    writer.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0");
    const mainBeforeCommit = readFileSync(source);
    writer.prepare("UPDATE hub_release SET version = ? WHERE id = 1").run(current);
    write?.(writer);
    expect(readFileSync(source)).toEqual(mainBeforeCommit);
    expect(writer.prepare("SELECT version FROM hub_release WHERE id = 1").get()?.version).toBe(current);
    // Freeze a crash snapshot while the writer holds committed pages outside the main file.
    copyFileSync(source, databasePath);
    copyFileSync(`${source}-wal`, `${databasePath}-wal`);
  } finally { writer.close(); }
  return databasePath;
}

function expectCompleteCopy(source: string, backup: string): void {
  expect(realpathSync(dirname(backup))).toBe(realpathSync(dirname(source)));
  expect(realpathSync(backup)).not.toBe(realpathSync(source));
  expect(statSync(backup).mode & 0o777).toBe(0o600);
  read(backup, database => {
    expect(database.prepare("PRAGMA integrity_check").all()).toEqual([{ integrity_check: "ok" }]);
    const saved = database.prepare("SELECT data FROM documents").get()?.data;
    expect(saved).toBeInstanceOf(Uint8Array);
    const document = new Y.Doc();
    try {
      Y.applyUpdate(document, saved as Uint8Array);
      expect(document.getText("body").toString()).toBe("saved before the update");
    } finally { document.destroy(); }
    expect(database.prepare("SELECT signing_key, revoked_at FROM hub_credentials WHERE id = 'old-credential'").get())
      .toEqual({ signing_key: new Uint8Array([1, 2, 3]), revoked_at: null });
  });
}

describe("released database startup", () => {
  it("publishes and logs a complete private legacy copy before the first live write, then skips same-release restarts", async () => {
    const databasePath = legacyDatabase();
    const original = readFileSync(databasePath);
    const originalTables = tables(databasePath);
    const records: HubLogRecord[] = [];
    let bytesWhenLogged: Buffer | undefined;
    const first = await start(databasePath, "1.2.3", {
      log: record => {
        records.push(record);
        if (record.event === "hub.database.backup") bytesWhenLogged = readFileSync(databasePath);
      },
    });

    expect(bytesWhenLogged).toEqual(original);
    const copied = backups(databasePath);
    expect(copied).toHaveLength(1);
    const backup = copied[0]!;
    expect(records.filter(record => record.event === "hub.database.backup")).toEqual([{
      event: "hub.database.backup", database: databasePath, backup, previousRelease: null, release: "1.2.3",
    }]);
    expectCompleteCopy(databasePath, backup);
    expect(tables(backup)).toEqual(originalTables);
    expect(release(backup)).toBeUndefined();
    expect(release(databasePath)).toBe("1.2.3");
    read(databasePath, database => {
      expect(database.prepare("PRAGMA table_info(hub_credentials)").all().map(row => row.name)).not.toContain("signing_key");
      expect(database.prepare("SELECT revoked_at FROM hub_credentials WHERE id = 'old-credential'").get()?.revoked_at).toEqual(expect.any(Number));
    });
    await stop(first);

    records.length = 0;
    await start(databasePath, "1.2.3", { log: record => { records.push(record); } });
    expect(backups(databasePath)).toEqual(copied);
    expect(records.map(record => record.event)).not.toContain("hub.database.backup");
  });

  it.each([
    ["1.2.9", "1.2.10"],
    ["1.9.9", "1.10.0"],
    ["1.99.99", "2.0.0"],
  ])("backs up %s before %s using numeric release ordering", async (previous, current) => {
    const databasePath = legacyDatabase(previous);
    const original = readFileSync(databasePath);
    let bytesWhenLogged: Buffer | undefined;
    await start(databasePath, current, {
      log: record => {
        if (record.event === "hub.database.backup") bytesWhenLogged = readFileSync(databasePath);
      },
    });
    expect(bytesWhenLogged).toEqual(original);
    const copied = backups(databasePath);
    expect(copied).toHaveLength(1);
    expectCompleteCopy(databasePath, copied[0]!);
    expect(release(copied[0]!)).toBe(previous);
    expect(release(databasePath)).toBe(current);
  });

  it.each(["absent", "no-schema"])("records a fresh %s database without a backup", async kind => {
    const databasePath = tempDatabasePath();
    if (kind === "no-schema") new DatabaseSync(databasePath).close();
    const records: HubLogRecord[] = [];
    await start(databasePath, "1.2.3", { log: record => { records.push(record); } });
    expect(release(databasePath)).toBe("1.2.3");
    expect(backups(databasePath)).toEqual([]);
    expect(records.map(record => record.event)).not.toContain("hub.database.backup");
  });

  it("records its release before an existing HMAC credential migration can write", async () => {
    const databasePath = legacyDatabase();
    const brokenLegacy = new DatabaseSync(databasePath);
    try { brokenLegacy.exec("ALTER TABLE hub_credentials DROP COLUMN principal_id"); }
    finally { brokenLegacy.close(); }

    await expect(start(databasePath, "1.2.3")).rejects.toThrow(/no such column: principal_id/);

    expect(release(databasePath)).toBe("1.2.3");
    const copied = backups(databasePath);
    expect(copied).toHaveLength(1);
    expect(release(copied[0]!)).toBeUndefined();
    const credentials = (path: string) => read(path, database => ({
      schema: database.prepare("SELECT sql FROM sqlite_schema WHERE name = 'hub_credentials'").get()?.sql,
      rows: database.prepare("SELECT * FROM hub_credentials").all(),
    }));
    expect(credentials(databasePath)).toEqual(credentials(copied[0]!));
  });

  it.each(["v1.2.3", "1.2.3-preview", "01.2.3"])("refuses malformed runtime release %s before touching the database", async current => {
    const databasePath = legacyDatabase();
    const original = readFileSync(databasePath);
    const records: HubLogRecord[] = [];

    await expect(start(databasePath, current, { log: record => { records.push(record); } }))
      .rejects.toThrow(/invalid hub database release version/);

    expect(readFileSync(databasePath)).toEqual(original);
    expect(readdirSync(dirname(databasePath))).toEqual([basename(databasePath)]);
    expect(records.map(record => record.event)).not.toContain("hub.listen");
  });

  it.each(["not-a-version", "empty-record"])("refuses a malformed %s stored release record unchanged", async previous => {
    const databasePath = legacyDatabase(previous);
    if (previous === "empty-record") {
      const database = new DatabaseSync(databasePath);
      try { database.exec("DELETE FROM hub_release"); }
      finally { database.close(); }
    }
    const original = readFileSync(databasePath);
    const records: HubLogRecord[] = [];

    await expect(start(databasePath, "1.2.3", { log: record => { records.push(record); } }))
      .rejects.toThrow(/invalid hub database release/);

    expect(readFileSync(databasePath)).toEqual(original);
    expect(readdirSync(dirname(databasePath))).toEqual([basename(databasePath)]);
    expect(records.map(record => record.event)).not.toContain("hub.listen");
  });

  it("repeatedly refuses a newer database unchanged and leaves its port available", async () => {
    const databasePath = legacyDatabase("1.10.0");
    const original = readFileSync(databasePath);
    const records: HubLogRecord[] = [];
    const probe = await start(tempDatabasePath());
    const port = probe.port;
    await stop(probe);

    for (let attempt = 0; attempt < 3; attempt++) {
      await expect(start(databasePath, "1.9.99", { port, log: record => { records.push(record); } }))
        .rejects.toThrow(/run hub release 1\.10\.0 instead/);
      expect(readFileSync(databasePath)).toEqual(original);
      expect(readdirSync(dirname(databasePath))).toEqual([basename(databasePath)]);
    }
    expect(records.map(record => record.event)).not.toContain("hub.listen");
    expect((await start(tempDatabasePath(), undefined, { port })).port).toBe(port);
  });

  it("repeatedly refuses a clean closed WAL database without creating sidecars or changing bytes", async () => {
    const databasePath = legacyDatabase("1.10.0");
    const database = new DatabaseSync(databasePath);
    try { database.exec("PRAGMA journal_mode = WAL"); }
    finally { database.close(); }
    expect(readdirSync(dirname(databasePath))).toEqual([basename(databasePath)]);
    const original = readFileSync(databasePath);
    const records: HubLogRecord[] = [];

    for (let attempt = 0; attempt < 3; attempt++) {
      await expect(start(databasePath, "1.9.99", { log: record => { records.push(record); } }))
        .rejects.toThrow(/run hub release 1\.10\.0 instead/);
      expect(readdirSync(dirname(databasePath))).toEqual([basename(databasePath)]);
      expect(readFileSync(databasePath)).toEqual(original);
    }
    expect(records.map(record => record.event)).not.toContain("hub.listen");
  });

  it("honors a newer release committed only in a crash-left WAL without changing its files", async () => {
    const databasePath = crashLeftWalDatabase("1.0.0", "2.0.0");
    const original = readFileSync(databasePath);
    const originalWal = readFileSync(`${databasePath}-wal`);
    const names = [basename(databasePath), `${basename(databasePath)}-wal`].sort();
    const records: HubLogRecord[] = [];

    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(start(databasePath, "1.0.1", { log: record => { records.push(record); } }))
        .rejects.toThrow(/run hub release 2\.0\.0 instead/);
      expect(readdirSync(dirname(databasePath)).sort()).toEqual(names);
      expect(readFileSync(databasePath)).toEqual(original);
      expect(readFileSync(`${databasePath}-wal`)).toEqual(originalWal);
    }
    expect(records.map(record => record.event)).not.toContain("hub.listen");
  });

  it("follows a configured symlink to the real database's newer committed WAL without changing either path", async () => {
    const canonical = crashLeftWalDatabase("1.0.0", "2.0.0");
    const configured = tempDatabasePath();
    symlinkSync(canonical, configured);
    const original = readFileSync(canonical);
    const originalWal = readFileSync(`${canonical}-wal`);
    const records: HubLogRecord[] = [];

    await expect(start(configured, "1.0.1", { log: record => { records.push(record); } }))
      .rejects.toThrow(/run hub release 2\.0\.0 instead/);

    expect(readFileSync(canonical)).toEqual(original);
    expect(readFileSync(`${canonical}-wal`)).toEqual(originalWal);
    expect(readdirSync(dirname(canonical)).sort()).toEqual([basename(canonical), `${basename(canonical)}-wal`].sort());
    expect(readdirSync(dirname(configured))).toEqual([basename(configured)]);
    expect(lstatSync(configured).isSymbolicLink()).toBe(true);
    expect(readlinkSync(configured)).toBe(canonical);
    expect(records.map(record => record.event)).not.toContain("hub.listen");
  });

  it("publishes a symlinked database's startup backup beside the real database with its committed WAL state", async () => {
    const canonical = crashLeftWalDatabase("0.9.0", "1.2.3");
    const configured = tempDatabasePath();
    symlinkSync(canonical, configured);

    await start(configured, "1.2.4");

    const copied = backups(canonical);
    expect(copied).toHaveLength(1);
    expectCompleteCopy(canonical, copied[0]!);
    expect(release(copied[0]!)).toBe("1.2.3");
    expect(release(canonical)).toBe("1.2.4");
    expect(backups(configured)).toEqual([]);
    expect(lstatSync(configured).isSymbolicLink()).toBe(true);
    expect(readlinkSync(configured)).toBe(canonical);
  });

  it("backs up the complete committed WAL state before a newer release writes the original files", async () => {
    const databasePath = crashLeftWalDatabase("0.9.0", "1.2.3", database => {
      database.exec("CREATE TABLE wal_only (value TEXT); INSERT INTO wal_only VALUES ('committed only in WAL')");
      const document = new Y.Doc();
      try {
        document.getText("body").insert(0, "document committed only in WAL");
        database.prepare("INSERT INTO documents VALUES (?, ?)")
          .run(`${WORKSPACE}/88121a57-e140-4827-a79b-54a4db533ed3`, Y.encodeStateAsUpdate(document));
      } finally { document.destroy(); }
    });
    const original = readFileSync(databasePath);
    const originalWal = readFileSync(`${databasePath}-wal`);
    let mainWhenLogged: Buffer | undefined;
    let walWhenLogged: Buffer | undefined;
    let namesWhenLogged: string[] | undefined;

    await start(databasePath, "1.2.4", {
      log: record => {
        if (record.event !== "hub.database.backup") return;
        mainWhenLogged = readFileSync(databasePath);
        walWhenLogged = readFileSync(`${databasePath}-wal`);
        namesWhenLogged = readdirSync(dirname(databasePath)).sort();
      },
    });

    expect(mainWhenLogged).toEqual(original);
    expect(walWhenLogged).toEqual(originalWal);
    const copied = backups(databasePath);
    expect(copied).toHaveLength(1);
    const backup = copied[0]!;
    expect(namesWhenLogged).toEqual([basename(databasePath), `${basename(databasePath)}-wal`, basename(backup)].sort());
    expectCompleteCopy(databasePath, backup);
    expect(release(backup)).toBe("1.2.3");
    read(backup, database => {
      expect(database.prepare("SELECT value FROM wal_only").get()?.value).toBe("committed only in WAL");
      expect(database.prepare("SELECT count(*) AS count FROM documents").get()?.count).toBe(2);
      const document = new Y.Doc();
      try {
        const row = database.prepare("SELECT data FROM documents WHERE name = ?")
          .get(`${WORKSPACE}/88121a57-e140-4827-a79b-54a4db533ed3`);
        Y.applyUpdate(document, row?.data as Uint8Array);
        expect(document.getText("body").toString()).toBe("document committed only in WAL");
      } finally { document.destroy(); }
    });
    expect(release(databasePath)).toBe("1.2.4");
  });

  it("fails before any live write or listener if backup publication runs out of space", async () => {
    const databasePath = legacyDatabase();
    const original = readFileSync(databasePath);
    const records: HubLogRecord[] = [];
    const probe = await start(tempDatabasePath());
    const port = probe.port;
    await stop(probe);

    filesystem.failPublish = true;
    await expect(start(databasePath, "1.2.3", { port, log: record => { records.push(record); } }))
      .rejects.toThrow(/cannot back up.*ENOSPC.*database was unchanged/);
    filesystem.failPublish = false;

    expect(readFileSync(databasePath)).toEqual(original);
    expect(readdirSync(dirname(databasePath))).toEqual([basename(databasePath)]);
    expect(records.map(record => record.event)).not.toContain("hub.database.backup");
    expect(records.map(record => record.event)).not.toContain("hub.listen");
    expect((await start(tempDatabasePath(), undefined, { port })).port).toBe(port);
  });

  it("leaves a clean closed WAL database unchanged and creates no sidecars when its backup fails", async () => {
    const databasePath = legacyDatabase();
    const database = new DatabaseSync(databasePath);
    try { database.exec("PRAGMA journal_mode = WAL"); }
    finally { database.close(); }
    expect(readdirSync(dirname(databasePath))).toEqual([basename(databasePath)]);
    const original = readFileSync(databasePath);
    const records: HubLogRecord[] = [];

    filesystem.failPublish = true;
    await expect(start(databasePath, "1.2.3", { log: record => { records.push(record); } }))
      .rejects.toThrow(/cannot back up.*ENOSPC.*database was unchanged/);
    filesystem.failPublish = false;

    expect(readdirSync(dirname(databasePath))).toEqual([basename(databasePath)]);
    expect(readFileSync(databasePath)).toEqual(original);
    expect(records.map(record => record.event)).not.toContain("hub.database.backup");
    expect(records.map(record => record.event)).not.toContain("hub.listen");
  });

  it("discards an integrity-check failure before any live write or listener", async () => {
    const databasePath = legacyDatabase();
    const database = new DatabaseSync(databasePath);
    try {
      database.exec("CREATE TABLE constrained (value INTEGER CHECK(value = 1)); PRAGMA ignore_check_constraints = ON; INSERT INTO constrained VALUES (0)");
    } finally { database.close(); }
    const original = readFileSync(databasePath);
    const records: HubLogRecord[] = [];

    await expect(start(databasePath, "1.2.3", { log: record => { records.push(record); } }))
      .rejects.toThrow(/integrity_check failed: CHECK constraint failed/);

    expect(readFileSync(databasePath)).toEqual(original);
    expect(readdirSync(dirname(databasePath))).toEqual([basename(databasePath)]);
    expect(records.map(record => record.event)).not.toContain("hub.database.backup");
    expect(records.map(record => record.event)).not.toContain("hub.listen");
  });

  it.each([undefined, "999.0.0"])("leaves release tracking disabled for an unversioned hub on a %s record", async previous => {
    const databasePath = legacyDatabase(previous);
    const records: HubLogRecord[] = [];
    await start(databasePath, undefined, { log: record => { records.push(record); } });
    expect(release(databasePath)).toBe(previous);
    expect(backups(databasePath)).toEqual([]);
    expect(records.map(record => record.event)).not.toContain("hub.database.backup");
  });
});
