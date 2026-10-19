import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DEVICE_CREDENTIAL_LIFETIME_MS } from "@uberblick/schema/token";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { adminSocketPath } from "../src/admin-setup.js";
import { restoreDatabase } from "../src/operator-database.js";

const directories: string[] = [];
const servers: Server[] = [];
const workspace = "00000000-0000-4000-8000-000000000001";
const otherWorkspace = "00000000-0000-4000-8000-000000000002";
const device = "00000000-0000-4000-8000-000000000003";
const otherDevice = "00000000-0000-4000-8000-000000000004";
const key = Buffer.from("public-key-material-for-test-only").subarray(0, 32);
let originalDirectory: string;

beforeEach(() => {
  originalDirectory = process.cwd();
  process.chdir(tmpdir());
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const server of servers.splice(0)) {
    await new Promise<void>((accept, reject) => server.close(error => error ? reject(error) : accept()));
  }
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
  process.chdir(originalDirectory);
});

function directory(): string {
  const path = mkdtempSync(join(realpathSync(tmpdir()), `ora-${process.env.UB_AGENTS_RUN ?? "test"}-`));
  directories.push(path);
  return path;
}

function fixture(path: string, options: { olderColumns?: boolean; legacyHmac?: boolean; admins?: boolean; wal?: boolean } = {}): DatabaseSync {
  const database = new DatabaseSync(path);
  if (options.wal) database.exec("PRAGMA journal_mode = WAL");
  database.exec(`CREATE TABLE documents (name TEXT UNIQUE, data BLOB);
    INSERT INTO documents VALUES ('backup-document', X'01');
    CREATE TABLE hub_principals (id TEXT PRIMARY KEY NOT NULL, github_account_id TEXT UNIQUE NOT NULL,
      github_username TEXT NOT NULL, has_signed_in INTEGER NOT NULL DEFAULT 0);
    INSERT INTO hub_principals VALUES ('alice', '101', 'alice-login', 1), ('bob', '202', 'bob-login', 1);
    CREATE TABLE hub_credentials (id TEXT PRIMARY KEY NOT NULL, principal_id TEXT NOT NULL,
      device_id TEXT NOT NULL, ${options.olderColumns ? "" : "device_name TEXT,"}
      workspaces TEXT NOT NULL, ${options.legacyHmac ? "signing_key BLOB NOT NULL" : "public_key BLOB CHECK(public_key IS NULL OR length(public_key) = 32)"},
      issued_at INTEGER NOT NULL, revoked_at INTEGER ${options.olderColumns ? "" : ", replaced_at INTEGER"});
    CREATE TABLE hub_memberships (workspace_id TEXT NOT NULL,
      principal_id TEXT NOT NULL CHECK(length(principal_id) > 0),
      role TEXT NOT NULL CHECK(role IN ('admin', 'member')), PRIMARY KEY (workspace_id, principal_id));`);
  if (options.admins !== false) {
    database.exec("CREATE TABLE hub_admins (principal_id TEXT PRIMARY KEY NOT NULL CHECK(length(principal_id) > 0))");
  }
  return database;
}

function credential(database: DatabaseSync, id: string, options: {
  principal?: string; device?: string; name?: string; issued?: number; revoked?: number; replaced?: number; noKey?: boolean;
} = {}): void {
  database.prepare(`INSERT INTO hub_credentials
    (id, principal_id, device_id, device_name, workspaces, public_key, issued_at, revoked_at, replaced_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, options.principal ?? "alice", options.device ?? device, options.name ?? null, "[]",
      options.noKey ? null : key, options.issued ?? Date.now(), options.revoked ?? null, options.replaced ?? null);
}

function revokedPair(options: { wal?: boolean } = {}): { root: string; live: string; candidate: string } {
  const root = directory();
  const live = join(root, "hub.sqlite");
  const candidate = join(directory(), "backup.sqlite");
  const backup = fixture(candidate);
  credential(backup, "credential", { name: "lost-laptop" });
  backup.close();
  const current = fixture(live, options);
  credential(current, "credential", { name: "lost-laptop", revoked: 0 });
  current.close();
  return { root, live, candidate };
}

function expectRecovery(output: string): void {
  expect(output).toContain("ub auth logout --all-devices <hub>");
  expect(output).toContain("user menu → Devices");
  expect(output).toContain("ub workspace member remove");
  expect(output).toContain("Workspace settings → Members");
  expect(output).toContain("Hub → Admins");
  expect(output).toMatch(/each account/i);
  expect(output).toMatch(/workspace admins/i);
  expect(output).toMatch(/hub admins/i);
}

describe("restore access rollback reporting", () => {
  it("lists every restored access identity before a refusal and leaves a WAL-mode live file byte-identical without sidecars", async () => {
    const { root, live, candidate } = revokedPair({ wal: true });
    const backup = new DatabaseSync(candidate);
    credential(backup, "other-credential", { principal: "bob", device: otherDevice });
    backup.prepare("INSERT INTO hub_memberships VALUES (?, 'alice', 'member'), (?, 'bob', 'member')").run(workspace, otherWorkspace);
    backup.exec("INSERT INTO hub_admins VALUES ('alice'), ('bob')");
    backup.close();
    const current = new DatabaseSync(live);
    credential(current, "other-credential", { principal: "bob", device: otherDevice, revoked: Date.now() });
    current.exec("INSERT INTO hub_admins VALUES ('alice')");
    current.close();
    const original = readFileSync(live);
    const lines: string[] = [];
    const confirm = vi.fn(async () => {
      const output = lines.join("\n");
      expect(output).toContain('"alice-login" (GitHub account 101)');
      expect(output).toContain('"bob-login" (GitHub account 202)');
      expect(output).toContain(`device "lost-laptop" (${device})`);
      expect(output).toContain(otherDevice);
      expect(output).toContain(`workspace ${workspace}`);
      expect(output).toContain(`workspace ${otherWorkspace}`);
      expect(output).toContain('hub-admin removal: "bob-login"');
      expect(output).not.toContain('hub-admin removal: "alice-login"');
      expect(output).not.toContain(key.toString());
      expectRecovery(output);
      expect(readFileSync(live)).toEqual(original);
      expect(readdirSync(root)).toEqual(["hub.sqlite"]);
      return false;
    });
    await expect(restoreDatabase(live, candidate, { confirm, writeLine: line => lines.push(line) }))
      .rejects.toThrow("live database was unchanged");
    expect(confirm).toHaveBeenCalledOnce();
    expect(readFileSync(live)).toEqual(original);
    expect(readdirSync(root)).toEqual(["hub.sqlite"]);
  });

  it("requires --yes without a confirmation terminal and preserves the live file", async () => {
    const { root, live, candidate } = revokedPair();
    const original = readFileSync(live);
    await expect(restoreDatabase(live, candidate, { writeLine: () => {} })).rejects.toThrow("--yes");
    expect(readFileSync(live)).toEqual(original);
    expect(readdirSync(root)).toEqual(["hub.sqlite"]);
  });

  it("keeps the live file unchanged when the prompt is interrupted", async () => {
    const { root, live, candidate } = revokedPair();
    const original = readFileSync(live);
    const abort = new AbortController();
    await expect(restoreDatabase(live, candidate, {
      signal: abort.signal,
      writeLine: () => {},
      confirm: async () => {
        abort.abort(new Error("interrupted prompt"));
        return true;
      },
    })).rejects.toThrow("live database was unchanged");
    expect(readFileSync(live)).toEqual(original);
    expect(readdirSync(root)).toEqual(["hub.sqlite"]);
  });

  it.each(["--yes", "terminal"])("honors %s confirmation and restores the backup's access records unchanged", async route => {
    const { live, candidate } = revokedPair();
    const confirm = vi.fn(async () => route === "terminal");
    const lines: string[] = [];
    await restoreDatabase(live, candidate, { yes: route === "--yes", confirm, writeLine: line => lines.push(line) });
    if (route === "--yes") expect(confirm).not.toHaveBeenCalled();
    else expect(confirm).toHaveBeenCalledOnce();
    expect(lines.join("\n")).toContain("device revocation:");
    const restored = new DatabaseSync(live, { readOnly: true });
    try {
      expect(restored.prepare("SELECT revoked_at, public_key FROM hub_credentials WHERE id = 'credential'").get())
        .toEqual({ revoked_at: null, public_key: new Uint8Array(key) });
    } finally { restored.close(); }
  });

  it("does not ask when the backup cannot revive any credential and does not treat role changes as removals", async () => {
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now);
    const live = join(directory(), "hub.sqlite");
    const candidate = join(directory(), "backup.sqlite");
    const backup = fixture(candidate);
    credential(backup, "already-revoked", { revoked: now - 1 });
    credential(backup, "already-replaced", { replaced: now - 1 });
    credential(backup, "expired", { issued: now - DEVICE_CREDENTIAL_LIFETIME_MS - 1 });
    credential(backup, "expiry-boundary", { issued: now - DEVICE_CREDENTIAL_LIFETIME_MS });
    credential(backup, "missing-key", { noKey: true });
    credential(backup, "still-current");
    backup.prepare("INSERT INTO hub_memberships VALUES (?, 'alice', 'admin')").run(workspace);
    backup.exec("INSERT INTO hub_admins VALUES ('alice')");
    backup.close();
    const current = fixture(live);
    for (const id of ["already-revoked", "already-replaced", "expired", "expiry-boundary", "missing-key"]) {
      credential(current, id, { revoked: now });
    }
    credential(current, "still-current");
    current.prepare("INSERT INTO hub_memberships VALUES (?, 'alice', 'member')").run(workspace);
    current.exec("INSERT INTO hub_admins VALUES ('alice')");
    current.close();
    const confirm = vi.fn(async () => false);
    const lines: string[] = [];
    await restoreDatabase(live, candidate, { confirm, writeLine: line => lines.push(line) });
    expect(confirm).not.toHaveBeenCalled();
    expect(lines.join("\n")).toMatch(/would be undone/i);
    expect(lines.join("\n")).not.toContain("device revocation:");
  });

  it("skips HMAC credentials that the restored hub revokes on open", async () => {
    const live = join(directory(), "hub.sqlite");
    const candidate = join(directory(), "backup.sqlite");
    const backup = fixture(candidate, { legacyHmac: true, olderColumns: true, admins: false });
    backup.prepare("INSERT INTO hub_credentials VALUES ('old-key', 'alice', ?, '[]', ?, ?, NULL)")
      .run(device, Buffer.from("private-signing-secret"), Date.now());
    backup.close();
    const current = fixture(live);
    credential(current, "old-key", { revoked: Date.now() });
    current.close();
    const confirm = vi.fn(async () => false);
    const lines: string[] = [];
    await restoreDatabase(live, candidate, { confirm, writeLine: line => lines.push(line) });
    expect(confirm).not.toHaveBeenCalled();
    expect(lines.join("\n")).toMatch(/would be undone/i);
    expect(lines.join("\n")).not.toContain("private-signing-secret");
  });

  it("compares older public-key credentials without device names or replacement columns", async () => {
    const live = join(directory(), "hub.sqlite");
    const candidate = join(directory(), "backup.sqlite");
    const backup = fixture(candidate, { olderColumns: true });
    backup.prepare("INSERT INTO hub_credentials VALUES ('older-key', 'alice', ?, '[]', ?, ?, NULL)")
      .run(device, key, Date.now());
    backup.exec("INSERT INTO hub_admins VALUES ('bob')");
    backup.close();
    const current = fixture(live, { olderColumns: true, admins: false });
    current.prepare("INSERT INTO hub_credentials VALUES ('older-key', 'alice', ?, '[]', ?, ?, ?)")
      .run(device, key, Date.now(), Date.now());
    current.close();
    const lines: string[] = [];
    await expect(restoreDatabase(live, candidate, { confirm: async () => false, writeLine: line => lines.push(line) }))
      .rejects.toThrow("live database was unchanged");
    expect(lines.join("\n")).toContain(device);
    expect(lines.join("\n")).not.toContain("hub-admin removal:");
  });

  it.each(["absent", "unreadable"])("explains unknown newer access changes for an %s live database and proceeds without asking", async kind => {
    const root = directory();
    const live = join(root, "hub.sqlite");
    if (kind === "unreadable") writeFileSync(live, "not a SQLite database");
    const candidate = join(directory(), "backup.sqlite");
    const backup = fixture(candidate);
    credential(backup, "credential");
    backup.close();
    const lines: string[] = [];
    const confirm = vi.fn(async () => false);
    await restoreDatabase(live, candidate, { confirm, writeLine: line => lines.push(line) });
    expect(confirm).not.toHaveBeenCalled();
    const output = lines.join("\n");
    expect(output).toMatch(/newer device revocations.*member removals.*hub-admin removals.*can.t be determined/i);
    expectRecovery(output);
    const restored = new DatabaseSync(live, { readOnly: true });
    try { expect(restored.prepare("SELECT name FROM documents").get()?.name).toBe("backup-document"); }
    finally { restored.close(); }
    expect(readdirSync(root)).toEqual(["hub.sqlite"]);
  });

  it("refuses a hub that starts while confirmation is pending", async () => {
    const { root, live, candidate } = revokedPair();
    const original = readFileSync(live);
    await expect(restoreDatabase(live, candidate, {
      writeLine: () => {},
      confirm: async () => {
        mkdirSync(`${live}.admin`, { mode: 0o700 });
        const server = createServer(socket => socket.destroy());
        servers.push(server);
        server.listen(adminSocketPath(live));
        await once(server, "listening");
        return true;
      },
    })).rejects.toThrow("docker compose stop hub");
    expect(readFileSync(live)).toEqual(original);
    expect(readdirSync(root).sort()).toEqual(["hub.sqlite", "hub.sqlite.admin"]);
  });
});
