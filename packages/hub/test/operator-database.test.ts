import { once } from "node:events";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { PassThrough, Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { adminSocketPath } from "../src/admin-setup.js";
import { HubClaimState } from "../src/hub-claim.js";
import { backupDatabase, checkDatabaseIntegrity, restoreDatabase } from "../src/operator-database.js";
import { HubDatabase } from "../src/persistence.js";

const directories: string[] = [];
const databases: DatabaseSync[] = [];
const servers: Server[] = [];
let originalDirectory: string;
let loopTick: NodeJS.Timeout;

beforeEach(() => {
  originalDirectory = process.cwd();
  process.chdir(tmpdir());
  // Native sqlite promises need an event-loop tick in Vitest's VM context.
  loopTick = setInterval(() => {}, 10);
});

function directory(): string {
  const path = mkdtempSync(join(tmpdir(), `odb-${process.env.UB_AGENTS_RUN ?? "test"}-`));
  directories.push(path);
  return path;
}

function database(path: string, content = "new"): DatabaseSync {
  const db = new DatabaseSync(path);
  databases.push(db);
  db.exec("CREATE TABLE documents (name TEXT UNIQUE, data BLOB)");
  db.prepare("INSERT INTO documents VALUES (?, ?)").run(content, new Uint8Array([1, 2, 3]));
  return db;
}

function contents(path: string): string {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    checkDatabaseIntegrity(db);
    return db.prepare("SELECT name FROM documents").get()?.name as string;
  } finally { db.close(); }
}

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((accept, reject) => server.close((error) => error ? reject(error) : accept()));
  }
  for (const db of databases.splice(0)) if (db.isOpen) db.close();
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
  process.chdir(originalDirectory);
  clearInterval(loopTick);
});

describe("online backup", () => {
  it("publishes separate complete private copies while the source remains writable", async () => {
    const path = join(directory(), "hub.sqlite");
    const db = database(path);
    const first = await backupDatabase(db, path);
    db.prepare("INSERT INTO documents VALUES (?, ?)").run("later", new Uint8Array([4]));
    const second = await backupDatabase(db, path);
    expect(first).not.toBe(second);
    expect(contents(first)).toBe("new");
    for (const backup of [first, second]) {
      expect(statSync(backup).mode & 0o777).toBe(0o600);
      expect(statSync(backup).uid).toBe(process.getuid?.());
    }
    expect(readdirSync(dirname(path)).filter((name) => name.startsWith(".hub-backup-"))).toEqual([]);
    const copy = new DatabaseSync(second, { readOnly: true });
    try { expect(copy.prepare("SELECT count(*) AS count FROM documents").get()?.count).toBe(2); }
    finally { copy.close(); }
  });

  it("publishes nothing when a store failure is detected before publication", async () => {
    const path = join(directory(), "hub.sqlite");
    const db = database(path);
    await expect(backupDatabase(db, path, undefined, () => { throw new Error("store was not durable"); }))
      .rejects.toThrow("not durable");
    expect(readdirSync(dirname(path))).toEqual(["hub.sqlite"]);
    db.prepare("INSERT INTO documents VALUES (?, ?)").run("still serving", new Uint8Array([4]));
  });

  it("discards a copy that fails its own integrity check", async () => {
    const path = join(directory(), "hub.sqlite");
    const db = database(path);
    db.exec("CREATE TABLE constrained (value INTEGER CHECK(value = 1)); PRAGMA ignore_check_constraints = ON; INSERT INTO constrained VALUES (0)");
    await expect(backupDatabase(db, path)).rejects.toThrow("CHECK constraint failed");
    expect(readdirSync(dirname(path))).toEqual(["hub.sqlite"]);
    expect(db.isOpen).toBe(true);
  });

  it("discards an interrupted copy and keeps its database open", async () => {
    const path = join(directory(), "hub.sqlite");
    const db = database(path);
    db.prepare("INSERT INTO documents VALUES ('large', zeroblob(16000000))").run();
    const controller = new AbortController();
    const copying = backupDatabase(db, path, controller.signal);
    controller.abort(new Error("interrupted"));
    await expect(copying).rejects.toThrow("interrupted");
    expect(readdirSync(dirname(path))).toEqual(["hub.sqlite"]);
    expect(db.isOpen).toBe(true);
  });

  it("leaves no named copy on an unwritable destination", async () => {
    const root = directory();
    const path = join(root, "hub.sqlite");
    const db = database(path);
    const fileInsteadOfDirectory = join(root, "blocked");
    writeFileSync(fileInsteadOfDirectory, "blocked");
    await expect(backupDatabase(db, join(fileInsteadOfDirectory, "hub.sqlite"))).rejects.toThrow();
    expect(readdirSync(root).sort()).toEqual(["blocked", "hub.sqlite"]);
  });
});

describe("offline restore", () => {
  it("restores a legacy document-only file with one private owned replacement", async () => {
    const root = directory();
    const live = join(root, "hub.sqlite");
    database(live, "old").close();
    const candidate = join(directory(), "legacy.sqlite");
    database(candidate).close();
    chmodSync(candidate, 0o644);
    await restoreDatabase(live, candidate);
    expect(contents(live)).toBe("new");
    expect(statSync(live).mode & 0o777).toBe(0o600);
    expect(statSync(live).uid).toBe(process.getuid?.());
    expect(readdirSync(root)).toEqual(["hub.sqlite"]);
  });

  it("restores a sealed installation without documents from stdin into an empty volume, keeping claiming closed", async () => {
    const candidate = join(directory(), "sealed.sqlite");
    const db = new DatabaseSync(candidate);
    db.exec(`CREATE TABLE documents (name TEXT UNIQUE, data BLOB);
      CREATE TABLE hub_claim_state (id INTEGER PRIMARY KEY, default_workspace_id TEXT, unclaimed INTEGER NOT NULL);
      INSERT INTO hub_claim_state VALUES (1, NULL, 0)`);
    db.close();
    const live = join(directory(), "hub.sqlite");
    await restoreDatabase(live, Readable.from(readFileSync(candidate)));
    const restored = new HubDatabase(live, () => {});
    restored.open();
    try {
      expect(new HubClaimState(restored).state(true)).toEqual({ unclaimed: false, canClaim: false });
      expect(restored.connection.prepare("SELECT * FROM hub_claim_state").all())
        .toEqual([{ id: 1, default_workspace_id: null, unclaimed: 0 }]);
      expect(restored.connection.prepare("SELECT count(*) AS count FROM documents").get()?.count).toBe(0);
    } finally { restored.close(); }
  });

  it("restores a first-admin grant and receipt without documents over a document-only database", async () => {
    const live = join(directory(), "hub.sqlite");
    database(live, "old").close();
    const candidate = join(directory(), "first-admin.sqlite");
    const db = new DatabaseSync(candidate);
    db.exec(`CREATE TABLE documents (name TEXT, data BLOB);
      CREATE TABLE hub_principals (id TEXT, github_account_id TEXT, github_username TEXT);
      CREATE TABLE hub_memberships (workspace_id TEXT, principal_id TEXT, role TEXT);
      CREATE TABLE hub_admin_setup_grants (setup_id TEXT, workspace_id TEXT, principal_id TEXT,
        github_account_id TEXT, github_username TEXT, had_documents INTEGER);
      INSERT INTO hub_principals VALUES ('principal', '1234', 'first-admin');
      INSERT INTO hub_memberships VALUES ('workspace', 'principal', 'admin');
      INSERT INTO hub_admin_setup_grants VALUES ('setup', 'workspace', 'principal', '1234', 'first-admin', 0)`);
    db.close();
    await restoreDatabase(live, candidate);
    expect(readFileSync(live)).toEqual(readFileSync(candidate));
  });

  it.each(["empty", "corrupt"])("refuses a %s candidate without touching the volume", async (kind) => {
    const root = directory();
    const live = join(root, "hub.sqlite");
    database(live, "old").close();
    const original = readFileSync(live);
    const candidate = join(directory(), "bad.sqlite");
    if (kind === "corrupt") writeFileSync(candidate, "not sqlite");
    else {
      // An access table that exists but holds no rows is not state worth restoring.
      const db = new DatabaseSync(candidate);
      db.exec("CREATE TABLE documents (name TEXT, data BLOB); CREATE TABLE hub_memberships (workspace_id TEXT, principal_id TEXT, role TEXT)");
      db.close();
    }
    await expect(restoreDatabase(live, candidate)).rejects.toThrow("live database was unchanged");
    expect(readFileSync(live)).toEqual(original);
    expect(readdirSync(root)).toEqual(["hub.sqlite"]);
  });

  it("refuses an answering hub and names the stop command without staging", async () => {
    const root = directory();
    const live = join(root, "hub.sqlite");
    database(live, "old").close();
    const candidate = join(directory(), "backup.sqlite");
    database(candidate).close();
    const controlSocketPath = adminSocketPath(live);
    mkdirSync(`${live}.admin`, { mode: 0o700 });
    const server = createServer((socket) => socket.destroy());
    servers.push(server);
    server.listen(controlSocketPath);
    await once(server, "listening");
    await expect(restoreDatabase(live, candidate)).rejects.toThrow("docker compose stop hub");
    expect(contents(live)).toBe("old");
    expect(readdirSync(root).sort()).toEqual(["hub.sqlite", "hub.sqlite.admin"]);
  });

  it("preserves a journal and names SQLite recovery before it creates a staging file", async () => {
    const root = directory();
    const live = join(root, "hub.sqlite");
    database(live, "old").close();
    const original = readFileSync(live);
    const candidate = join(directory(), "backup.sqlite");
    database(candidate).close();
    writeFileSync(`${live}-journal`, "interrupted transaction");
    await expect(restoreDatabase(live, candidate)).rejects.toThrow("docker compose start hub");
    expect(readFileSync(live)).toEqual(original);
    expect(readFileSync(`${live}-journal`, "utf8")).toBe("interrupted transaction");
    expect(readdirSync(root).sort()).toEqual(["hub.sqlite", "hub.sqlite-journal"]);
  });

  it("cancels an incomplete stdin stream without changing the volume", async () => {
    const root = directory();
    const live = join(root, "hub.sqlite");
    database(live, "old").close();
    const original = readFileSync(live);
    const input = new PassThrough();
    const controller = new AbortController();
    const restoring = restoreDatabase(live, input, { signal: controller.signal });
    input.write("partial");
    controller.abort(new Error("interrupted"));
    await expect(restoring).rejects.toThrow("live database was unchanged");
    expect(readFileSync(live)).toEqual(original);
    expect(readdirSync(root)).toEqual(["hub.sqlite"]);
  });

  it("leaves the original database whole if the volume refuses the final rename", async () => {
    const root = directory();
    const live = join(root, "hub.sqlite");
    mkdirSync(live);
    writeFileSync(join(live, "original"), "untouched");
    const candidate = join(directory(), "backup.sqlite");
    database(candidate).close();
    await expect(restoreDatabase(live, candidate)).rejects.toThrow("live database was unchanged");
    expect(readFileSync(join(live, "original"), "utf8")).toBe("untouched");
    expect(readdirSync(root)).toEqual(["hub.sqlite"]);
  });
});
