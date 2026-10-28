import { execFile, fork, type ChildProcess } from "node:child_process";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { once } from "node:events";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { roomForDoc, type RevisionEntry } from "@uberblick/schema";
import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { writeHubLogin } from "../src/auth-store.js";
import { HistoryCache, type HistoryCacheResult } from "../src/history-cache.js";
import { acquireInitLock } from "../src/init-lock.js";
import { MirrorStore } from "../src/store.js";
import { rememberWorkspaceBindings } from "../src/workspace-registry.js";
import { builtWorker } from "./process-helpers.js";
import { closeChild, removeTempDirs, tempDir, trackChild, WORKSPACE } from "./shared.js";

const HUB = "wss://history.example.test/ws";
const PAGE = "1840680a-c086-44bd-b54a-b4be9adc7d84";
const SAVE_PAGE = "2b4989f7-5d36-420e-aeb0-ac028742f443";
const CHECKSUM = "a".repeat(64);
const children: ChildProcess[] = [];
const caches: HistoryCache[] = [];
const stores: MirrorStore[] = [];
const execFileAsync = promisify(execFile);
type Message = { type: string; name?: string; started?: number; ended?: number; error?: string };

afterEach(async () => {
  for (const child of children.splice(0)) await closeChild(child);
  for (const cache of caches.splice(0)) cache.close();
  for (const store of stores.splice(0)) store.close();
  removeTempDirs();
});

function ready<T>(result: HistoryCacheResult<T>): T {
  expect(result.status).toBe("ready");
  if (result.status !== "ready") throw new Error(`history cache returned ${result.status}`);
  return result.value;
}

async function fixture() {
  const directory = tempDir();
  const env = { XDG_CONFIG_HOME: directory, XDG_DATA_HOME: directory, HOME: directory };
  const lock = await acquireInitLock(env);
  try { rememberWorkspaceBindings([{ workspaceId: WORKSPACE, hubUrl: HUB }], env); }
  finally { lock.release(); }
  const principalId = randomUUID();
  await writeHubLogin("https://history.example.test", {
    identity: { id: principalId, githubAccountId: "123", githubUsername: "history-test" },
    credential: {
      record: { id: randomUUID(), principalId, deviceId: randomUUID(), workspaces: [WORKSPACE], issuedAt: 1, revokedAt: null },
      key: generateKeyPairSync("ed25519").privateKey.export({ format: "der", type: "pkcs8" }).toString("base64url"),
    },
  }, env);
  const path = join(directory, "workspace.sqlite");
  const store = new MirrorStore(path, WORKSPACE);
  stores.push(store);
  const cache = new HistoryCache(path, WORKSPACE, env);
  caches.push(cache);
  const token = ready(cache.open({ hub: HUB, workspace: WORKSPACE, account: "123" }));
  return { directory, env, path, store, cache, token };
}

function worker(mode: string, path: string, directory: string) {
  const child = trackChild(fork(builtWorker("history-cache"), [mode, path, WORKSPACE, directory], {
    execArgv: [], stdio: ["ignore", "ignore", "pipe", "ipc"],
  }));
  children.push(child);
  const messages: Message[] = [];
  const waiting: { resolve(message: Message): void; reject(error: Error): void }[] = [];
  let stderr = "";
  let stopped = false;
  child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  child.on("message", (message: Message) => {
    const pending = waiting.shift();
    if (pending) pending.resolve(message);
    else messages.push(message);
  });
  const exited = once(child, "exit").then(() => {
    stopped = true;
    for (const pending of waiting.splice(0)) pending.reject(new Error(`history worker exited before replying: ${stderr}`));
  });
  return {
    child,
    exited,
    next(): Promise<Message> {
      const message = messages.shift();
      if (message) return Promise.resolve(message);
      if (stopped) return Promise.reject(new Error(`history worker already exited: ${stderr}`));
      return new Promise((resolve, reject) => waiting.push({ resolve, reject }));
    },
  };
}

describe("history cache between processes", () => {
  it("discards downloaded history and fences old writers even after the original hub and account return", async () => {
    const test = await fixture();
    ready(test.cache.putCatalog(test.token, PAGE, { revisions: [{ id: "revision-0", author: null, startedAt: 1,
      endedAt: 2, final: true, checksum: CHECKSUM }], version: "before", refreshedAt: 1, complete: true, failed: false }));
    ready(test.cache.putSnapshot(test.token, PAGE, "revision-0", CHECKSUM, new Uint8Array([9])));
    test.store.setHistoryRetention({ mode: "named" });
    test.store.appendUpdate(roomForDoc(WORKSPACE, SAVE_PAGE), new Uint8Array([0, 0]), "local");
    expect(() => test.store.detachWorkspace(() => { throw new Error("binding write failed"); })).toThrow("binding write failed");
    expect(ready(test.cache.readSnapshot(test.token, PAGE, "revision-0"))?.state).toEqual(Buffer.from([9]));
    await execFileAsync(process.execPath, [builtWorker("workspace-detach"), test.path, WORKSPACE]);

    // The registry deliberately still names the same hub, modelling a later reconnect.
    expect(test.cache.open({ hub: HUB, workspace: WORKSPACE, account: "123" }).status).toBe("superseded");
    expect(test.cache.putSnapshot(test.token, PAGE, "after", CHECKSUM, new Uint8Array([8])).status).toBe("superseded");
    const restartedStore = new MirrorStore(test.path, WORKSPACE);
    stores.push(restartedStore);
    expect(restartedStore.readHistoryRetention()).toEqual({ mode: "named" });
    expect(restartedStore.pendingRooms().some(room => room.room === roomForDoc(WORKSPACE, SAVE_PAGE))).toBe(true);
    const restartedCache = new HistoryCache(test.path, WORKSPACE, test.env);
    caches.push(restartedCache);
    const reconnected = ready(restartedCache.open({ hub: HUB, workspace: WORKSPACE, account: "123" }));
    expect(reconnected.generation).not.toBe(test.token.generation);
    expect(ready(restartedCache.readCatalog(reconnected, PAGE))).toBeNull();
    expect(ready(restartedCache.readSnapshot(reconnected, PAGE, "revision-0"))).toBeNull();
    const inspector = new DatabaseSync(test.path);
    try {
      expect(inspector.prepare("SELECT COUNT(*) AS n FROM history_v1_catalog_chunks").get()?.n).toBe(0);
      expect(inspector.prepare("SELECT COUNT(*) AS n FROM history_v1_snapshot_chunks").get()?.n).toBe(0);
    } finally { inspector.close(); }
  });

  it("leaves configuration and cache writes available after a downloader is killed inside a chunk transaction", async () => {
    const test = await fixture();
    const downloader = worker("crash-write", test.path, test.directory);
    expect(await downloader.next()).toEqual({ type: "ready" });
    downloader.child.send({ type: "start" });
    expect(await downloader.next()).toEqual({ type: "writing" });
    downloader.child.kill("SIGKILL");
    await downloader.exited;
    const lock = await acquireInitLock(test.env, { command: "ub auth login", waitMs: 0 });
    try { ready(test.cache.markRefreshFailed(test.token, PAGE)); }
    finally { lock.release(); }
    ready(test.cache.putSnapshot(test.token, PAGE, "revision-0", CHECKSUM, new Uint8Array([9])));
    expect(ready(test.cache.readSnapshot(test.token, PAGE, "revision-0"))?.state).toEqual(Buffer.from([9]));
  });

  it("retries a cache write after a separate document writer releases contention", async () => {
    const test = await fixture();
    ready(test.cache.putCatalog(test.token, PAGE, { revisions: [], version: "version", refreshedAt: 1, complete: true, failed: false }));
    const holder = worker("lock", test.path, test.directory);
    expect(await holder.next()).toEqual({ type: "ready" });
    const original = DatabaseSync.prototype.exec;
    let contended = 0;
    DatabaseSync.prototype.exec = function exec(sql) {
      try { return original.call(this, sql); }
      catch (error) {
        if (sql === "BEGIN IMMEDIATE" && ((error as { errcode: number }).errcode & 255) === 5) {
          contended++;
          if (contended === 1) holder.child.send({ type: "release" });
        }
        throw error;
      }
    };
    try { ready(test.cache.markRefreshFailed(test.token, PAGE)); }
    finally { DatabaseSync.prototype.exec = original; }
    expect(contended).toBeGreaterThan(0);
    expect(ready(test.cache.readCatalog(test.token, PAGE))?.failed).toBe(true);
    expect(await holder.next()).toEqual({ type: "done" });
    await holder.exited;
    expect(holder.child.exitCode).toBe(0);
  });

  it("protects another process's displayed or downloading snapshot until that process crashes", async () => {
    const test = await fixture();
    const revisions: RevisionEntry[] = Array.from({ length: 4 }, (_, index) => ({
      id: `revision-${index}`, author: null, startedAt: 1, endedAt: 2, final: true, checksum: CHECKSUM,
    }));
    ready(test.cache.putCatalog(test.token, PAGE, { revisions, version: "version", refreshedAt: 1, complete: true, failed: false }));
    for (const revision of revisions) ready(test.cache.putSnapshot(test.token, PAGE, revision.id, CHECKSUM, new Uint8Array([1, 2, 3])));
    const holder = worker("hold", test.path, test.directory);
    expect(await holder.next()).toEqual({ type: "ready" });
    ready(test.cache.evict(test.token, PAGE, { mode: "named" }, Date.now()));
    expect(ready(test.cache.readSnapshot(test.token, PAGE, "revision-2"))).not.toBeNull();
    expect(ready(test.cache.readSnapshot(test.token, PAGE, "revision-3"))).not.toBeNull();
    holder.child.kill("SIGKILL");
    await holder.exited;
    ready(test.cache.evict(test.token, PAGE, { mode: "named" }, Date.now()));
    expect(ready(test.cache.readSnapshot(test.token, PAGE, "revision-2"))).toBeNull();
    expect(ready(test.cache.readSnapshot(test.token, PAGE, "revision-3"))).toBeNull();
    expect(ready(test.cache.readSnapshot(test.token, PAGE, "revision-0"))).not.toBeNull();
  });

  it("keeps document saves below the store timeout during large cache writes, evictions, purges and resets", async () => {
    const test = await fixture();
    const cacheWorker = worker("exercise", test.path, test.directory);
    expect(await cacheWorker.next()).toEqual({ type: "ready" });
    let done = false;
    let failure: unknown;
    const operations: Message[] = [];
    const completion = (async () => {
      for (;;) {
        const message = await cacheWorker.next();
        if (message.type === "done") break;
        if (message.type === "failed") throw new Error(message.error);
        operations.push(message);
      }
    })().catch(error => { failure = error; }).finally(() => { done = true; });
    cacheWorker.child.send({ type: "start" });
    const saves: { started: number; ended: number }[] = [];
    const document = new Y.Doc();
    const room = roomForDoc(WORKSPACE, SAVE_PAGE);
    const deadline = Date.now() + 60_000;
    try {
      while (!done && Date.now() < deadline) {
        const before = Y.encodeStateVector(document);
        document.getMap("document").set("counter", saves.length);
        const update = Y.encodeStateAsUpdate(document, before);
        const started = Date.now();
        test.store.appendUpdate(room, update, "local");
        saves.push({ started, ended: Date.now() });
        await delay(1);
      }
      await completion;
      if (failure !== undefined) throw failure;
      await cacheWorker.exited;
      expect(cacheWorker.child.exitCode).toBe(0);
      expect(operations.map(operation => operation.name)).toEqual(["put", "evict", "purge", "reset"]);
      for (const operation of operations) {
        expect(saves.some(save => save.started <= operation.ended! && save.ended >= operation.started!),
          `no document save overlapped ${operation.name}`).toBe(true);
      }
      expect(Math.max(...saves.map(save => save.ended - save.started))).toBeLessThan(5_000);
      expect(test.store.updatesAfter(room, 0)).toHaveLength(saves.length);
    } finally { document.destroy(); }
  });
});
