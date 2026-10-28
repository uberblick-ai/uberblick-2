import { generateKeyPairSync, randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { RevisionEntry } from "@uberblick/schema";
import { afterEach, describe, expect, it, vi } from "vitest";
import { credentialsPath, removeHubLogin, writeHubLogin, type StoredHubLogin } from "../src/auth-store.js";
import { HISTORY_CACHE_FORMAT, HistoryCache, type HistoryCacheResult, type HistoryCacheStamp, type HistoryCacheToken } from "../src/history-cache.js";
import { acquireInitLock } from "../src/init-lock.js";
import { authenticationOrigin } from "../src/remote-url.js";
import { MirrorStore } from "../src/store.js";
import { rememberWorkspaceBindings } from "../src/workspace-registry.js";
import { WORKSPACE, removeTempDirs, tempDir } from "./shared.js";

const HUB = "wss://history.example.test/ws";
const OTHER_HUB = "wss://other-history.example.test/ws";
const PAGE = "1840680a-c086-44bd-b54a-b4be9adc7d84";
const stores: MirrorStore[] = [];
const caches: HistoryCache[] = [];
const databases: DatabaseSync[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const cache of caches.splice(0)) cache.close();
  for (const database of databases.splice(0)) database.close();
  for (const store of stores.splice(0)) store.close();
  removeTempDirs();
});

function ready<T>(result: HistoryCacheResult<T>): T {
  expect(result.status).toBe("ready");
  if (result.status !== "ready") throw new Error(`history cache returned ${result.status}`);
  return result.value;
}

function login(account: string): StoredHubLogin {
  const principal = randomUUID();
  return {
    identity: { id: principal, githubAccountId: account, githubUsername: `account-${account}` },
    credential: {
      record: { id: randomUUID(), principalId: principal, deviceId: randomUUID(), workspaces: [WORKSPACE], issuedAt: Date.now(), revokedAt: null },
      key: generateKeyPairSync("ed25519").privateKey.export({ format: "der", type: "pkcs8" }).toString("base64url"),
    },
  };
}

async function recordHub(env: NodeJS.ProcessEnv, hub: string): Promise<void> {
  const lock = await acquireInitLock(env);
  try { rememberWorkspaceBindings([{ workspaceId: WORKSPACE, hubUrl: hub }], env, WORKSPACE); }
  finally { lock.release(); }
}

async function fixture() {
  const directory = tempDir();
  const env = { XDG_CONFIG_HOME: directory, XDG_DATA_HOME: directory, HOME: directory };
  await recordHub(env, HUB);
  await writeHubLogin(authenticationOrigin(HUB), login("123"), env);
  const path = join(directory, "workspace.sqlite");
  const store = new MirrorStore(path, WORKSPACE);
  stores.push(store);
  const cache = new HistoryCache(path, WORKSPACE, env);
  caches.push(cache);
  const database = new DatabaseSync(path);
  databases.push(database);
  const stamp: HistoryCacheStamp = { hub: HUB, workspace: WORKSPACE, account: "123" };
  const token = ready(cache.open(stamp));
  return { path, env, store, cache, database, stamp, token };
}

function entry(id: string, extra: Partial<RevisionEntry> = {}): RevisionEntry {
  return { id, author: null, startedAt: 1, endedAt: 2, final: true, checksum: "a".repeat(64), ...extra };
}

function catalog(cache: HistoryCache, token: HistoryCacheToken, revisions: RevisionEntry[], uuid = PAGE): void {
  ready(cache.putCatalog(token, uuid, { revisions, version: "hub-version", refreshedAt: 1234, complete: true, failed: false }));
}

function snapshot(cache: HistoryCache, token: HistoryCacheToken, revision: string, state = new Uint8Array([1, 2, 3])): void {
  ready(cache.putSnapshot(token, PAGE, revision, "a".repeat(64), state));
}

function authoritativeRows(database: DatabaseSync) {
  return ["meta", "updates", "snapshots", "pending_rooms", "sync_acknowledgements", "doc_index", "doc_index_seq", "doc_tags", "doc_links", "docs_fts"]
    .map(table => ({ table, rows: database.prepare(`SELECT * FROM ${table}`).all() }));
}

describe("disposable history storage", () => {
  it("roundtrips catalog metadata and large snapshots across restart, and records refresh failure separately", async () => {
    const test = await fixture();
    const revisions = [entry("open", {
      author: { githubUsername: "lena", surface: { kind: "browser", name: "browser" } },
      endedAt: null, final: false, deadlineAt: 9999, title: "Current title",
      name: { text: "Reviewed", namer: null, namedAt: 33, canManage: true },
    }), ...Array.from({ length: 900 }, (_, index) => entry(`older-${index}`, { title: "A sufficiently long revision title" }))];
    catalog(test.cache, test.token, revisions);
    const state = Uint8Array.from({ length: 200_003 }, (_, index) => index % 251);
    snapshot(test.cache, test.token, "open", state);
    ready(test.cache.markRefreshFailed(test.token, PAGE));
    test.cache.close();
    const reopened = new HistoryCache(test.path, WORKSPACE, test.env);
    caches.push(reopened);
    const token = ready(reopened.open(test.stamp));
    expect(token).toEqual(test.token);
    expect(ready(reopened.readCatalog(token, PAGE))).toMatchObject({ revisions, version: "hub-version", refreshedAt: 1234, complete: true, failed: true });
    expect(ready(reopened.readSnapshot(token, PAGE, "open"))).toEqual({ state: Buffer.from(state), checksum: "a".repeat(64) });
  });

  it("preserves document storage, pending changes, search and retention when the account stamp changes", async () => {
    const test = await fixture();
    const room = `${WORKSPACE}/${PAGE}`;
    const seq = test.store.appendUpdate(room, new Uint8Array([7, 8]), "local");
    test.store.indexDoc({ uuid: PAGE, title: "Searchable", description: "", body: "content", links: [], tags: [] }, seq);
    test.store.setHistoryRetention({ mode: "everything" });
    test.database.prepare("INSERT INTO meta VALUES (?, ?)").run("unrelated-file-fact", "preserve");
    catalog(test.cache, test.token, [entry("one")]);
    snapshot(test.cache, test.token, "one");
    const before = authoritativeRows(test.database);
    await writeHubLogin(authenticationOrigin(HUB), login("456"), test.env);
    const next = ready(test.cache.open({ ...test.stamp, account: "456" }));
    expect(next.generation).not.toBe(test.token.generation);
    expect(ready(test.cache.readCatalog(next, PAGE))).toBeNull();
    expect(ready(test.cache.readSnapshot(next, PAGE, "one"))).toBeNull();
    expect(authoritativeRows(test.database)).toEqual(before);
    expect(test.store.search("Searchable", 5)).toHaveLength(1);
    expect(test.cache.open(test.stamp)).toEqual({ status: "superseded" });
    expect(ready(test.cache.open({ ...test.stamp, account: "456" }))).toEqual(next);
    expect(test.cache.putCatalog(test.token, PAGE, { revisions: [], version: null, refreshedAt: null, complete: false, failed: false })).toEqual({ status: "superseded" });
  });

  it("uses the recorded hub to reject an old connection and rejects a foreign workspace stamp", async () => {
    const test = await fixture();
    catalog(test.cache, test.token, [entry("one")]);
    await recordHub(test.env, OTHER_HUB);
    await writeHubLogin(authenticationOrigin(OTHER_HUB), login("123"), test.env);
    expect(test.cache.open(test.stamp)).toEqual({ status: "superseded" });
    const next = ready(test.cache.open({ ...test.stamp, hub: OTHER_HUB }));
    expect(ready(test.cache.readCatalog(next, PAGE))).toBeNull();
    expect(test.cache.open(test.stamp)).toEqual({ status: "superseded" });
    expect(test.cache.open({ ...test.stamp, hub: OTHER_HUB, workspace: randomUUID() })).toEqual({ status: "superseded" });
    expect(ready(test.cache.open({ ...test.stamp, hub: OTHER_HUB }))).toEqual(next);
  });

  it("refuses a token if its generation changes between the authority read and the write transaction", async () => {
    const test = await fixture();
    catalog(test.cache, test.token, [entry("one")]);
    const nextGeneration = randomUUID();
    const original = DatabaseSync.prototype.exec;
    let reset = false;
    vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function(this: DatabaseSync, sql: string) {
      if (sql === "BEGIN IMMEDIATE" && !reset) {
        reset = true;
        test.database.prepare("UPDATE history_cache SET generation = ?").run(nextGeneration);
      }
      return original.call(this, sql);
    });
    expect(test.cache.markRefreshFailed(test.token, PAGE)).toEqual({ status: "superseded" });
    expect(reset).toBe(true);
    expect(test.database.prepare("SELECT failed FROM history_v1_pages WHERE generation = ? AND uuid = ?")
      .get(test.token.generation, PAGE)?.failed).toBe(0);
    expect(test.database.prepare("SELECT generation FROM history_cache").get()?.generation).toBe(nextGeneration);
  });

  it("keeps the generation and downloaded content through logout and login renewal by the same account", async () => {
    const test = await fixture();
    catalog(test.cache, test.token, [entry("one")]);
    snapshot(test.cache, test.token, "one");
    await removeHubLogin(authenticationOrigin(HUB), test.env);
    expect(ready(test.cache.open(test.stamp))).toEqual(test.token);
    expect(ready(test.cache.readSnapshot(test.token, PAGE, "one"))).not.toBeNull();
    await writeHubLogin(authenticationOrigin(HUB), login("123"), test.env);
    expect(ready(test.cache.open(test.stamp))).toEqual(test.token);
    expect(ready(test.cache.readCatalog(test.token, PAGE))?.revisions).toEqual([entry("one")]);
  });

  it("reports unreadable credentials only to history without treating them as a changed account", async () => {
    const test = await fixture();
    catalog(test.cache, test.token, [entry("one")]);
    const before = test.database.prepare("SELECT * FROM history_cache").all();
    writeFileSync(credentialsPath(test.env), "not JSON");
    expect(test.cache.open(test.stamp)).toEqual({ status: "unavailable" });
    expect(test.cache.readCatalog(test.token, PAGE)).toEqual({ status: "unavailable" });
    expect(test.database.prepare("SELECT * FROM history_cache").all()).toEqual(before);
    expect(() => test.store.appendUpdate(`${WORKSPACE}/${PAGE}`, new Uint8Array([1]), "local")).not.toThrow();
  });

  it("rebuilds an older format once and refuses every path against a newer format", async () => {
    const test = await fixture();
    catalog(test.cache, test.token, [entry("one")]);
    snapshot(test.cache, test.token, "one");
    test.database.prepare("UPDATE history_cache SET format = ?").run(HISTORY_CACHE_FORMAT - 1);
    const next = ready(test.cache.open(test.stamp));
    expect(next.generation).not.toBe(test.token.generation);
    expect(ready(test.cache.readCatalog(next, PAGE))).toBeNull();
    catalog(test.cache, next, [entry("one")]);
    snapshot(test.cache, next, "one");
    test.database.prepare("UPDATE history_cache SET format = ?").run(HISTORY_CACHE_FORMAT + 1);
    const header = test.database.prepare("SELECT * FROM history_cache").all();
    const pages = test.database.prepare("SELECT * FROM history_v1_pages").all();
    const snapshots = test.database.prepare("SELECT * FROM history_v1_snapshots").all();
    const refused = { status: "update-required" };
    expect(test.cache.open(test.stamp)).toEqual(refused);
    expect(test.cache.open({ ...test.stamp, account: "456" })).toEqual(refused);
    expect(test.cache.readCatalog(next, PAGE)).toEqual(refused);
    expect(test.cache.readSnapshot(next, PAGE, "one")).toEqual(refused);
    expect(test.cache.putCatalog(next, PAGE, { revisions: [], version: null, refreshedAt: null, complete: false, failed: false })).toEqual(refused);
    expect(test.cache.putSnapshot(next, PAGE, "one", "a".repeat(64), new Uint8Array([9]))).toEqual(refused);
    expect(test.cache.markRefreshFailed(next, PAGE)).toEqual(refused);
    expect(test.cache.hold(next, PAGE, "one")).toEqual(refused);
    expect(test.cache.evict(next, PAGE, { mode: "named" }, Date.now())).toEqual(refused);
    expect(test.cache.purgeDoc(PAGE)).toEqual(refused);
    expect(test.database.prepare("SELECT * FROM history_cache").all()).toEqual(header);
    expect(test.database.prepare("SELECT * FROM history_v1_pages").all()).toEqual(pages);
    expect(test.database.prepare("SELECT * FROM history_v1_snapshots").all()).toEqual(snapshots);
    const peer = new MirrorStore(test.path, WORKSPACE);
    stores.push(peer);
    expect(() => peer.appendUpdate(`${WORKSPACE}/${PAGE}`, new Uint8Array([1]), "local")).not.toThrow();
    expect(() => peer.purgeDoc(`${WORKSPACE}/${PAGE}`, PAGE)).not.toThrow();
    expect(test.database.prepare("SELECT * FROM history_v1_snapshots").all()).toEqual(snapshots);
  });

  it("purges cache-only leftovers after an older process removed authoritative copies, and fences in-flight work", async () => {
    const test = await fixture();
    catalog(test.cache, test.token, [entry("one")]);
    snapshot(test.cache, test.token, "one");
    expect(test.store.logSize()).toBe(0);
    test.store.purgeDoc(`${WORKSPACE}/${PAGE}`, PAGE);
    expect(ready(test.cache.readCatalog(test.token, PAGE))).toBeNull();
    expect(ready(test.cache.readSnapshot(test.token, PAGE, "one"))).toBeNull();
    expect(test.cache.putCatalog(test.token, PAGE, { revisions: [entry("one")], version: "stale-download", refreshedAt: 1, complete: true, failed: false })).toEqual({ status: "superseded" });
    expect(test.cache.putSnapshot(test.token, PAGE, "one", "a".repeat(64), new Uint8Array([9]))).toEqual({ status: "superseded" });
    expect(test.cache.hold(test.token, PAGE, "one")).toEqual({ status: "superseded" });
  });

  it("does not fail store opening, saves or permanent deletion when cache schema and writes fail", async () => {
    const test = await fixture();
    catalog(test.cache, test.token, [entry("one")]);
    const otherPage = randomUUID();
    catalog(test.cache, test.token, [entry("other")], otherPage);
    snapshot(test.cache, test.token, "one");
    test.database.exec("CREATE TRIGGER refuse_history_purge BEFORE DELETE ON history_v1_snapshot_chunks BEGIN SELECT RAISE(FAIL, 'cache-only purge failure'); END");
    const room = `${WORKSPACE}/${PAGE}`;
    test.store.appendUpdate(room, new Uint8Array([5]), "local");
    expect(() => test.store.purgeDoc(room, PAGE)).not.toThrow();
    expect(test.store.updatesAfter(room, 0)).toEqual([]);
    expect(test.store.pendingRooms()).toEqual([]);
    expect(test.cache.purgeDoc(PAGE)).toEqual({ status: "unavailable" });
    test.database.exec("DROP TRIGGER refuse_history_purge");
    test.database.exec("DROP TABLE history_v1_catalog_chunks");
    expect(test.cache.readCatalog(test.token, otherPage)).toEqual({ status: "unavailable" });
    const peer = new MirrorStore(test.path, WORKSPACE);
    stores.push(peer);
    expect(() => peer.appendUpdate(room, new Uint8Array([6]), "local")).not.toThrow();
    expect(() => peer.purgeDoc(room, PAGE)).not.toThrow();
    expect(peer.updatesAfter(room, 0)).toEqual([]);
  });

  it("contains cache creation and reset failures without changing authoritative state", async () => {
    const test = await fixture();
    catalog(test.cache, test.token, [entry("one")]);
    test.database.exec("CREATE TRIGGER refuse_history_reset BEFORE INSERT ON history_cache BEGIN SELECT RAISE(FAIL, 'cache-only reset failure'); END");
    await writeHubLogin(authenticationOrigin(HUB), login("456"), test.env);
    const before = authoritativeRows(test.database);
    expect(test.cache.open({ ...test.stamp, account: "456" })).toEqual({ status: "unavailable" });
    expect(authoritativeRows(test.database)).toEqual(before);
    const peer = new MirrorStore(test.path, WORKSPACE);
    stores.push(peer);
    expect(() => peer.appendUpdate(`${WORKSPACE}/${PAGE}`, new Uint8Array([1]), "local")).not.toThrow();
    test.cache.close();
    test.database.exec("DROP TABLE history_cache");
    test.database.exec("CREATE VIEW history_cache AS SELECT 1 AS incompatible");
    const broken = new HistoryCache(test.path, WORKSPACE, test.env);
    caches.push(broken);
    expect(broken.open({ ...test.stamp, account: "456" })).toEqual({ status: "unavailable" });
    expect(() => peer.purgeDoc(`${WORKSPACE}/${PAGE}`, PAGE)).not.toThrow();
  });

  it("keeps every active local and peer hold through eviction, including a held comparison predecessor", async () => {
    const test = await fixture();
    const revisions = ["five", "four", "three", "two", "one"].map(id => entry(id));
    catalog(test.cache, test.token, revisions);
    for (const revision of revisions) snapshot(test.cache, test.token, revision.id);
    const peer = new HistoryCache(test.path, WORKSPACE, test.env);
    caches.push(peer);
    const peerToken = ready(peer.open(test.stamp));
    const first = ready(peer.hold(peerToken, PAGE, "three"));
    const second = ready(peer.hold(peerToken, PAGE, "three"));
    snapshot(peer, peerToken, "three", new Uint8Array([9]));
    first.release();
    ready(test.cache.evict(test.token, PAGE, { mode: "named" }, Date.now()));
    expect(ready(test.cache.readSnapshot(test.token, PAGE, "five"))).not.toBeNull();
    expect(ready(test.cache.readSnapshot(test.token, PAGE, "four"))).not.toBeNull();
    expect(ready(test.cache.readSnapshot(test.token, PAGE, "three"))).not.toBeNull();
    expect(ready(test.cache.readSnapshot(test.token, PAGE, "two"))).not.toBeNull();
    expect(ready(test.cache.readSnapshot(test.token, PAGE, "one"))).toBeNull();
    second.release();
    ready(test.cache.evict(test.token, PAGE, { mode: "named" }, Date.now()));
    expect(ready(test.cache.readSnapshot(test.token, PAGE, "three"))).toBeNull();
    expect(ready(test.cache.readSnapshot(test.token, PAGE, "two"))).toBeNull();
  });
});
