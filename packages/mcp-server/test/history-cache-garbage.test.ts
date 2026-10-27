import { generateKeyPairSync, randomUUID } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { RevisionEntry } from "@uberblick/schema";
import { afterEach, describe, expect, it, vi } from "vitest";
import { writeHubLogin } from "../src/auth-store.js";
import { HISTORY_CACHE_FORMAT, HistoryCache, type HistoryCacheResult, type HistoryCacheToken } from "../src/history-cache.js";
import { HistoryHoldSession } from "../src/history-holds.js";
import { acquireInitLock } from "../src/init-lock.js";
import { authenticationOrigin } from "../src/remote-url.js";
import { MirrorStore } from "../src/store.js";
import { rememberWorkspaceBindings } from "../src/workspace-registry.js";
import { WORKSPACE, removeTempDirs, tempDir } from "./shared.js";

const HUB = "wss://history-garbage.example.test/ws";
const PAGE = "1840680a-c086-44bd-b54a-b4be9adc7d84";
const CHECKSUM = "a".repeat(64);
const stores: MirrorStore[] = [];
const caches: HistoryCache[] = [];
const databases: DatabaseSync[] = [];
const sessions: HistoryHoldSession[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const cache of caches.splice(0)) cache.close();
  for (const session of sessions.splice(0)) session.close();
  for (const database of databases.splice(0)) database.close();
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
  try { rememberWorkspaceBindings([{ workspaceId: WORKSPACE, hubUrl: HUB }], env, WORKSPACE); }
  finally { lock.release(); }
  const principal = randomUUID();
  await writeHubLogin(authenticationOrigin(HUB), {
    identity: { id: principal, githubAccountId: "123", githubUsername: "account-123" },
    credential: {
      record: { id: randomUUID(), principalId: principal, deviceId: randomUUID(), workspaces: [WORKSPACE], issuedAt: Date.now(), revokedAt: null },
      key: generateKeyPairSync("ed25519").privateKey.export({ format: "der", type: "pkcs8" }).toString("base64url"),
    },
  }, env);
  const path = join(directory, "workspace.sqlite");
  const store = new MirrorStore(path, WORKSPACE);
  stores.push(store);
  const cache = new HistoryCache(path, WORKSPACE, env);
  caches.push(cache);
  const database = new DatabaseSync(path);
  databases.push(database);
  const stamp = { hub: HUB, workspace: WORKSPACE, account: "123" };
  const token = ready(cache.open(stamp));
  return { path, env, cache, database, stamp, token };
}

function entry(id: string): RevisionEntry {
  return { id, author: null, startedAt: 1, endedAt: 2, final: true, checksum: CHECKSUM };
}

function catalog(cache: HistoryCache, token: HistoryCacheToken, revisions: RevisionEntry[]): void {
  ready(cache.putCatalog(token, PAGE, { revisions, version: "version", refreshedAt: 123, complete: true, failed: false }));
}

describe("history staging cleanup", () => {
  it("reclaims unpublished catalog and snapshot chunks after a failed publication without damaging the previous publication", async () => {
    const test = await fixture();
    catalog(test.cache, test.token, [entry("one")]);
    const original = new Uint8Array([1, 2, 3]);
    ready(test.cache.putSnapshot(test.token, PAGE, "one", CHECKSUM, original));
    test.database.exec("CREATE TRIGGER refuse_snapshot_publication BEFORE INSERT ON history_v1_snapshots BEGIN SELECT RAISE(FAIL, 'publication failed'); END");
    expect(test.cache.putSnapshot(test.token, PAGE, "one", CHECKSUM, new Uint8Array(150_000))).toEqual({ status: "unavailable" });
    test.database.exec("DROP TRIGGER refuse_snapshot_publication");
    test.database.exec("CREATE TRIGGER refuse_catalog_publication BEFORE INSERT ON history_v1_pages BEGIN SELECT RAISE(FAIL, 'publication failed'); END");
    expect(test.cache.putCatalog(test.token, PAGE, {
      revisions: Array.from({ length: 700 }, (_, index) => entry(`unpublished-${index}`)),
      version: "unpublished", refreshedAt: 456, complete: true, failed: false,
    })).toEqual({ status: "unavailable" });
    test.database.exec("DROP TRIGGER refuse_catalog_publication");
    expect(test.database.prepare("SELECT count(*) AS count FROM history_v1_snapshot_chunks").get()?.count).toBeGreaterThan(1);
    expect(test.database.prepare("SELECT count(*) AS count FROM history_v1_catalog_chunks").get()?.count).toBeGreaterThan(1);
    ready(test.cache.open(test.stamp));
    expect(test.database.prepare("SELECT count(*) AS count FROM history_v1_snapshot_chunks").get()?.count).toBe(1);
    expect(test.database.prepare("SELECT count(*) AS count FROM history_v1_catalog_chunks").get()?.count).toBe(1);
    expect(ready(test.cache.readCatalog(test.token, PAGE))?.revisions).toEqual([entry("one")]);
    expect(ready(test.cache.readSnapshot(test.token, PAGE, "one"))?.state).toEqual(Buffer.from(original));
  });

  it("keeps live staging chunks and reclaims the same leftovers once their session has ended", async () => {
    const test = await fixture();
    const staged = new HistoryHoldSession(test.path);
    sessions.push(staged);
    test.database.prepare("INSERT INTO history_v1_holds VALUES (?, ?, ?, ?)").run(test.token.generation, PAGE, "in-flight", staged.id);
    test.database.prepare("INSERT INTO history_v1_holds VALUES (?, ?, ?, ?)").run(test.token.generation, PAGE, "catalog:unfinished", staged.id);
    test.database.prepare("INSERT INTO history_v1_snapshot_chunks VALUES (?, ?, ?, ?, ?, ?)")
      .run(test.token.generation, PAGE, "in-flight", "unfinished", 0, new Uint8Array([1]));
    test.database.prepare("INSERT INTO history_v1_catalog_chunks VALUES (?, ?, ?, ?, ?)")
      .run(test.token.generation, PAGE, "unfinished", 0, new Uint8Array([2]));
    ready(test.cache.open(test.stamp));
    expect(test.database.prepare("SELECT count(*) AS count FROM history_v1_snapshot_chunks").get()?.count).toBe(1);
    expect(test.database.prepare("SELECT count(*) AS count FROM history_v1_catalog_chunks").get()?.count).toBe(1);
    staged.close();
    ready(test.cache.open(test.stamp));
    expect(test.database.prepare("SELECT count(*) AS count FROM history_v1_snapshot_chunks").get()?.count).toBe(0);
    expect(test.database.prepare("SELECT count(*) AS count FROM history_v1_catalog_chunks").get()?.count).toBe(0);
  });

  it("refuses a published snapshot whose stored chunks are incomplete", async () => {
    const test = await fixture();
    catalog(test.cache, test.token, [entry("one")]);
    ready(test.cache.putSnapshot(test.token, PAGE, "one", CHECKSUM, new Uint8Array(150_000)));
    test.database.prepare("DELETE FROM history_v1_snapshot_chunks WHERE part = 1").run();
    expect(test.cache.readSnapshot(test.token, PAGE, "one")).toEqual({ status: "unavailable" });
    expect(ready(test.cache.readCatalog(test.token, PAGE))?.revisions).toEqual([entry("one")]);
  });

  it("checks holds acquired after retention selection and keeps the held revision's direct predecessor", async () => {
    const test = await fixture();
    const revisions = ["five", "four", "three", "two", "one", "zero"].map(entry);
    catalog(test.cache, test.token, revisions);
    for (const revision of revisions) ready(test.cache.putSnapshot(test.token, PAGE, revision.id, CHECKSUM, new Uint8Array([1])));
    const peer = new HistoryCache(test.path, WORKSPACE, test.env);
    caches.push(peer);
    const peerToken = ready(peer.open(test.stamp));
    test.database.prepare("INSERT INTO history_v1_holds VALUES (?, ?, ?, ?)")
      .run(test.token.generation, PAGE, "already-dead", randomUUID());
    const original = HistoryHoldSession.prototype.isAlive;
    let lateHold: { release(): void } | undefined;
    vi.spyOn(HistoryHoldSession.prototype, "isAlive").mockImplementation(function(this: HistoryHoldSession, id: string): boolean {
      lateHold ??= ready(peer.hold(peerToken, PAGE, "two"));
      return original.call(this, id);
    });
    ready(test.cache.evict(test.token, PAGE, { mode: "named" }, Date.now()));
    expect(lateHold).toBeDefined();
    expect(ready(test.cache.readSnapshot(test.token, PAGE, "two"))).not.toBeNull();
    expect(ready(test.cache.readSnapshot(test.token, PAGE, "one"))).not.toBeNull();
    expect(ready(test.cache.readSnapshot(test.token, PAGE, "three"))).toBeNull();
    expect(ready(test.cache.readSnapshot(test.token, PAGE, "zero"))).toBeNull();
    lateHold?.release();
  });

  it("rebuilds a format using its own tables when an older format has an incompatible physical layout", async () => {
    const test = await fixture();
    test.database.exec("DROP TABLE history_v1_pages; DROP TABLE history_v1_catalog_chunks; DROP TABLE history_v1_snapshots; DROP TABLE history_v1_snapshot_chunks; DROP TABLE history_v1_holds; DROP TABLE history_v1_deleted");
    test.database.exec("CREATE TABLE history_pages (incompatible TEXT); CREATE TABLE history_snapshots (incompatible TEXT); CREATE TABLE history_catalog_chunks (incompatible TEXT); CREATE TABLE history_snapshot_chunks (incompatible TEXT)");
    test.database.exec("INSERT INTO history_pages VALUES ('old metadata'); INSERT INTO history_snapshots VALUES ('old snapshot'); INSERT INTO history_catalog_chunks VALUES ('old catalog'); INSERT INTO history_snapshot_chunks VALUES ('old chunk')");
    test.database.exec("CREATE TABLE history_v0_snapshot_chunks (old_layout BLOB); INSERT INTO history_v0_snapshot_chunks VALUES (X'0102')");
    test.database.prepare("UPDATE history_cache SET format = ?").run(HISTORY_CACHE_FORMAT - 1);
    const next = ready(test.cache.open(test.stamp));
    expect(next.generation).not.toBe(test.token.generation);
    for (const table of ["history_pages", "history_snapshots", "history_catalog_chunks", "history_snapshot_chunks", "history_v0_snapshot_chunks"]) {
      expect(test.database.prepare(`SELECT * FROM ${table}`).all()).toEqual([]);
    }
    catalog(test.cache, next, [entry("one")]);
    ready(test.cache.putSnapshot(next, PAGE, "one", CHECKSUM, new Uint8Array([1])));
    expect(ready(test.cache.readSnapshot(next, PAGE, "one"))?.state).toEqual(Buffer.from([1]));
  });
});
