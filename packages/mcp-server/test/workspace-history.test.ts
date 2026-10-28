import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { createTeamHub } from "@uberblick/hub/team";
import { issueCredential } from "@uberblick/hub/test-device-credentials";
import { getMeta, isDirectoryEntryArchived, roomForDoc } from "@uberblick/schema";
import { afterEach, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { writeHubLogin } from "../src/auth-store.js";
import { createMcpEngine } from "../src/engine.js";
import { HistoryCache, type HistoryCacheResult } from "../src/history-cache.js";
import { acquireInitLock } from "../src/init-lock.js";
import { mutateDocumentRevision } from "../src/revision-client.js";
import { rememberWorkspaceBindings } from "../src/workspace-registry.js";
import { cleanupTestResources, hubUrl, LIVE_HUB_SETTLE, startServer, tempDir, testConfig, waitUntil, WORKSPACE } from "./helpers.js";

const clients: Array<() => unknown> = [];
const hubs: Array<() => unknown> = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupTestResources({ clients: clients.splice(0), hubs: hubs.splice(0) });
});

function ready<T>(result: HistoryCacheResult<T>): T {
  if (result.status !== "ready") throw new Error(`History cache returned ${result.status}.`);
  return result.value;
}

function hasHistoryTables(path: string): boolean {
  const database = new DatabaseSync(path);
  try {
    return database.prepare("SELECT 1 FROM sqlite_schema WHERE name = 'history_cache'").get() !== undefined;
  } finally { database.close(); }
}

function snapshotTitle(state: Uint8Array): string {
  const doc = new Y.Doc();
  try { Y.applyUpdate(doc, state); return getMeta(doc).title; }
  finally { doc.destroy(); }
}

it("mirrors through the browser-serving engine and retains downloaded history through device refusal", async () => {
  const hub = await createTeamHub({
    address: "127.0.0.1", port: 0, databasePath: ":memory:",
    github: { clientId: "Iv1.0123456789abcdef", fetch: vi.fn(() => { throw new Error("Unexpected GitHub request."); }) },
    log() {},
  }, { deviceCredentials: true });
  hubs.push(() => hub.stop());
  if (hub.credentials === undefined || hub.memberships === undefined || hub.principals === undefined) {
    throw new Error("The team hub requires device authority.");
  }
  const principal = hub.principals.identify("12345", "history-author");
  hub.memberships.grant({ workspaceId: WORKSPACE, principalId: principal.id, role: "admin" });
  const issued = issueCredential(hub.credentials, { principalId: principal.id, deviceId: randomUUID(), workspaces: [WORKSPACE] });
  const root = tempDir();
  const env = { XDG_CONFIG_HOME: root, XDG_DATA_HOME: root, HOME: root };
  const endpoint = hubUrl(hub.port);
  const lock = await acquireInitLock(env);
  try { rememberWorkspaceBindings([{ workspaceId: WORKSPACE, hubUrl: endpoint }], env, WORKSPACE); }
  finally { lock.release(); }
  const { replacedAt: _replacedAt, ...record } = issued.record;
  await writeHubLogin(`http://127.0.0.1:${hub.port}`, {
    identity: principal,
    credential: { record, key: Buffer.from(issued.keyBytes).toString("base64url") },
  }, env);
  const config = () => ({ ...testConfig({ hubUrl: endpoint, ...LIVE_HUB_SETTLE }), deviceLogin: { env } });
  const author = await startServer(config());
  clients.push(() => author.close());
  const live = await author.ok("create_doc", { title: "Never opened here", description: "History must arrive before a reader asks.",
    blocks: [{ type: "paragraph", text: "Earlier content" }] });
  expect(await author.instance.replicas.waitForSettled()).toMatchObject({ caughtUp: true });
  const earlier = (await author.ok("name_revision", { uuid: live.uuid, name: "Earlier" })).revision;
  const survivor = await author.ok("create_doc", { title: "Retained offline", description: "A second live page is mirrored too.",
    blocks: [{ type: "paragraph", text: "Keep this downloaded history" }] });
  expect(await author.instance.replicas.waitForSettled()).toMatchObject({ caughtUp: true });
  const survivorRevision = (await author.ok("name_revision", { uuid: survivor.uuid, name: "Retained" })).revision;
  const archived = await author.ok("create_doc", { title: "Archived before bootstrap", description: "Do not attach this room in the background.",
    blocks: [{ type: "paragraph", text: "Already archived" }] });
  expect(await author.instance.replicas.waitForSettled()).toMatchObject({ caughtUp: true });
  await author.ok("name_revision", { uuid: archived.uuid, name: "Archived" });
  await author.ok("archive_doc", { uuid: archived.uuid });
  const decision = await author.ok("create_doc", { title: "Which history is mirrored?", description: "Decision records use their topic timeline.",
    kind: "decision", status: "decided", blocks: [{ type: "paragraph", text: "Mirror regular pages." }] });
  expect(await author.instance.replicas.waitForSettled()).toMatchObject({ caughtUp: true });
  expect(hasHistoryTables(author.config.databasePath)).toBe(false);

  const servingConfig = config();
  const engine = await createMcpEngine(servingConfig, { serving: true });
  clients.push(() => engine.close());
  const requested = vi.spyOn(engine.replicas.sync, "requestRevisions");
  const cache = new HistoryCache(servingConfig.databasePath, WORKSPACE, env);
  clients.push(() => cache.close());
  const token = ready(cache.open({ hub: endpoint, workspace: WORKSPACE, account: "12345" }));
  const catalog = (uuid: string) => ready(cache.readCatalog(token, uuid));
  const snapshot = (uuid: string, revision: string) => ready(cache.readSnapshot(token, uuid, revision));
  await waitUntil("all live pages' closed snapshots to arrive without reader calls", () =>
    snapshot(live.uuid, earlier.id) !== null && snapshot(survivor.uuid, survivorRevision.id) !== null);
  expect(catalog(live.uuid)).toMatchObject({ complete: true, failed: false,
    revisions: [{ id: earlier.id, final: true, name: { text: "Earlier" } }] });
  expect(snapshotTitle(snapshot(live.uuid, earlier.id)!.state)).toBe("Never opened here");
  expect(catalog(archived.uuid)).toBeNull();
  expect(catalog(decision.uuid)).toBeNull();
  expect(engine.replicas.hydrated(archived.uuid)).toBe(false);
  expect(requested.mock.calls.every(([room]) => room !== roomForDoc(WORKSPACE, archived.uuid) && room !== roomForDoc(WORKSPACE, decision.uuid))).toBe(true);

  const agent = await startServer({ ...config(), databasePath: servingConfig.databasePath });
  clients.push(() => agent.close());
  const agentRequests = vi.spyOn(agent.instance.replicas.sync, "requestRevisions");
  await author.ok("set_metadata", { uuid: live.uuid, title: "Changed after bootstrap" });
  await waitUntil("the mirrored content change to expose an undownloaded open head", () => {
    const head = catalog(live.uuid)?.revisions[0];
    return head?.title === "Changed after bootstrap" && head.final === false;
  });
  const open = catalog(live.uuid)!.revisions[0]!;
  expect(snapshot(live.uuid, open.id)).toBeNull();
  expect(snapshotTitle(snapshot(live.uuid, earlier.id)!.state)).toBe("Never opened here");
  const latest = (await author.ok("name_revision", { uuid: live.uuid, name: "Latest" })).revision;
  await waitUntil("a name notice to close and download the current head", () => snapshot(live.uuid, latest.id) !== null);
  expect(snapshotTitle(snapshot(live.uuid, latest.id)!.state)).toBe("Changed after bootstrap");
  await mutateDocumentRevision(author.instance.replicas, live.uuid, { operation: "rename", revisionId: latest.id, name: "Renamed" });
  await waitUntil("a name-only notice to replace the cached catalog", () => catalog(live.uuid)?.revisions[0]?.name?.text === "Renamed");
  expect(await agent.instance.replicas.waitForSettled()).toMatchObject({ caughtUp: true });
  expect(agentRequests).not.toHaveBeenCalled();
  expect(hasHistoryTables(author.config.databasePath)).toBe(false);

  await author.ok("archive_doc", { uuid: live.uuid });
  await waitUntil("archive state and history revalidation to reach the serving engine", () =>
    isDirectoryEntryArchived(engine.replicas.directory().doc, live.uuid) && catalog(live.uuid)?.revisions[0]?.name?.canManage === false);
  expect(snapshot(live.uuid, earlier.id)).not.toBeNull();
  expect(snapshot(live.uuid, latest.id)).not.toBeNull();
  expect(requested.mock.calls.filter(([room, request]) => room === roomForDoc(WORKSPACE, live.uuid) &&
    request.operation === "get" && request.revisionId === earlier.id)).toHaveLength(1);
  expect(requested.mock.calls.filter(([room, request]) => room === roomForDoc(WORKSPACE, live.uuid) &&
    request.operation === "get" && request.revisionId === latest.id)).toHaveLength(1);
  await author.ok("delete_doc", { uuid: live.uuid });
  await waitUntil("permanent deletion to purge mirrored history", () => engine.replicas.isDeleted(live.uuid) && catalog(live.uuid) === null);
  expect(snapshot(live.uuid, earlier.id)).toBeNull();
  expect(snapshot(live.uuid, latest.id)).toBeNull();

  hub.credentials.revoke(issued.record.id);
  hub.hocuspocus.closeConnections();
  await waitUntil("the revoked device to require sign-in", () => engine.replicas.sync.state().authRecovery === "sign-in-required");
  expect(catalog(survivor.uuid)?.complete).toBe(true);
  const retained = snapshot(survivor.uuid, survivorRevision.id);
  expect(retained).not.toBeNull();
  await engine.close();
  const reopened = await createMcpEngine(servingConfig, { serving: true });
  clients.push(() => reopened.close());
  expect(reopened.replicas.sync.state().authRecovery).toBe("sign-in-required");
  expect(snapshot(survivor.uuid, survivorRevision.id)).toEqual(retained);
  expect(catalog(live.uuid)).toBeNull();
  expect(catalog(archived.uuid)).toBeNull();
  expect(ready(cache.resume())?.generation).toBe(token.generation);
});
