import { generateKeyPairSync, randomUUID } from "node:crypto";
import { join } from "node:path";
import { getMeta, initDoc, type RevisionEntry, type RevisionRequest, type RevisionResponse } from "@uberblick/schema";
import { afterEach, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { removeHubLogin, writeHubLogin } from "../src/auth-store.js";
import { HistoryCache, type CachedHistoryCatalog, type HistoryCacheResult, type HistoryCacheStamp } from "../src/history-cache.js";
import { HistoryMirrorCache } from "../src/history-mirror-cache.js";
import { HistoryReader, type HistoryReaderSource } from "../src/history-reader.js";
import { acquireInitLock } from "../src/init-lock.js";
import type { HistoryRetention } from "../src/local-settings.js";
import { documentRevisionChecksum, RevisionClientError } from "../src/revision-client.js";
import { MirrorStore } from "../src/store.js";
import { rememberWorkspaceBindings } from "../src/workspace-registry.js";
import { removeTempDirs, tempDir, waitUntil, WORKSPACE } from "./shared.js";

const HUB = "wss://history.example.test/ws";
const PAGE = "1840680a-c086-44bd-b54a-b4be9adc7d84";
const STAMP = { hub: HUB, workspace: WORKSPACE, account: "123" };
type Operation = Omit<RevisionRequest, "requestId">;
const resources: Array<() => unknown> = [];
const settleReplies: Array<() => void> = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const settle of settleReplies.splice(0)) settle();
  for (const close of resources.splice(0)) await close();
  removeTempDirs();
});

function ready<T>(result: HistoryCacheResult<T>): T {
  if (result.status !== "ready") throw new Error(`History cache returned ${result.status}.`);
  return result.value;
}

function snapshot(id: string, title = id, extra: Partial<RevisionEntry> = {}) {
  const document = new Y.Doc();
  try {
    initDoc(document, { uuid: PAGE, title });
    const checksum = documentRevisionChecksum(document);
    const revision: RevisionEntry = { id, author: null, startedAt: 1, endedAt: 2, final: true, checksum, ...extra };
    return { revision, state: Y.encodeStateAsUpdate(document), checksum };
  } finally { document.destroy(); }
}

function listed(revisions: RevisionEntry[], version = "version-one"): RevisionResponse {
  return { requestId: "request", ok: true, revisions, version };
}

function downloaded(value: ReturnType<typeof snapshot>): RevisionResponse {
  return { requestId: "request", ok: true, state: value.state, checksum: value.checksum, revisionId: value.revision.id };
}

async function storage() {
  const directory = tempDir();
  const env = { XDG_CONFIG_HOME: directory, XDG_DATA_HOME: directory, HOME: directory };
  const lock = await acquireInitLock(env);
  try { rememberWorkspaceBindings([{ workspaceId: WORKSPACE, hubUrl: HUB }], env, WORKSPACE); }
  finally { lock.release(); }
  const principal = randomUUID();
  await writeHubLogin("https://history.example.test", {
    identity: { id: principal, githubAccountId: STAMP.account, githubUsername: "history-reader" },
    credential: {
      record: { id: randomUUID(), principalId: principal, deviceId: randomUUID(), workspaces: [WORKSPACE], issuedAt: Date.now(), revokedAt: null },
      key: generateKeyPairSync("ed25519").privateKey.export({ format: "der", type: "pkcs8" }).toString("base64url"),
    },
  }, env);
  const path = join(directory, "workspace.sqlite");
  const store = new MirrorStore(path, WORKSPACE);
  const worker = new HistoryMirrorCache(path, WORKSPACE, env);
  const cache = new HistoryCache(path, WORKSPACE, env);
  resources.push(() => worker.close(), () => cache.close(), () => store.close());
  const token = ready(cache.open(STAMP));
  const seed = (revisions: RevisionEntry[], extra: Partial<Omit<CachedHistoryCatalog, "catalog" | "revisions">> = {}) => {
    ready(cache.putCatalog(token, PAGE, { revisions, version: "version-one", refreshedAt: 1_000, complete: true, failed: false, ...extra }));
  };
  const putSnapshot = (value: ReturnType<typeof snapshot>) => {
    ready(cache.putSnapshot(token, PAGE, value.revision.id, value.checksum, value.state));
  };
  return { env, store, worker, cache, token, seed, putSnapshot };
}

async function fixture() {
  const test = await storage();
  const state = {
    connected: true,
    stamp: STAMP as HistoryCacheStamp | null,
    retention: { mode: "everything" } as HistoryRetention,
    reply: async (_uuid: string, _operation: Operation): Promise<RevisionResponse> => listed([]),
  };
  const request = vi.fn(async (uuid: string, operation: Operation) => state.reply(uuid, operation));
  const requireHistory = vi.fn((_uuid: string): void => {});
  const source: HistoryReaderSource = {
    stamp: () => state.stamp,
    connected: () => state.connected,
    request,
    now: () => 2_000,
    retention: () => state.retention,
    requireHistory,
  };
  const reader = new HistoryReader(source, test.worker);
  resources.unshift(() => reader.close());
  return { ...test, state, source, request, requireHistory, reader };
}

it("reads cached history and a verified snapshot without invoking the hub request source", async () => {
  const test = await fixture();
  const older = snapshot("older", "Downloaded title");
  const newer = snapshot("newer", "Not downloaded");
  test.seed([newer.revision, older.revision]);
  test.putSnapshot(older);
  const listed = await test.reader.list(PAGE);
  expect(listed.revisions).toEqual([newer.revision, older.revision]);
  expect(listed.history).toMatchObject({ complete: true, lastRefresh: new Date(1_000).toISOString(), refreshFailed: false, offline: false,
    newestDownloadedRevision: "older" });
  const read = await test.reader.get(PAGE, older.revision.id);
  try { expect(getMeta(read.doc).title).toBe("Downloaded title"); }
  finally { read.doc.destroy(); }
  expect(test.request).not.toHaveBeenCalled();
});

it("keeps downloaded history readable after sign-out and refused admission", async () => {
  const test = await fixture();
  const downloaded = snapshot("retained");
  test.seed([downloaded.revision], { failed: true });
  test.putSnapshot(downloaded);
  await removeHubLogin("https://history.example.test", test.env);
  test.state.stamp = null;
  test.state.connected = false;
  test.state.reply = async () => { throw new RevisionClientError("forbidden"); };

  expect(await test.reader.list(PAGE)).toMatchObject({ revisions: [downloaded.revision], history: {
    complete: true, lastRefresh: new Date(1_000).toISOString(), refreshFailed: true, offline: true,
  } });
  const read = await test.reader.get(PAGE, downloaded.revision.id);
  read.doc.destroy();
  expect(test.request).not.toHaveBeenCalled();
  await expect(test.reader.get(PAGE, "uncached")).rejects.toMatchObject({ code: "not-downloaded" });
});

it("distinguishes a failed first download from a complete catalog with no revisions", async () => {
  const test = await fixture();
  test.seed([], { complete: false, failed: true, refreshedAt: null, version: null });
  test.state.connected = false;
  await expect(test.reader.list(PAGE)).rejects.toMatchObject({ code: "not-downloaded", details: { history: {
    complete: false, lastRefresh: null, refreshFailed: true, offline: true, newestDownloadedRevision: null,
  } } });
  expect(test.request).not.toHaveBeenCalled();

  test.seed([]);
  expect(await test.reader.list(PAGE)).toMatchObject({ revisions: [], history: { complete: true, refreshFailed: false } });
});

it("downloads cold catalogs and checksum-verified snapshots into the cache before answering", async () => {
  const test = await fixture();
  const value = snapshot("cold", "Fetched into history");
  test.state.reply = async (_uuid, operation) => operation.operation === "list" ? listed([value.revision]) : downloaded(value);

  expect(await test.reader.list(PAGE)).toMatchObject({ revisions: [value.revision], history: { complete: true } });
  expect(ready(test.cache.readCatalog(test.token, PAGE))?.revisions).toEqual([value.revision]);
  const read = await test.reader.get(PAGE, value.revision.id);
  try {
    expect(getMeta(read.doc).title).toBe("Fetched into history");
    expect(ready(test.cache.readSnapshot(test.token, PAGE, value.revision.id))).toMatchObject({ checksum: value.checksum });
  } finally { read.doc.destroy(); }
  expect(test.request.mock.calls.map(([, operation]) => operation.operation)).toEqual(["list", "get"]);
  expect(test.request.mock.calls[0]?.[1]).toMatchObject({ includeNames: true, includeTitles: true });
});

it("bounds the foreground wait while allowing the same download to finish and serve a later read", async () => {
  const test = await fixture();
  const value = snapshot("eventual");
  let publish!: () => void;
  const response = new Promise<RevisionResponse>(resolve => { publish = () => resolve(listed([value.revision])); });
  settleReplies.push(publish);
  test.state.reply = async () => response;
  const first = test.reader.list(PAGE, { timeoutMs: 20 });
  const assertion = expect(first).rejects.toMatchObject({ code: "downloading" });
  await assertion;
  expect(ready(test.cache.readCatalog(test.token, PAGE))).toBeNull();
  publish();
  await waitUntil("the timed-out read's catalog publication", () => ready(test.cache.readCatalog(test.token, PAGE))?.complete === true);
  expect(await test.reader.list(PAGE)).toMatchObject({ revisions: [value.revision] });
  expect(test.request).toHaveBeenCalledTimes(1);
});

it("revalidates again when a competing incomplete publication wins a cold refresh", async () => {
  const test = await fixture();
  const value = snapshot("concurrent");
  test.state.reply = async () => listed([value.revision]);
  vi.spyOn(test.worker, "putCatalog").mockImplementationOnce(async () => {
    test.seed([], { complete: false, refreshedAt: null, failed: true });
    return { status: "superseded" };
  });
  expect(await test.reader.list(PAGE)).toMatchObject({ revisions: [value.revision], history: { complete: true } });
  expect(test.request).toHaveBeenCalledTimes(2);
});

it("keeps a timed-out snapshot download for a later cache read", async () => {
  const test = await fixture();
  const value = snapshot("eventual-snapshot");
  test.seed([value.revision]);
  ready(await test.worker.open(STAMP));
  let publish!: () => void;
  const response = new Promise<RevisionResponse>(resolve => { publish = () => resolve(downloaded(value)); });
  settleReplies.push(publish);
  test.state.reply = async () => response;

  await expect(test.reader.get(PAGE, value.revision.id, { timeoutMs: 20 })).rejects.toMatchObject({ code: "downloading" });
  publish();
  await waitUntil("the timed-out snapshot's verified publication", () => ready(test.cache.readSnapshot(test.token, PAGE, value.revision.id)) !== null);
  const read = await test.reader.get(PAGE, value.revision.id);
  try { expect(getMeta(read.doc).title).toBe("eventual-snapshot"); }
  finally { read.doc.destroy(); }
  expect(test.request).toHaveBeenCalledTimes(1);
});

it("revalidates an unknown revision online before confirming absence, and never confirms it offline", async () => {
  const test = await fixture();
  test.seed([]);
  test.state.connected = false;
  await expect(test.reader.get(PAGE, "unknown")).rejects.toMatchObject({ code: "not-downloaded" });
  expect(test.request).not.toHaveBeenCalled();

  test.state.connected = true;
  test.state.reply = async () => listed([], "confirmed-empty");
  await expect(test.reader.get(PAGE, "unknown")).rejects.toMatchObject({ code: "revision-not-found" });
  expect(test.request.mock.calls.map(([, operation]) => operation.operation)).toEqual(["list"]);
  expect(ready(test.cache.readCatalog(test.token, PAGE))?.version).toBe("confirmed-empty");
});

it("rejects a cached open-head snapshot after the cached catalog changes its checksum", async () => {
  const test = await fixture();
  const previous = snapshot("head", "Older open head", { endedAt: null, final: false });
  const current = snapshot("head", "Changed open head", { endedAt: null, final: false });
  test.seed([previous.revision]);
  test.putSnapshot(previous);
  test.seed([current.revision], { version: "changed-head" });
  test.state.connected = false;
  await expect(test.reader.get(PAGE, "head")).rejects.toMatchObject({ code: "not-downloaded" });
  expect(test.request).not.toHaveBeenCalled();

  test.state.connected = true;
  test.state.reply = async () => downloaded(current);
  const read = await test.reader.get(PAGE, "head");
  try { expect(getMeta(read.doc).title).toBe("Changed open head"); }
  finally { read.doc.destroy(); }
  expect(test.request.mock.calls.map(([, operation]) => operation.operation)).toEqual(["get"]);
});

it("holds a read outside retention until its document is destroyed, then evicts its snapshot", async () => {
  const test = await fixture();
  const newest = snapshot("newest");
  const middle = snapshot("middle");
  const old = snapshot("old");
  test.seed([newest.revision, middle.revision, old.revision]);
  test.putSnapshot(newest);
  test.state.retention = { mode: "named" };
  test.state.reply = async () => downloaded(old);

  const read = await test.reader.get(PAGE, "old");
  ready(test.cache.evict(test.token, PAGE, test.state.retention, Date.now()));
  expect(ready(test.cache.readSnapshot(test.token, PAGE, "old"))).not.toBeNull();
  read.doc.destroy();
  await waitUntil("the released read's out-of-retention snapshot to be evicted", () => ready(test.cache.readSnapshot(test.token, PAGE, "old")) === null);
  test.state.connected = false;
  await expect(test.reader.get(PAGE, "old")).rejects.toMatchObject({ code: "not-downloaded" });
});

it("refuses known deleted pages and decisions before touching the cache", async () => {
  const test = await fixture();
  const cached = vi.spyOn(test.worker, "open");
  test.requireHistory.mockImplementation(() => { throw new RevisionClientError("decision-no-history"); });
  await expect(test.reader.list(PAGE)).rejects.toMatchObject({ code: "decision-no-history" });
  await expect(test.reader.get(PAGE, "any")).rejects.toMatchObject({ code: "decision-no-history" });
  expect(cached).not.toHaveBeenCalled();
  expect(test.request).not.toHaveBeenCalled();
});

it("refreshes a cached catalog explicitly so unknown naming or restore outcomes can be checked", async () => {
  const test = await fixture();
  const existing = snapshot("before");
  const applied = snapshot("applied", "Restored state", { name: { text: "Applied", namedAt: 1_500, namer: null, canManage: true } });
  test.seed([existing.revision]);
  test.state.reply = async () => listed([applied.revision, existing.revision], "after-unknown-outcome");

  expect((await test.reader.list(PAGE)).revisions).toEqual([existing.revision]);
  expect(test.request).not.toHaveBeenCalled();
  expect((await test.reader.list(PAGE, { refresh: true })).revisions).toEqual([applied.revision, existing.revision]);
  expect(test.request).toHaveBeenCalledTimes(1);
  expect(ready(test.cache.readCatalog(test.token, PAGE))?.version).toBe("after-unknown-outcome");
});

it("writes a hub-applied name through to the catalog without claiming an uncached catalog is complete", async () => {
  const test = await fixture();
  const value = snapshot("named", "Named state", { name: { text: "Reviewed", namedAt: 1_500, namer: null, canManage: true } });
  await test.reader.writeThrough(PAGE, value.revision);
  expect(ready(test.cache.readCatalog(test.token, PAGE))).toMatchObject({ revisions: [value.revision], complete: false, refreshedAt: null });
  test.seed([{ ...value.revision, name: null }]);
  await test.reader.writeThrough(PAGE, value.revision);
  expect(ready(test.cache.readCatalog(test.token, PAGE))).toMatchObject({ revisions: [value.revision], complete: true, refreshedAt: 1_000 });
  expect(test.request).not.toHaveBeenCalled();
});
