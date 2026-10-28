import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { createHub, silentLogger, type Hub } from "@uberblick/hub";
import { createTeamHub } from "@uberblick/hub/team";
import { issueCredential } from "@uberblick/hub/test-device-credentials";
import { DEFAULT_HUB_URL, compareCorpus, createMcpServer, inspectRemote, isIdentical, resolveMcpConfig, syncWorkspace } from "@uberblick/mcp-server";
import { removeHubLogin, writeHubLogin } from "@uberblick/mcp-server/auth-store";
import { resolveConfig } from "@uberblick/mcp-server/project-config";
import { readWorkspaceHub, workspaceRegistryPath } from "@uberblick/mcp-server/workspace-registry";
import { appendBlock, createGroup, deleteDirectoryEntry, getBlocks, getWorkspaceMainRepository, getWorkspaceName, initDoc, isDirectoryEntryDeleted, listDirectory, pinDoc, readSidebar, setWorkspaceMainRepository, tombstoneDirectoryEntry, upsertDirectoryEntry } from "@uberblick/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HistoryCache, type HistoryCacheResult } from "../../mcp-server/src/history-cache.js";
import { acquireServingReplicaRole } from "../../mcp-server/src/serving-role.js";
import { startServer } from "../../mcp-server/test/helpers.js";
import { localBrowserKey } from "../src/browser-key.js";
import { fixture } from "./auth-fixtures.js";
import { freePort, runUbAsync, sandbox, type Sandbox } from "./helpers.js";
import { runInProcess } from "./in-process.js";
import { authMessage, bearer, cleanUp, fixtureBundle, holdDefaultHub, open } from "./open-fixtures.js";

const WORKSPACE = "cfb24a02-0870-490b-aeca-356ff5a2b4da";
const OTHER = "420ddf73-e7ef-4592-b399-f4863869eae3";
const HUB = "wss://detach.example.test/ws";
const hubs = new Set<Hub>();

beforeEach(holdDefaultHub);
afterEach(async () => {
  try {
    for (const hub of hubs) await hub.stop();
  } finally {
    hubs.clear();
    await cleanUp();
  }
});

function databasePath(box: Sandbox, workspace = WORKSPACE): string {
  return box.env.UBERBLICK_DB ?? join(box.dataHome, "uberblick", `${workspace}.sqlite`);
}

function record(box: Sandbox, workspace: string, hubUrl: string | null): void {
  const path = workspaceRegistryPath(box.env);
  mkdirSync(dirname(path), { recursive: true });
  const existing = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
  writeFileSync(path, JSON.stringify({ ...existing, [workspace]: hubUrl }));
}

function selected(box: Sandbox): { workspaceId: string; hubUrl: string | null } {
  return JSON.parse(readFileSync(join(box.cwd, ".uberblick.json"), "utf8"));
}

function offline(box: Sandbox, workspace = WORKSPACE) {
  return { ...resolveMcpConfig({ ...box.env, WORKSPACE_ID: workspace }), authSecret: null };
}

function rows(path: string, tables: readonly string[]) {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    return tables.map(table => ({ table, rows: database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all() }));
  } finally { database.close(); }
}

function ready<T>(result: HistoryCacheResult<T>): T {
  expect(result.status).toBe("ready");
  if (result.status !== "ready") throw new Error(`history returned ${result.status}`);
  return result.value;
}

async function populated(box: Sandbox) {
  const instance = createMcpServer(offline(box));
  const live = randomUUID();
  const archived = randomUUID();
  const deleted = randomUUID();
  try {
    for (const [uuid, title] of [[live, "Live notes"], [archived, "Archived notes"], [deleted, "Deleted notes"]] as const) {
      const document = instance.replicas.replica(uuid).doc;
      initDoc(document, { uuid, title });
      appendBlock(document, { type: "paragraph", text: `${title} saved before detach` });
      upsertDirectoryEntry(instance.replicas.directory().doc, { uuid, title });
    }
    tombstoneDirectoryEntry(instance.replicas.directory().doc, archived);
    tombstoneDirectoryEntry(instance.replicas.directory().doc, deleted);
    deleteDirectoryEntry(instance.replicas.directory().doc, deleted);
    setWorkspaceMainRepository(instance.replicas.settings().doc, "acme/detached-notes");
    const group = createGroup(instance.replicas.sidebar().doc, "Project notes");
    pinDoc(instance.replicas.sidebar().doc, group, live);
    instance.store.setHistoryRetention({ mode: "everything" });
    await instance.replicas.settle();
    return { live, archived, deleted, sidebar: readSidebar(instance.replicas.sidebar().doc) };
  } finally { await instance.close(); }
}

async function cacheHistory(box: Sandbox, uuid: string) {
  const login = fixture([WORKSPACE]);
  await writeHubLogin("https://detach.example.test", login, box.env);
  const stamp = { hub: HUB, workspace: WORKSPACE, account: login.identity.githubAccountId };
  const cache = new HistoryCache(databasePath(box), WORKSPACE, box.env);
  try {
    const token = ready(cache.open(stamp));
    ready(cache.putCatalog(token, uuid, { revisions: [{ id: "old-revision", author: null, startedAt: 1,
      endedAt: 2, final: true, checksum: "a".repeat(64) }], version: "old-catalog", refreshedAt: 12, complete: true, failed: false }));
    ready(cache.putSnapshot(token, uuid, "old-revision", "a".repeat(64), new Uint8Array([1, 2, 3])));
    return { stamp, token, login };
  } finally { cache.close(); }
}

async function detachedSandbox() {
  const box = sandbox({ projectBinding: { workspaceId: WORKSPACE, hubUrl: HUB } });
  box.env.PORT = String(await freePort());
  box.env.HUB_DB_PATH = join(box.cwd, "local-hub.sqlite");
  record(box, WORKSPACE, HUB);
  return box;
}

describe("ub workspace detach", () => {
  it.each(["default", "configured"])("works offline and signed out with a %s database, preserving user state and pending changes while discarding downloaded history", async storage => {
    const box = await detachedSandbox();
    if (storage === "configured") box.env.UBERBLICK_DB = join(box.cwd, "custom-replica.sqlite");
    const documents = await populated(box);
    const expected = await syncWorkspace(offline(box));
    const history = await cacheHistory(box, documents.live);
    await removeHubLogin("https://detach.example.test", box.env);
    const tables = ["updates", "snapshots", "pending_rooms", "sync_acknowledgements", "doc_index", "doc_index_seq", "doc_tags", "doc_links"];
    const before = rows(databasePath(box), tables);
    expect(before.find(entry => entry.table === "pending_rooms")?.rows.length).toBeGreaterThan(0);
    const otherBinding = join(box.cwd, "another-project", ".uberblick.json");
    mkdirSync(dirname(otherBinding));
    writeFileSync(otherBinding, JSON.stringify({ workspaceId: WORKSPACE, hubUrl: HUB }));
    const otherBindingBefore = readFileSync(otherBinding);
    const preload = join(box.cwd, "no-network.mjs");
    writeFileSync(preload, `
import { Socket } from "node:net";
Socket.prototype.connect = () => { throw new Error("detach must make no hub request"); };
globalThis.fetch = () => { throw new Error("detach must make no hub request"); };
`);
    const result = await runUbAsync(["workspace", "detach", WORKSPACE.slice(0, 8)], box,
      { NODE_OPTIONS: `--import=${pathToFileURL(preload).href}` });
    expect(result.status, result.output).toBe(0);
    expect(result.stdout).toContain(WORKSPACE);
    expect(result.stdout).toContain("https://detach.example.test");
    expect(result.stdout).toContain("ub workspace use");
    expect(result.stdout).toContain(join(box.cwd, ".uberblick.json"));
    expect(readWorkspaceHub(WORKSPACE, box.env)).toBeNull();
    expect(selected(box)).toEqual({ workspaceId: WORKSPACE, hubUrl: null });
    if (storage === "configured") expect(existsSync(join(box.dataHome, "uberblick", `${WORKSPACE}.sqlite`))).toBe(false);
    expect(readFileSync(otherBinding)).toEqual(otherBindingBefore);
    expect(rows(databasePath(box), tables)).toEqual(before);
    expect(rows(databasePath(box), ["history_v1_pages", "history_v1_catalog_chunks", "history_v1_snapshots", "history_v1_snapshot_chunks"]).every(entry => entry.rows.length === 0)).toBe(true);
    const actual = await syncWorkspace(offline(box));
    expect(isIdentical(compareCorpus(expected.entries, actual.entries))).toBe(true);
    expect(isIdentical(compareCorpus(expected.workspace!, actual.workspace!))).toBe(true);
    const restarted = await startServer(offline(box));
    try {
      expect(getWorkspaceMainRepository(restarted.instance.replicas.settings().doc)).toBe("acme/detached-notes");
      expect(readSidebar(restarted.instance.replicas.sidebar().doc)).toEqual(documents.sidebar);
      expect(isDirectoryEntryDeleted(restarted.instance.replicas.directory().doc, documents.deleted)).toBe(true);
      expect(restarted.instance.store.readHistoryRetention()).toEqual({ mode: "everything" });
      const revisions = await restarted.call("list_revisions", { uuid: documents.live });
      expect(revisions.isError).toBe(true);
      expect(revisions.payload.error).toBe("revisions_local_only");
    } finally { await restarted.close(); }
    const listed = await runInProcess(["workspace", "list", "--json"], box);
    expect(listed.status, listed.output).toBe(0);
    expect(JSON.parse(listed.stdout)).toContainEqual(expect.objectContaining({ uuid: WORKSPACE, hub: "local" }));
    if (storage === "default") {
      const status = await runUbAsync(["status", "--json"], box);
      expect(status.status, status.output).toBe(0);
      expect(JSON.parse(status.stdout)).toMatchObject({ workspace: { id: WORKSPACE }, hub: null, problems: [] });
      const data = await runUbAsync(["data", "get", documents.live], box);
      expect(data.status, data.output).toBe(0);
      expect(data.stdout).toBe("no data\n");
      const app = await open(box, ["--port", String(await freePort())], {
        UBERBLICK_WEB_DIST: fixtureBundle(box), BROWSER: "none",
      });
      try {
        const configuration = await fetch(`${app.url}uberblick-config.json`);
        expect(configuration.status).toBe(200);
        expect(await configuration.json()).toMatchObject({ remoteHubUrl: DEFAULT_HUB_URL,
          servedWorkspaces: { [WORKSPACE]: { remoteHubUrl: DEFAULT_HUB_URL } } });
        const revisions = await fetch(`${app.url}api/revisions?uuid=${documents.live}`, {
          headers: bearer(await authMessage(localBrowserKey(WORKSPACE, box.env), "read-only", { workspace: WORKSPACE })),
        });
        expect(revisions.status).toBe(503);
        expect(await revisions.json()).toEqual({ error: "history_unavailable", reason: "local-only" });
      } finally { expect((await app.interrupt()).status).toBe(0); }
    }
    record(box, WORKSPACE, HUB);
    await writeHubLogin("https://detach.example.test", history.login, box.env);
    const reopened = new HistoryCache(databasePath(box), WORKSPACE, box.env);
    try {
      const token = ready(reopened.open(history.stamp));
      expect(token.generation).not.toBe(history.token.generation);
      expect(reopened.readSnapshot(history.token, documents.live, "old-revision")).toEqual({ status: "superseded" });
      expect(ready(reopened.readCatalog(token, documents.live))).toBeNull();
      expect(ready(reopened.readSnapshot(token, documents.live, "old-revision"))).toBeNull();
    } finally { reopened.close(); }
  });

  it("leaves another workspace's binding untouched", async () => {
    const box = await detachedSandbox();
    await populated(box);
    writeFileSync(join(box.cwd, ".uberblick.json"), JSON.stringify({ workspaceId: OTHER, hubUrl: null }));
    const binding = readFileSync(join(box.cwd, ".uberblick.json"));
    const result = await runInProcess(["workspace", "detach", WORKSPACE], box);
    expect(result.status, result.output).toBe(0);
    expect(readWorkspaceHub(WORKSPACE, box.env)).toBeNull();
    expect(readFileSync(join(box.cwd, ".uberblick.json"))).toEqual(binding);
    expect(result.stdout).not.toContain(join(box.cwd, ".uberblick.json"));
  });

  it("refuses a record without a local copy before creating a replica", async () => {
    const box = await detachedSandbox();
    const binding = readFileSync(join(box.cwd, ".uberblick.json"));
    const registry = readFileSync(workspaceRegistryPath(box.env));
    const result = await runInProcess(["workspace", "detach", WORKSPACE], box);
    expect(result.status, result.output).toBe(1);
    expect(result.stderr).toMatch(/copy|replica/);
    expect(readFileSync(join(box.cwd, ".uberblick.json"))).toEqual(binding);
    expect(readFileSync(workspaceRegistryPath(box.env))).toEqual(registry);
    expect(existsSync(databasePath(box))).toBe(false);
    expect(existsSync(box.env.HUB_DB_PATH!)).toBe(false);
  });

  it.each(["serving replica", "local hub"])("refuses a running %s before changing the record, binding, history or local hub", async running => {
    const box = await detachedSandbox();
    const documents = await populated(box);
    await cacheHistory(box, documents.live);
    const localHub = await createHub({ port: 0, databasePath: box.env.HUB_DB_PATH!, authSecret: "synthetic-detach-secret", log: silentLogger });
    await localHub.stop();
    const paths = [databasePath(box), workspaceRegistryPath(box.env), join(box.cwd, ".uberblick.json"), box.env.HUB_DB_PATH!];
    let role: ReturnType<typeof acquireServingReplicaRole> | undefined;
    const listener = createServer(socket => socket.destroy(new Error("detach sent a hub request")));
    if (running === "serving replica") role = acquireServingReplicaRole(databasePath(box), { pid: process.pid, sessionId: "detach-refusal" });
    else await new Promise<void>(resolve => listener.listen(Number(box.env.PORT), "127.0.0.1", resolve));
    const before = paths.map(path => readFileSync(path));
    try {
      const result = await runUbAsync(["workspace", "detach", WORKSPACE], box);
      expect(result.status, result.output).toBe(1);
      expect(result.stderr).toMatch(running === "serving replica" ? /ub open|serving/ : /local hub/);
      expect(result.stderr).toMatch(/stop/i);
      expect(paths.map(path => readFileSync(path))).toEqual(before);
    } finally {
      role?.close();
      if (listener.listening) await new Promise<void>(resolve => listener.close(() => resolve()));
    }
  });

  it("keeps permanent deletions across a stale local hub, preserves hub-only changes, and explicitly reconnects local edits", async () => {
    const box = sandbox();
    box.env.PORT = String(await freePort());
    box.env.HUB_DB_PATH = join(box.cwd, "local-hub.sqlite");
    const created = await runInProcess(["workspace", "create", "Detached project"], box);
    expect(created.status, created.output).toBe(0);
    const workspace = selected(box).workspaceId;
    const localConfig = resolveMcpConfig(resolveConfig({ env: box.env, cwd: box.cwd }).env);
    const localHubConfig = { port: Number(box.env.PORT), address: "127.0.0.1", databasePath: box.env.HUB_DB_PATH,
      authSecret: localConfig.authSecret!, log: silentLogger, debounce: 10, maxDebounce: 20 };
    let localHub = await createHub(localHubConfig);
    hubs.add(localHub);
    const localEndpoint = `ws://127.0.0.1:${localHub.port}`;
    const deleted = randomUUID();
    let live = "";
    const seed = createMcpServer(offline(box, workspace));
    try {
      live = listDirectory(seed.replicas.directory().doc)[0]!.uuid;
      const document = seed.replicas.replica(deleted).doc;
      initDoc(document, { uuid: deleted, title: "Deleted after promotion" });
      appendBlock(document, { type: "paragraph", text: "Must never return from the stale local hub" });
      upsertDirectoryEntry(seed.replicas.directory().doc, { uuid: deleted, title: "Deleted after promotion" });
    } finally { await seed.close(); }
    const originalLocal = await syncWorkspace({ ...localConfig, hubUrl: localEndpoint, localWorkspace: true });
    expect(originalLocal.unsettled).toEqual([]);
    const remote = await createTeamHub({ port: 0, address: "127.0.0.1", databasePath: join(box.cwd, "remote.sqlite"),
      github: { clientId: "Iv1.0123456789abcdef", fetch: async () => { throw new Error("fixture login must not call GitHub"); } },
      log: silentLogger, debounce: 10, maxDebounce: 20 }, { deviceCredentials: true, initializeDefaultWorkspace: true });
    hubs.add(remote);
    const identity = remote.principals!.identify("1201", "detach-test-person");
    remote.hubAdmins!.grant(identity.id);
    const credential = issueCredential(remote.credentials!, { principalId: identity.id, deviceId: randomUUID(), workspaces: [] });
    const endpoint = `ws://127.0.0.1:${remote.port}`;
    await writeHubLogin(`http://127.0.0.1:${remote.port}`, { identity,
      credential: { record: credential.record, key: Buffer.from(credential.keyBytes).toString("base64url") } }, box.env);
    const promoted = await runInProcess(["workspace", "promote", endpoint], box, { UB_TEST_MAX_WAIT_MS: "5000" });
    expect(promoted.status, promoted.output).toBe(0);
    const remoteConfig = resolveMcpConfig({ ...box.env, WORKSPACE_ID: workspace, HUB_URL: endpoint, HUB_ADMISSION: "device" });
    const connected = createMcpServer(remoteConfig);
    try {
      await connected.replicas.settle();
      tombstoneDirectoryEntry(connected.replicas.directory().doc, deleted);
      expect((await connected.replicas.waitForSettled()).caughtUp).toBe(true);
      deleteDirectoryEntry(connected.replicas.directory().doc, deleted);
      expect((await connected.replicas.waitForSettled()).caughtUp).toBe(true);
      expect(isDirectoryEntryDeleted(connected.replicas.directory().doc, deleted)).toBe(true);
    } finally { await connected.close(); }
    const hubOnly = randomUUID();
    const localOnlyCopy = createMcpServer({ ...localConfig, databasePath: join(box.cwd, "local-hub-writer.sqlite"),
      hubUrl: localEndpoint, localWorkspace: true });
    try {
      await localOnlyCopy.replicas.settle();
      appendBlock(localOnlyCopy.replicas.replica(live).doc, { type: "paragraph", text: "Only the local hub has this edit" });
      const document = localOnlyCopy.replicas.replica(hubOnly).doc;
      initDoc(document, { uuid: hubOnly, title: "Only in the local hub" });
      appendBlock(document, { type: "paragraph", text: "Preserve this unique local hub content" });
      upsertDirectoryEntry(localOnlyCopy.replicas.directory().doc, { uuid: hubOnly, title: "Only in the local hub" });
      expect((await localOnlyCopy.replicas.waitForSettled()).caughtUp).toBe(true);
    } finally { await localOnlyCopy.close(); }
    const unrelated = createMcpServer({ ...localConfig, workspaceId: OTHER, databasePath: join(box.cwd, "unrelated.sqlite"),
      hubUrl: localEndpoint, localWorkspace: true });
    try {
      const uuid = randomUUID();
      initDoc(unrelated.replicas.replica(uuid).doc, { uuid, title: "Unrelated workspace" });
      upsertDirectoryEntry(unrelated.replicas.directory().doc, { uuid, title: "Unrelated workspace" });
      await unrelated.replicas.settle();
      expect((await unrelated.replicas.waitForSettled()).caughtUp).toBe(true);
    } finally { await unrelated.close(); }
    await localHub.stop();
    hubs.delete(localHub);
    const before = rows(box.env.HUB_DB_PATH!, ["documents"])[0]!.rows;
    expect(before.some(row => row.name === `${workspace}/${deleted}`)).toBe(true);
    const accessBefore = rows(remote.databasePath, ["hub_memberships", "hub_admins", "hub_workspace_promotions"]);
    const detached = await runInProcess(["workspace", "detach", workspace], box);
    expect(detached.status, detached.output).toBe(0);
    expect(selected(box)).toEqual({ workspaceId: workspace, hubUrl: null });
    expect(readWorkspaceHub(workspace, box.env)).toBeNull();
    expect(rows(box.env.HUB_DB_PATH!, ["documents"])[0]!.rows).toEqual(before.filter(row => row.name !== `${workspace}/${deleted}`));
    expect(rows(remote.databasePath, ["hub_memberships", "hub_admins", "hub_workspace_promotions"])).toEqual(accessBefore);
    localHub = await createHub(localHubConfig);
    hubs.add(localHub);
    const joined = createMcpServer({ ...resolveMcpConfig(resolveConfig({ env: box.env, cwd: box.cwd }).env), hubUrl: localEndpoint, localWorkspace: true });
    try {
      await joined.replicas.settle();
      expect((await joined.replicas.waitForSettled()).caughtUp).toBe(true);
      expect(isDirectoryEntryDeleted(joined.replicas.directory().doc, deleted)).toBe(true);
      expect(listDirectory(joined.replicas.directory().doc).map(entry => entry.uuid)).not.toContain(deleted);
      expect(getWorkspaceName(joined.replicas.settings().doc)).toBe("Detached project");
      expect(getBlocks(joined.replicas.replica(live).doc).map(block => block.text)).toContain("Only the local hub has this edit");
      expect(getBlocks(joined.replicas.replica(hubOnly).doc).map(block => block.text)).toContain("Preserve this unique local hub content");
      appendBlock(joined.replicas.replica(live).doc, { type: "paragraph", text: "Edited after detach" });
      expect((await joined.replicas.waitForSettled()).caughtUp).toBe(true);
    } finally { await joined.close(); }
    const localRemote = await inspectRemote({ ...localConfig, hubUrl: localEndpoint }, { documents: true, workspace: true });
    expect(localRemote.entries.map(entry => entry.uuid)).not.toContain(deleted);
    const reconnected = await runInProcess(["workspace", "use", `${endpoint}/${workspace}`], box, { UB_TEST_MAX_WAIT_MS: "5000" });
    expect(reconnected.status, reconnected.output).toBe(0);
    expect(readWorkspaceHub(workspace, box.env)).toBe(endpoint);
    const verify = createMcpServer({ ...remoteConfig, databasePath: join(box.cwd, "verify-remote.sqlite") });
    try {
      await verify.replicas.settle();
      expect(isDirectoryEntryDeleted(verify.replicas.directory().doc, deleted)).toBe(true);
      expect(getBlocks(verify.replicas.replica(live).doc).map(block => block.text)).toContain("Edited after detach");
      expect(getBlocks(verify.replicas.replica(hubOnly).doc).map(block => block.text)).toContain("Preserve this unique local hub content");
    } finally { await verify.close(); }
  });
});
