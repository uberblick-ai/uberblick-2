import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { requestOperator } from "../src/operator-client.js";
import type { OperatorControls } from "../src/operator-control.js";
import { adminSocketPath, startOperatorSocket } from "../src/operator-socket.js";
import { HubDatabase } from "../src/persistence.js";
import { WORKSPACE } from "./helpers.js";

const directories: string[] = [];
const databases: HubDatabase[] = [];
const controls: Awaited<ReturnType<typeof startOperatorSocket>>[] = [];
let originalDirectory: string;

beforeEach(() => {
  originalDirectory = process.cwd();
  process.chdir(tmpdir());
});

afterEach(async () => {
  for (const control of controls.splice(0)) await control.stop();
  for (const database of databases.splice(0)) database.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  process.chdir(originalDirectory);
});

function database() {
  const directory = mkdtempSync(join(tmpdir(), `op-${process.env.UB_AGENTS_RUN ?? "test"}-`));
  directories.push(directory);
  const db = new HubDatabase(join(directory, "hub.sqlite"), () => {});
  db.open();
  databases.push(db);
  return db;
}

async function start(db: HubDatabase, operator: OperatorControls = { run: async () => ({ status: "ok" }) }) {
  const control = await startOperatorSocket({ database: db, operator });
  controls.push(control);
  return control;
}

async function raw(db: HubDatabase, message: unknown) {
  const socket = createConnection(adminSocketPath(db.databasePath));
  socket.setEncoding("utf8");
  socket.on("connect", () => socket.end(`${JSON.stringify(message)}\n`));
  const [output] = await once(socket, "data");
  socket.destroy();
  return JSON.parse(String(output));
}

it.each(["insecure-directory", "symlink-directory"])("refuses %s rather than exposing operator control", async obstruction => {
  const db = database();
  const privateDirectory = `${db.databasePath}.admin`;
  if (obstruction === "symlink-directory") {
    const target = `${db.databasePath}.other`;
    mkdirSync(target, { mode: 0o700 });
    symlinkSync(target, privateDirectory);
  } else {
    mkdirSync(privateDirectory, { mode: 0o700 });
    chmodSync(privateDirectory, 0o755);
  }
  await expect(start(db)).rejects.toThrow("mode 0700");
});

it("keeps private modes and refuses another live listener without unlinking it", async () => {
  const db = database();
  const control = await start(db);
  const inode = lstatSync(control.path).ino;
  expect(lstatSync(`${db.databasePath}.admin`).mode & 0o777).toBe(0o700);
  expect(lstatSync(control.path).mode & 0o777).toBe(0o600);
  await expect(start(db)).rejects.toThrow("another hub owns");
  expect(lstatSync(control.path).ino).toBe(inode);
  expect(await requestOperator(db.databasePath, "hub-status")).toEqual({ status: "ok" });
});

it("replaces a socket left by a killed process and serves operator requests", async () => {
  const db = database();
  mkdirSync(`${db.databasePath}.admin`, { mode: 0o700 });
  const path = adminSocketPath(db.databasePath);
  const child = spawn(process.execPath, ["--input-type=module", "-e",
    "import {createServer} from 'node:net'; createServer().listen(process.argv[1], () => process.stdout.write('ready'));", path],
    { stdio: ["ignore", "pipe", "pipe"], timeout: 5_000 });
  try {
    await Promise.race([once(child.stdout, "data"), once(child, "exit").then(() => { throw new Error("socket fixture exited before listening"); })]);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
    }
  }
  await start(db);
  expect(await requestOperator(db.databasePath, "hub-status")).toEqual({ status: "ok" });
});

it("accepts only the bounded operator requests and refuses removed setup actions", async () => {
  const db = database();
  const requests: unknown[] = [];
  await start(db, { run: async request => { requests.push(request); return { status: "ok" }; } });
  for (const message of [
    { action: "workspace-admin-add", workspaceId: WORKSPACE, account: "octocat" },
    { action: "workspace-admin-add", workspaceId: WORKSPACE, accountId: "1234" },
    { action: "hub-admin-add", account: "octocat" },
    { action: "hub-status" }, { action: "hub-doctor" }, { action: "backup" },
  ]) expect(await raw(db, message)).toEqual({ status: "ok" });
  expect(requests).toHaveLength(6);
  for (const message of [
    { action: "start", workspaceId: WORKSPACE }, { action: "status", setupId: WORKSPACE }, { action: "cancel" },
    { action: "workspace-admin-add", workspaceId: "invalid", account: "octocat" },
    { action: "workspace-admin-add", workspaceId: WORKSPACE, account: "octocat", accountId: "1234" },
    { action: "workspace-admin-add", workspaceId: WORKSPACE, accountId: "0" },
    { action: "workspace-admin-add", workspaceId: WORKSPACE, account: "bad login" },
  ]) expect(await raw(db, message)).toEqual({ status: "invalid-request" });
  expect(requests).toHaveLength(6);
});

it("fences an active operation and waits for it before closing the database", async () => {
  const db = database();
  let began!: () => void;
  const started = new Promise<void>(accept => { began = accept; });
  let release!: () => void;
  const paused = new Promise<void>(accept => { release = accept; });
  let signal: AbortSignal | undefined;
  let operationFinished = false;
  const control = await start(db, { async run(_request, abort) {
    signal = abort;
    began();
    await paused;
    expect(db.connection.isOpen).toBe(true);
    operationFinished = true;
    return { status: "ok" };
  } });
  const request = requestOperator(db.databasePath, "backup").catch(error => error);
  await started;
  let stoppedBeforeOperation = false;
  const stopped = control.stop().then(() => { stoppedBeforeOperation = !operationFinished; });
  controls.pop();
  expect(signal?.aborted).toBe(true);
  expect(await request).toBeInstanceOf(Error);
  await new Promise<void>(accept => setImmediate(accept));
  expect(stoppedBeforeOperation).toBe(false);
  release();
  await stopped;
  expect(operationFinished).toBe(true);
  expect(stoppedBeforeOperation).toBe(false);
});

it("drops legacy setup receipts when a database is reopened", () => {
  const db = database();
  db.connection.exec("CREATE TABLE hub_admin_setup_grants (setup_id TEXT); INSERT INTO hub_admin_setup_grants VALUES ('retired')");
  db.close();
  db.open();
  expect(db.connection.prepare("SELECT name FROM sqlite_schema WHERE name = 'hub_admin_setup_grants'").get()).toBeUndefined();
  expect(db.connection.prepare("SELECT count(*) AS count FROM documents").get()?.count).toBe(0);
});
