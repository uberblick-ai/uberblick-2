import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { promisify } from "node:util";
import { initDoc, roomForDoc, upsertDirectoryEntry } from "@uberblick/schema";
import { afterEach, expect, it } from "vitest";
import * as Y from "yjs";
import { Replicas } from "../src/replica.js";
import { MirrorStore, WorkspaceDetachedError } from "../src/store.js";
import { acquireInitLock } from "../src/init-lock.js";
import { rememberWorkspaceBindings } from "../src/workspace-registry.js";
import { builtWorker, mainProcess } from "./process-helpers.js";
import { cleanupTestResources, hubUrl, peerClient, startHub, tempDatabasePath, testConfig,
  tempDir, waitUntil, WORKSPACE, TEST_SECRET, type PeerClient, type TestHub } from "./helpers.js";

const PAGE = "a33df257-9277-4521-8a42-ddd05c3ed285";
const execFileAsync = promisify(execFile);
const replicas: Replicas[] = [];
const stores: MirrorStore[] = [];
const peers: PeerClient[] = [];
const hubs: TestHub[] = [];

afterEach(async () => {
  await cleanupTestResources({
    clients: replicas.splice(0).map(replica => () => replica.destroy()),
    peers: peers.splice(0).map(peer => () => peer.destroy()),
    hubs: hubs.splice(0).map(hub => () => hub.stop()),
    after: stores.splice(0).map(store => () => store.close()),
  });
});

async function connectedReplica() {
  const hub = await startHub();
  hubs.push(hub);
  const path = tempDatabasePath();
  const store = new MirrorStore(path, WORKSPACE);
  stores.push(store);
  // No engine or history refresher polls: only the actual wire boundary can fence.
  const replica = new Replicas(testConfig({ databasePath: path, hubUrl: hubUrl(hub.port), authSecret: TEST_SECRET }), store);
  replicas.push(replica);
  const document = replica.replica(PAGE);
  initDoc(document.doc, { uuid: PAGE, title: "Before detach", description: "Transport generation test." });
  upsertDirectoryEntry(replica.directory().doc, { uuid: PAGE, title: "Before detach" });
  expect((await replica.waitForSettled()).caughtUp).toBe(true);
  const peer = await peerClient(hub.port, roomForDoc(WORKSPACE, PAGE));
  peers.push(peer);
  await peer.synced;
  expect((await replica.waitForSettled()).caughtUp).toBe(true);
  return { hub, path, store, replica, document, peer };
}

async function detach(path: string): Promise<void> {
  await execFileAsync(process.execPath, [builtWorker("workspace-detach"), path, WORKSPACE]);
}

it("refuses a stale hub selection in the spawned MCP process before opening its replica", async () => {
  const directory = tempDir();
  const path = tempDatabasePath();
  const env = { PATH: process.env.PATH ?? "", XDG_CONFIG_HOME: directory, XDG_DATA_HOME: directory,
    HOME: directory, WORKSPACE_ID: WORKSPACE, HUB_URL: "ws://127.0.0.1:12345", UBERBLICK_DB: path };
  const lock = await acquireInitLock(env);
  try { rememberWorkspaceBindings([{ workspaceId: WORKSPACE, hubUrl: null }], env); }
  finally { lock.release(); }
  const invocation = mainProcess();
  const child = spawn(invocation.command, invocation.args, { env, stdio: ["ignore", "pipe", "pipe"], timeout: 10_000 });
  const exited = once(child, "close");
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  const [code] = await exited;
  expect(code).toBe(1);
  expect(stderr).toContain("MCP startup");
  expect(stderr).toContain("local");
  const { existsSync } = await import("node:fs");
  expect(existsSync(path)).toBe(false);
});

it("rejects the first inbound hub update after another process detaches, without a poll or tool call", async () => {
  const test = await connectedReplica();
  const before = test.store.updatesAfter(test.document.room, 0);
  await detach(test.path);
  test.peer.doc.getMap("wire-test").set("after-detach", "from the hub");
  await waitUntil("the peer update to be acknowledged", () => !test.peer.provider.hasUnsyncedChanges);
  await waitUntil("the inbound frame to fence the old connection", () => test.replica.sync.isQuarantined());
  expect(test.document.doc.getMap("wire-test").get("after-detach")).toBeUndefined();
  expect(test.store.updatesAfter(test.document.room, 0)).toEqual(before);
});

it("rejects outbound presence and new local edits after another process detaches, without a poll", async () => {
  const test = await connectedReplica();
  await detach(test.path);
  const fresh = new MirrorStore(test.path, WORKSPACE);
  stores.push(fresh);
  const local = new Y.Doc();
  local.getMap("wire-test").set("after-detach", "only local");
  fresh.appendUpdate(test.document.room, Y.encodeStateAsUpdate(local), "local");
  local.destroy();
  expect(() => test.replica.sync.flushLog(test.document.room)).toThrow(WorkspaceDetachedError);
  // Presence bypasses the update log and must independently hit the send fence.
  test.document.awareness.setLocalState({ "after-detach": true });
  await waitUntil("the batched presence send to fence the old connection", () => test.replica.sync.isQuarantined());
  // A later acknowledged peer update supplies a barrier for the negative claim.
  test.peer.doc.getMap("wire-test").set("barrier", true);
  await waitUntil("the barrier to reach the hub", () => !test.peer.provider.hasUnsyncedChanges);
  expect(test.peer.doc.getMap("wire-test").get("after-detach")).toBeUndefined();
  expect(fresh.pendingRooms().some(entry => entry.room === test.document.room)).toBe(true);
});
