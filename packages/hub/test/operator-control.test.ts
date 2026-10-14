import { chmodSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { requestOperator } from "../src/operator-client.js";
import { adminSocketPath } from "../src/admin-setup.js";
import { runOperatorCommand } from "../src/operator-command.js";
import { createTeamHub, type TeamHub } from "../src/team.js";
import { createClient, removeTempDatabases, tempDatabasePath, TEST_SECRET, testRoom, token, waitUntil, type TestClient } from "./helpers.js";

const hubs: TeamHub[] = [];
const clients: TestClient[] = [];
let originalDirectory: string;

beforeEach(() => {
  originalDirectory = process.cwd();
  process.chdir(tmpdir());
});

afterEach(async () => {
  vi.restoreAllMocks();
  process.exitCode = 0;
  for (const client of clients.splice(0)) client.destroy();
  for (const hub of hubs.splice(0)) await hub.stop().catch(() => {});
  removeTempDatabases();
  process.chdir(originalDirectory);
});

async function rig() {
  const hub = await createTeamHub({ databasePath: tempDatabasePath(), port: 0, authSecret: TEST_SECRET,
    log: () => {}, debounce: 60_000, maxDebounce: 60_000 },
    { operatorSetup: true, initializeDefaultWorkspace: true });
  hubs.push(hub);
  return hub;
}

async function edited(hub: TeamHub) {
  const room = testRoom();
  const client = createClient({ port: hub.port, room, token: await token() });
  clients.push(client);
  await client.synced;
  client.doc.getText("content").insert(0, "received before backup");
  await waitUntil("update reaches serving hub", () => hub.hocuspocus.documents.get(room)?.getText("content").toString() === "received before backup");
  return room;
}

it("reports live claim/database facts and flushes pending updates into a private verified backup while serving", async () => {
  const hub = await rig();
  const status = await requestOperator(hub.databasePath, "hub-status");
  expect(status).toMatchObject({ status: "ok", info: { databasePath: hub.databasePath, claimed: false, documentCount: 1, port: hub.port } });
  const room = await edited(hub);
  const result = await requestOperator(hub.databasePath, "backup");
  expect(result.status).toBe("complete");
  const path = result.path as string;
  expect(dirname(path)).toBe(dirname(hub.databasePath));
  expect(statSync(path).mode & 0o777).toBe(0o600);
  const copy = new DatabaseSync(path, { readOnly: true });
  try {
    expect(Object.values(copy.prepare("PRAGMA integrity_check").get()!)).toEqual(["ok"]);
    const row = copy.prepare("SELECT data FROM documents WHERE name = ?").get(room)!;
    const document = new Y.Doc();
    try {
      Y.applyUpdate(document, row.data as Uint8Array);
      expect(document.getText("content").toString()).toBe("received before backup");
    } finally { document.destroy(); }
  } finally { copy.close(); }
  expect((await fetch(`http://127.0.0.1:${hub.port}/auth/claim-state`)).status).toBe(200);
  const next = await requestOperator(hub.databasePath, "backup");
  expect(next.path).not.toBe(path);
  expect(readdirSync(dirname(hub.databasePath)).filter(file => file.includes("backing-up"))).toEqual([]);
});

it("refuses backups after a swallowed document store failure without stopping service or publishing a copy", async () => {
  const hub = await rig();
  const db = new DatabaseSync(hub.databasePath);
  db.exec("CREATE TRIGGER fail_store BEFORE INSERT ON documents BEGIN SELECT RAISE(ABORT, 'injected store failure'); END");
  db.close();
  await edited(hub);
  const before = readdirSync(dirname(hub.databasePath));
  const backup = await requestOperator(hub.databasePath, "backup");
  expect(backup).toMatchObject({ status: "failed" });
  expect(backup.error).toContain("document store failed");
  expect(readdirSync(dirname(hub.databasePath))).toEqual(before);
  expect(await requestOperator(hub.databasePath, "hub-doctor")).toMatchObject({ status: "ok", info: { integrity: ["ok"], storeFailure: expect.stringContaining("injected store failure") } });
  expect((await fetch(`http://127.0.0.1:${hub.port}/auth/claim-state`)).status).toBe(200);
});

it("disconnecting an interrupted backup before flush completes leaves no named backup and keeps the hub serving", async () => {
  const hub = await rig();
  await edited(hub);
  let release!: () => void;
  const paused = new Promise<void>(accept => { release = accept; });
  let entered = false;
  const original = hub.hocuspocus.storeDocumentHooks.bind(hub.hocuspocus);
  vi.spyOn(hub.hocuspocus, "storeDocumentHooks").mockImplementation(async (...args) => {
    entered = true;
    await paused;
    return original(...args);
  });
  const abort = new AbortController();
  const result = requestOperator(hub.databasePath, "backup", abort.signal).catch(error => error);
  try {
    await waitUntil("backup flush begins", () => entered);
    abort.abort();
    expect(String(await result)).toContain("interrupted");
  } finally { release(); }
  await hub.flush();
  await waitUntil("cancelled backup is cleaned up", () => readdirSync(dirname(hub.databasePath)).every(file => !file.includes("backup")));
  expect(readdirSync(dirname(hub.databasePath)).filter(file => file.includes("backup"))).toEqual([]);
  expect((await requestOperator(hub.databasePath, "hub-status")).status).toBe("ok");
});

it("operator capabilities have no HTTP route", async () => {
  const hub = await rig();
  const before = readdirSync(dirname(hub.databasePath));
  for (const path of ["/auth/hub-status", "/auth/hub-doctor", "/auth/backup", "/backup", "/admin-setup"]) {
    const response = await fetch(`http://127.0.0.1:${hub.port}${path}`, { method: "POST", body: JSON.stringify({ action: "backup" }) });
    expect(await response.text()).not.toContain("databasePath");
  }
  expect(readdirSync(dirname(hub.databasePath))).toEqual(before);
});

it.each(["documents", "hub_claim_state"])("keeps the running hub observable when its %s table is damaged", async table => {
  const hub = await rig();
  const database = new DatabaseSync(hub.databasePath);
  try { database.exec(`DROP TABLE ${table}`); } finally { database.close(); }
  expect(await requestOperator(hub.databasePath, "hub-doctor")).toMatchObject({
    status: "ok", info: { databasePath: hub.databasePath, port: hub.port, integrity: ["ok"] },
  });
  expect(hub.server.address.port).toBe(hub.port);
});

it.each([{}, [], { databasePath: "wrong" }])("rejects malformed live status %j instead of printing successful undefined facts", async info => {
  const path = tempDatabasePath();
  mkdirSync(`${path}.admin`, { mode: 0o700 });
  const server = createServer(socket => {
    socket.on("data", () => socket.end(`${JSON.stringify({ status: "ok", info })}\n`));
  });
  await new Promise<void>((accept, reject) => { server.once("error", reject); server.listen(adminSocketPath(path), accept); });
  const identity = join(dirname(path), "release.json");
  writeFileSync(identity, JSON.stringify({ version: "0.5.1", sourceCommit: "a".repeat(40), syncProtocolVersion: 3 }));
  vi.stubEnv("HUB_DB_PATH", path);
  const output: string[] = [];
  const errors: string[] = [];
  vi.spyOn(console, "log").mockImplementation(value => { output.push(String(value)); });
  vi.spyOn(console, "error").mockImplementation(value => { errors.push(String(value)); });
  try {
    await runOperatorCommand(["status"], identity);
    expect(process.exitCode).toBe(1);
    expect(errors.join("\n")).toContain("invalid hub response");
    expect(output.join("\n")).not.toContain("undefined");
    const before = readdirSync(dirname(path));
    vi.stubGlobal("fetch", async () => new Response("GitHub device page", { headers: { date: new Date().toUTCString() } }));
    await runOperatorCommand(["doctor"]);
    expect(process.exitCode).toBe(1);
    expect(output.join("\n")).toMatch(/FAIL\s+hub\s+.*invalid hub response/);
    expect(output.join("\n")).toMatch(/skip\s+database/);
    expect(readdirSync(dirname(path))).toEqual(before);
  } finally {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    await new Promise<void>((accept, reject) => server.close(error => error ? reject(error) : accept()));
  }
});

it("status prints image identity even when stopped; help and usage honor their exit contract", async () => {
  const path = tempDatabasePath();
  const identity = join(dirname(path), "release.json");
  writeFileSync(identity, JSON.stringify({ version: "0.5.1", sourceCommit: "a".repeat(40), syncProtocolVersion: 3 }));
  chmodSync(identity, 0o600);
  vi.stubEnv("HUB_DB_PATH", path);
  const output: string[] = [];
  vi.spyOn(console, "log").mockImplementation(value => { output.push(String(value)); });
  vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    await runOperatorCommand(["status"], identity);
    expect(output.join("\n")).toContain("release    0.5.1");
    expect(output.join("\n")).toContain(`commit     ${"a".repeat(40)}`);
    expect(output.join("\n")).toContain("hub        not running");
    expect(process.exitCode).toBe(1);
    for (const args of [[], ["--help"], ["admin-setup", "--help"], ["admin-setup", "-h"]]) {
      process.exitCode = 0;
      await runOperatorCommand(args);
      expect(process.exitCode).toBe(0);
    }
    for (const args of [["wat"], ["status", "extra"], ["backup", "extra"], ["restore"], ["restore", "--wat"], ["admin-setup"], ["admin-setup", "bad-uuid"]]) {
      process.exitCode = 0;
      await runOperatorCommand(args);
      expect(process.exitCode).toBe(2);
    }
  } finally { vi.unstubAllEnvs(); }
});
