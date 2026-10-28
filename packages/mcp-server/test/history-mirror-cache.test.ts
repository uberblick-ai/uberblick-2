import { generateKeyPairSync, randomUUID } from "node:crypto";
import { readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import * as Y from "yjs";
import { appendBlock, initDoc, type RevisionEntry } from "@uberblick/schema";
import { afterEach, expect, it } from "vitest";
import { removeHubLogin, writeHubLogin } from "../src/auth-store.js";
import { HistoryCache, type HistoryCacheResult } from "../src/history-cache.js";
import { HistoryMirrorCache } from "../src/history-mirror-cache.js";
import { acquireInitLock } from "../src/init-lock.js";
import { documentRevisionChecksum } from "../src/revision-client.js";
import { MirrorStore } from "../src/store.js";
import { rememberWorkspaceBindings } from "../src/workspace-registry.js";
import { removeTempDirs, tempDir, WORKSPACE } from "./shared.js";

const HUB = "wss://history.example.test/ws";
const PAGE = "1840680a-c086-44bd-b54a-b4be9adc7d84";
const workers: HistoryMirrorCache[] = [];
const stores: MirrorStore[] = [];
const caches: HistoryCache[] = [];

afterEach(async () => {
  for (const worker of workers.splice(0)) await worker.close();
  for (const cache of caches.splice(0)) cache.close();
  for (const store of stores.splice(0)) store.close();
  removeTempDirs();
});

function ready<T>(result: HistoryCacheResult<T>): T {
  expect(result.status).toBe("ready");
  if (result.status !== "ready") throw new Error(`History cache returned ${result.status}`);
  return result.value;
}

async function fixture(Cache = HistoryMirrorCache) {
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
  const worker = new Cache(path, WORKSPACE, env);
  workers.push(worker);
  const stamp = { hub: HUB, workspace: WORKSPACE, account: "123" };
  const token = ready(await worker.open(stamp));
  const cache = new HistoryCache(path, WORKSPACE, env);
  caches.push(cache);
  return { path, env, store, worker, cache, token, stamp };
}

function snapshot() {
  const document = new Y.Doc();
  try {
    initDoc(document, { uuid: PAGE, title: "History worker", description: "" });
    appendBlock(document, { type: "paragraph", text: "Verified content" });
    return { state: Y.encodeStateAsUpdate(document), checksum: documentRevisionChecksum(document) };
  } finally { document.destroy(); }
}

function catalog(checksum: string) {
  const revisions: RevisionEntry[] = [
    { id: "revision-one", author: null, startedAt: 5, endedAt: 6, final: true, checksum },
    { id: "revision-two", author: null, startedAt: 3, endedAt: 4, final: true, checksum },
    { id: "revision-three", author: null, startedAt: 1, endedAt: 2, final: true, checksum },
  ];
  return { revisions, version: "version-one", refreshedAt: 1, complete: true, failed: false };
}

it("verifies source-worker downloads, enforces retention and preserves permanent deletion fences", async () => {
  const test = await fixture();
  const content = snapshot();
  ready(await test.worker.putCatalog(PAGE, catalog(content.checksum)));
  expect(ready(await test.worker.listPages())).toEqual([PAGE]);
  expect(ready(await test.worker.putVerifiedSnapshot(PAGE, "revision-one", "a".repeat(64), content.state))).toBe(false);
  expect(ready(await test.worker.hasSnapshot(PAGE, "revision-one", content.checksum))).toBe(false);
  expect(ready(await test.worker.putVerifiedSnapshot(PAGE, "revision-one", content.checksum, content.state))).toBe(true);
  expect(ready(await test.worker.putVerifiedSnapshot(PAGE, "revision-two", content.checksum, content.state))).toBe(true);
  expect(ready(await test.worker.putVerifiedSnapshot(PAGE, "revision-three", content.checksum, content.state))).toBe(true);
  expect(ready(await test.worker.hasSnapshot(PAGE, "revision-one", content.checksum))).toBe(true);
  expect(ready(test.cache.readSnapshot(test.token, PAGE, "revision-one"))?.state).toEqual(Buffer.from(content.state));
  ready(await test.worker.markRefreshFailed(PAGE));
  expect(ready(await test.worker.readCatalog(PAGE))?.failed).toBe(true);
  ready(await test.worker.evict(PAGE, { mode: "named" }, Date.now()));
  expect(ready(await test.worker.hasSnapshot(PAGE, "revision-one", content.checksum))).toBe(true);
  expect(ready(await test.worker.hasSnapshot(PAGE, "revision-two", content.checksum))).toBe(true);
  expect(ready(await test.worker.hasSnapshot(PAGE, "revision-three", content.checksum))).toBe(false);
  ready(test.cache.purgeDoc(PAGE));
  expect(ready(await test.worker.listPages())).toEqual([]);
  expect(await test.worker.putCatalog(PAGE, catalog(content.checksum))).toEqual({ status: "superseded" });
  expect(await test.worker.putVerifiedSnapshot(PAGE, "revision-one", content.checksum, content.state)).toEqual({ status: "superseded" });
  await test.worker.close();
  expect(await test.worker.readCatalog(PAGE)).toEqual({ status: "unavailable" });
});

it("allows the live event loop to release a writer while cache publication waits for SQLite", async () => {
  const test = await fixture();
  const database = new DatabaseSync(test.path);
  let released = false;
  let release: NodeJS.Timeout | undefined;
  try {
    database.exec("BEGIN IMMEDIATE");
    const publication = test.worker.putCatalog(PAGE, catalog(snapshot().checksum));
    release = setTimeout(() => {
      database.exec("COMMIT");
      released = true;
    }, 50);
    ready(await publication);
    expect(released).toBe(true);
  } finally {
    clearTimeout(release);
    if (database.isTransaction) database.exec("ROLLBACK");
    database.close();
  }
});

it("cancels queued cache work and ends its worker before returning from close", async () => {
  const test = await fixture();
  const database = new DatabaseSync(test.path);
  let deadline: NodeJS.Timeout | undefined;
  try {
    database.exec("BEGIN IMMEDIATE");
    const publication = test.worker.putCatalog(PAGE, catalog(snapshot().checksum));
    // Queue the publication before shutdown starts.
    await Promise.resolve();
    await Promise.race([
      test.worker.close(),
      new Promise<never>((_resolve, reject) => {
        deadline = setTimeout(() => reject(new Error("Cache shutdown waited for queued work.")), 1_000);
      }),
    ]);
    expect(await publication).toEqual({ status: "unavailable" });
    database.exec("COMMIT");
    expect(ready(test.cache.readCatalog(test.token, PAGE))).toBeNull();
    expect(await test.worker.putCatalog(PAGE, catalog(snapshot().checksum))).toEqual({ status: "unavailable" });
  } finally {
    clearTimeout(deadline);
    if (database.isTransaction) database.exec("ROLLBACK");
    database.close();
  }
});

it("refuses a replacement workspace even before the worker's first cache request", async () => {
  const test = await fixture();
  await test.worker.close();
  const stale = new HistoryMirrorCache(test.path, WORKSPACE, test.env);
  workers.push(stale);
  test.store.close();
  renameSync(test.path, `${test.path}.removed`);
  const replacementStore = new MirrorStore(test.path, WORKSPACE);
  stores.push(replacementStore);
  const replacementCache = new HistoryCache(test.path, WORKSPACE, test.env);
  caches.push(replacementCache);
  const replacementToken = ready(replacementCache.open(test.stamp));
  expect(await stale.open(test.stamp)).toEqual({ status: "unavailable" });
  expect(await stale.putCatalog(PAGE, catalog(snapshot().checksum))).toEqual({ status: "unavailable" });
  expect(ready(replacementCache.listPages(replacementToken))).toEqual([]);
});

it("resumes persisted history for retention after logout and fences that token when another account signs in", async () => {
  const test = await fixture();
  const content = snapshot();
  ready(await test.worker.putCatalog(PAGE, catalog(content.checksum)));
  for (const id of ["revision-one", "revision-two", "revision-three"]) {
    expect(ready(await test.worker.putVerifiedSnapshot(PAGE, id, content.checksum, content.state))).toBe(true);
  }
  await test.worker.close();
  await removeHubLogin("https://history.example.test", test.env);
  const resumed = new HistoryMirrorCache(test.path, WORKSPACE, test.env);
  workers.push(resumed);
  expect(ready(await resumed.resume())).toEqual(test.token);
  ready(await resumed.evict(PAGE, { mode: "named" }, Date.now()));
  expect(ready(await resumed.hasSnapshot(PAGE, "revision-one", content.checksum))).toBe(true);
  expect(ready(await resumed.hasSnapshot(PAGE, "revision-three", content.checksum))).toBe(false);

  const principalId = randomUUID();
  await writeHubLogin("https://history.example.test", {
    identity: { id: principalId, githubAccountId: "456", githubUsername: "another-account" },
    credential: {
      record: { id: randomUUID(), principalId, deviceId: randomUUID(), workspaces: [WORKSPACE], issuedAt: 1, revokedAt: null },
      key: generateKeyPairSync("ed25519").privateKey.export({ format: "der", type: "pkcs8" }).toString("base64url"),
    },
  }, test.env);
  expect(await resumed.evict(PAGE, { mode: "everything" }, Date.now())).toEqual({ status: "superseded" });
  expect(await resumed.resume()).toEqual({ status: "superseded" });
  const next = ready(await resumed.open({ ...test.stamp, account: "456" }));
  expect(next.generation).not.toBe(test.token.generation);
  expect(ready(await resumed.listPages())).toEqual([]);
});

it("uses the enclosing installed bundle without running its executable entry in the worker", async () => {
  const directory = tempDir();
  const bundle = join(directory, "installed.mjs");
  const marker = join(directory, "entry-runs");
  const source = fileURLToPath(new URL("../src/history-mirror-cache.ts", import.meta.url));
  await build({
    stdin: {
      contents: `import { HistoryMirrorCache } from ${JSON.stringify(source)};
        import { appendFileSync } from "node:fs";
        appendFileSync(${JSON.stringify(marker)}, "entry\\n");
        export { HistoryMirrorCache };`,
      resolveDir: fileURLToPath(new URL("..", import.meta.url)),
      sourcefile: "installed-entry.ts",
    },
    outfile: bundle, bundle: true, platform: "node", format: "esm", target: "node26", minify: true,
  });
  const installed = await import(pathToFileURL(bundle).href) as { HistoryMirrorCache: typeof HistoryMirrorCache };
  const test = await fixture(installed.HistoryMirrorCache);
  const content = snapshot();
  ready(await test.worker.putCatalog(PAGE, catalog(content.checksum)));
  expect(ready(await test.worker.putVerifiedSnapshot(PAGE, "revision-one", content.checksum, content.state))).toBe(true);
  await test.worker.close();
  expect(readFileSync(marker, "utf8")).toBe("entry\n");
});
