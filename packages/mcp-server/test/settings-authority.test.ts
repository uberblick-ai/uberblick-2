/** Settings refusals replace only the refused room and preserve document sync. */
import { afterEach, expect, it, vi } from "vitest";
import { writeHubLogin, readHubLogins } from "@uberblick/mcp-server/auth-store";
import { startDeviceSyncHub } from "@uberblick/hub/test-device-sync";
import {
  createTagCatalogEntry,
  getMeta,
  getWorkspaceMainRepository,
  getWorkspaceName,
  isTagDeleted,
  listTagCatalog,
  roomForDoc,
  setTags,
  setTitle,
  setWorkspaceMainRepository,
  setWorkspaceName,
  settingsRoom,
} from "@uberblick/schema";
import { log } from "../src/log.js";
import { syncWorkspace } from "../src/remote.js";
import { openWorkspaceReplicas } from "../src/workspace-replicas.js";
import { fillWorkspaceMainRepository } from "../src/workspace-settings.js";
import { cleanupTestResources, startServer, tempDatabasePath, tempDir, testConfig, waitUntil, WAIT_TIMEOUT_MS, WORKSPACE } from "./helpers.js";
import type { Rig } from "./helpers.js";

type DeviceHub = Awaited<ReturnType<typeof startDeviceSyncHub>>;
const hubs: DeviceHub[] = [];
const rigs: Rig[] = [];
const localReplicas: ReturnType<typeof openWorkspaceReplicas>[] = [];

afterEach(async () => {
  await cleanupTestResources({
    clients: [...rigs.splice(0).map(rig => () => rig.close()), ...localReplicas.splice(0).map(local => () => local.close())],
    hubs: hubs.splice(0).map(hub => () => hub.close()),
  });
  vi.restoreAllMocks();
});

async function fixture() {
  const hub = await startDeviceSyncHub({ directory: tempDir() });
  hubs.push(hub);
  hub.grant(WORKSPACE);
  const env = { XDG_CONFIG_HOME: tempDir() };
  const login = hub.issue({ workspaces: [WORKSPACE] });
  await writeHubLogin(hub.origin, login, env);
  const config = {
    ...testConfig({ hubUrl: hub.url, connectTimeoutMs: 1_500, syncTimeoutMs: 3_000 }),
    reconnectMaxDelayMs: 250,
    deviceLogin: { env },
  };
  return { hub, env, login, config };
}

async function client(config: Parameters<typeof startServer>[0]): Promise<Rig> {
  const rig = await startServer(config);
  rigs.push(rig);
  return rig;
}

async function close(rig: Rig): Promise<void> {
  await rig.close();
  rigs.splice(rigs.indexOf(rig), 1);
}

async function caughtUp(rig: Rig): Promise<void> {
  const result = await rig.instance.replicas.waitForSettled({ deadline: performance.now() + WAIT_TIMEOUT_MS });
  const replicas = rig.instance.replicas;
  expect(result, JSON.stringify({ hub: replicas.sync.state(), pending: rig.instance.store.pendingRooms(),
    draining: replicas.sync.isDraining(), unapplied: [...rig.instance.store.syncSnapshot(replicas.attachedReplicas()
      .map(replica => ({ room: replica.room, throughSeq: replica.lastSeq }))).unappliedRooms],
    inFlight: replicas.sync.unsyncedChanges(), rooms: replicas.attachedReplicas().map(replica => ({ room: replica.room,
      quiet: replicas.isRoomQuiet(replica.room), seq: replica.lastSeq })), persistence: replicas.persistenceError() }))
    .toMatchObject({ caughtUp: true });
}

function refusals(warn: { mock: { calls: unknown[][] } }): string[] {
  return warn.mock.calls.flatMap(([message]) => typeof message === "string" && message.startsWith("The hub refused changes") ? [message] : []);
}

it("acknowledges an admin's MCP tag creation and description edit without retagging documents", async () => {
  const { hub, config } = await fixture();
  hub.changeRole(WORKSPACE, "admin");
  const rig = await client(config);
  await caughtUp(rig);
  const created = await rig.ok("create_tag", { name: "release", description: "Use for release coordination." });
  expect(created).toMatchObject({ name: "release", description: "Use for release coordination.", applied: true, synced: false });
  await caughtUp(rig);
  const assigned = await rig.ok("create_doc", {
    title: "Release planning",
    description: "The catalog edit preserves this assignment.",
    tags: [created.id],
  });
  await caughtUp(rig);
  const document = rig.instance.replicas.replica(assigned.uuid);
  const updates = vi.fn();
  document.doc.on("update", updates);

  const edited = await rig.ok("edit_tag", { id: created.id, description: "Use for planning and coordinating releases." });
  expect(edited).toMatchObject({ id: created.id, name: "release", description: "Use for planning and coordinating releases.", applied: true, synced: false });
  await caughtUp(rig);
  const entry = { id: created.id, name: "release", description: "Use for planning and coordinating releases." };
  expect(hub.readRoom(settingsRoom(WORKSPACE), listTagCatalog)).toEqual([entry]);
  expect((await rig.ok("list_tags"))).toMatchObject({ complete: true, tags: [entry] });
  expect(await rig.ok("create_tag", { name: " RELEASE ", description: "Must not replace guidance." }))
    .toMatchObject({ ...entry, applied: true, synced: true });
  expect(await rig.ok("edit_tag", { id: created.id, description: entry.description }))
    .toMatchObject({ ...entry, applied: true, synced: true });
  expect(getMeta(document.doc).tags).toEqual([created.id]);
  expect(updates).not.toHaveBeenCalled();
});

it.each(["create_tag", "edit_tag"] as const)("does not acknowledge a member's refused MCP %s change", async tool => {
  const { hub, config } = await fixture();
  hub.changeRole(WORKSPACE, "admin");
  const rig = await client(config);
  const existing = await rig.ok("create_tag", { name: "curated", description: "Hub guidance." });
  const assigned = await rig.ok("create_doc", {
    title: "Member document",
    description: "Members retain ordinary document access after a settings refusal.",
    tags: [existing.id],
  });
  await caughtUp(rig);
  const warning = vi.spyOn(log, "warn");
  hub.changeRole(WORKSPACE, "member");
  const result = await rig.ok(tool, tool === "create_tag"
    ? { name: "refused-tag", description: "Member creation." }
    : { id: existing.id, description: "Member description." });
  expect(result).toMatchObject({ applied: true, synced: false });
  await waitUntil("the member's MCP tag change to be replaced", () => rig.instance.store.settingsReset() !== null);
  await caughtUp(rig);
  const entry = { id: existing.id, name: "curated", description: "Hub guidance." };
  expect((await rig.ok("list_tags"))).toMatchObject({ complete: true, tags: [entry] });
  expect(hub.readRoom(settingsRoom(WORKSPACE), listTagCatalog)).toEqual([entry]);
  expect(refusals(warning)).toHaveLength(1);
  expect(refusals(warning)[0]).toContain("tag catalog");
  expect(getMeta(rig.instance.replicas.replica(assigned.uuid).doc).tags).toEqual([existing.id]);
  expect(await rig.ok("set_metadata", { uuid: assigned.uuid, description: "A member can still edit this document." }))
    .toMatchObject({ applied: true });
  await caughtUp(rig);
  expect(hub.readRoom(roomForDoc(WORKSPACE, assigned.uuid), getMeta)?.description).toBe("A member can still edit this document.");
  expect(hub.renewalCount).toBe(0);
});

it.each([false, true])("judges offline MCP tag creation and description edits when they reach the hub after demotion=%s", async demoted => {
  const { hub, config } = await fixture();
  hub.changeRole(WORKSPACE, "admin");
  const rig = await client(config);
  const existing = await rig.ok("create_tag", { name: "curated", description: "Hub guidance." });
  await caughtUp(rig);
  await hub.pause();
  await waitUntil("the tag editor to become offline", () => rig.instance.replicas.sync.state().status !== "connected");
  expect((await rig.ok("list_tags")).complete).toBe(false);
  const created = await rig.ok("create_tag", { name: "offline-category", description: "Offline creation." });
  const edited = await rig.ok("edit_tag", { id: existing.id, description: "Offline guidance." });
  expect(created).toMatchObject({ name: "offline-category", applied: true, synced: false });
  expect(edited).toMatchObject({ id: existing.id, description: "Offline guidance.", applied: true, synced: false });
  if (demoted) hub.changeRole(WORKSPACE, "member");
  const warning = vi.spyOn(log, "warn");
  await hub.resume();
  const expected = demoted
    ? [{ id: existing.id, name: "curated", description: "Hub guidance." }]
    : [{ id: existing.id, name: "curated", description: "Offline guidance." },
      { id: created.id, name: "offline-category", description: "Offline creation." }];
  await waitUntil("the offline MCP catalog outcome", () =>
    JSON.stringify(listTagCatalog(rig.instance.replicas.settings().doc)) === JSON.stringify(expected) &&
    rig.instance.replicas.sync.state().status === "connected" &&
    (!demoted || rig.instance.store.settingsReset() !== null));
  await caughtUp(rig);
  expect(hub.readRoom(settingsRoom(WORKSPACE), listTagCatalog)).toEqual(expected);
  expect((await rig.ok("list_tags"))).toMatchObject({ complete: true, tags: expected });
  expect((await rig.ok("sync_status")).pendingRooms).toEqual([]);
  expect(refusals(warning)).toHaveLength(demoted ? 1 : 0);
  if (demoted) expect(refusals(warning)[0]).toContain("tag catalog");
  expect(hub.renewalCount).toBe(0);
});

it("hides legacy retired tags for members and migrates them only after an admin receives the hub catalog", async () => {
  const { hub, config } = await fixture();
  const member = await client(config);
  await caughtUp(member);
  const room = settingsRoom(WORKSPACE);
  const id = crypto.randomUUID();
  hub.readRoom(room, catalog => {
    catalog.getMap<string>("tag-identities").set(id, "legacy");
  });
  await waitUntil("the legacy tag to arrive", async () => (await member.ok("list_tags")).tags.some((tag: { id: string }) => tag.id === id));
  const created = await member.ok("create_doc", { title: "Legacy assignment", description: "Migration never rewrites documents.", tags: [id] });
  await caughtUp(member);
  expect(hub.readRoom(room, catalog => {
    catalog.getMap<number>("tag-retired").set("legacy#old", 1);
    return catalog.getMap<number>("tag-retired").get("legacy#old");
  })).toBe(1);
  const warning = vi.spyOn(log, "warn");
  await member.ok("list_tags");
  expect(member.instance.replicas.settings().doc.getMap("tag-flags").toJSON()).toEqual({});
  await waitUntil("the member to receive the retirement", () => member.instance.replicas.settings().doc.getMap<number>("tag-retired").get("legacy#old") === 1);
  expect((await member.ok("list_tags")).tags).toEqual([]);
  expect((await member.ok("get_doc", { uuid: created.uuid })).tags).toEqual([]);
  expect(isTagDeleted(member.instance.replicas.settings().doc, id)).toBe(false);
  expect(member.instance.store.settingsReset()).toBeNull();
  expect(refusals(warning)).toEqual([]);
  expect(member.instance.store.pendingRooms().some(entry => entry.room === room)).toBe(false);

  hub.changeRole(WORKSPACE, "admin");
  const admin = await client({ ...config, databasePath: tempDatabasePath() });
  await waitUntil("the admin to migrate the hub catalog", async () => {
    await admin.ok("list_tags");
    return isTagDeleted(admin.instance.replicas.settings().doc, id);
  });
  await caughtUp(admin);
  expect(hub.readRoom(room, catalog => isTagDeleted(catalog, id))).toBe(true);
  expect(getMeta(member.instance.replicas.replica(created.uuid).doc).tags).toEqual([id]);
  expect(member.instance.store.settingsReset()).toBeNull();
  expect(refusals(warning)).toEqual([]);
});

it("waits for the hub restoration before migrating an admin's stale cached retirement", async () => {
  const { hub, config } = await fixture();
  const member = await client(config);
  await caughtUp(member);
  const room = settingsRoom(WORKSPACE);
  const id = crypto.randomUUID();
  hub.readRoom(room, catalog => {
    catalog.getMap<string>("tag-identities").set(id, "restored");
    catalog.getMap<number>("tag-retired").set("restored#old", 1);
  });
  await waitUntil("the stale retirement to arrive", () => member.instance.replicas.settings().doc.getMap<number>("tag-retired").get("restored#old") === 1);
  await close(member);
  const keeper = await client({ ...config, databasePath: tempDatabasePath() });
  await caughtUp(keeper);
  hub.readRoom(room, catalog => catalog.getMap<number>("tag-restored").set("restored#old", 2));
  await waitUntil("the restoration to reach the hub-connected member", async () => (await keeper.ok("list_tags")).tags.some((tag: { id: string }) => tag.id === id));
  hub.changeRole(WORKSPACE, "admin");
  const restarted = await client(config);
  await caughtUp(restarted);
  expect((await restarted.ok("list_tags")).tags).toEqual([{ id, name: "restored" }]);
  expect(isTagDeleted(restarted.instance.replicas.settings().doc, id)).toBe(false);
  expect(hub.readRoom(room, catalog => isTagDeleted(catalog, id))).toBe(false);
});

it("discards a member's queued settings changes and retains the restored state across restart", async () => {
  const { hub, config, env, login } = await fixture();
  await syncWorkspace(config);
  await hub.pause();
  fillWorkspaceMainRepository(WORKSPACE, "member/checkout", config.databasePath);
  const offline = openWorkspaceReplicas(config, { hubFree: true });
  try {
    setWorkspaceName(offline.replicas.settings().doc, "Member offline rename");
    offline.replicas.assertHealthy();
    expect(offline.store.pendingRooms().some(entry => entry.room === settingsRoom(WORKSPACE))).toBe(true);
  } finally { offline.close(); }

  const warn = vi.spyOn(log, "warn");
  await hub.resume();
  const rig = await client(config);
  await waitUntil("the queued member settings to be replaced", () => rig.instance.store.settingsReset() !== null);
  await caughtUp(rig);
  expect(getWorkspaceName(rig.instance.replicas.settings().doc)).toBeNull();
  expect(getWorkspaceMainRepository(rig.instance.replicas.settings().doc)).toBeNull();
  expect(hub.readRoom(settingsRoom(WORKSPACE), getWorkspaceName)).toBeNull();
  expect(hub.readRoom(settingsRoom(WORKSPACE), getWorkspaceMainRepository)).toBeNull();
  expect((await rig.ok("list_tags"))).toMatchObject({ complete: true, tags: [], hub: { status: "connected" } });
  expect(await rig.ok("sync_status")).toMatchObject({ unsyncedChanges: 0, inFlightUpdates: 0, pendingRooms: [], persistence: null });
  expect(refusals(warn)).toHaveLength(1);
  expect(refusals(warn)[0]).toContain("workspace name, main repository");
  expect(hub.renewalCount).toBe(0);
  expect(readHubLogins(env).logins[hub.origin]).toEqual(login);

  await close(rig);
  const restarted = await client(config);
  await caughtUp(restarted);
  expect(getWorkspaceName(restarted.instance.replicas.settings().doc)).toBeNull();
  expect(getWorkspaceMainRepository(restarted.instance.replicas.settings().doc)).toBeNull();
  expect((await restarted.ok("list_tags")).complete).toBe(true);
  expect((await restarted.ok("sync_status")).pendingRooms).toEqual([]);
  expect(refusals(warn)).toHaveLength(1);
});

it.each([false, true])("judges an admin's offline edit on arrival after demotion=%s", async demoted => {
  const { hub, config } = await fixture();
  hub.changeRole(WORKSPACE, "admin");
  const rig = await client(config);
  setWorkspaceName(rig.instance.replicas.settings().doc, "Hub name");
  await caughtUp(rig);
  await hub.pause();
  await waitUntil("the admin replica to become offline", () => rig.instance.replicas.sync.state().status !== "connected");
  setWorkspaceName(rig.instance.replicas.settings().doc, "Offline admin rename");
  if (demoted) hub.changeRole(WORKSPACE, "member");
  const warn = vi.spyOn(log, "warn");
  await hub.resume();
  const expected = demoted ? "Hub name" : "Offline admin rename";
  await waitUntil("the offline settings outcome", () => getWorkspaceName(rig.instance.replicas.settings().doc) === expected &&
    rig.instance.replicas.sync.state().status === "connected" &&
    (!demoted || rig.instance.store.settingsReset() !== null));
  await caughtUp(rig);
  expect(hub.readRoom(settingsRoom(WORKSPACE), getWorkspaceName)).toBe(expected);
  expect((await rig.ok("list_tags")).complete).toBe(true);
  expect((await rig.ok("sync_status")).pendingRooms).toEqual([]);
  expect(refusals(warn)).toHaveLength(demoted ? 1 : 0);
  expect(hub.renewalCount).toBe(0);
});

it("fences live demotion without disturbing document rooms and accepts fresh edits after promotion", async () => {
  const { hub, config, env, login } = await fixture();
  hub.changeRole(WORKSPACE, "admin");
  const rig = await client(config);
  const initial = rig.instance.replicas.settings().doc;
  initial.transact(() => {
    setWorkspaceName(initial, "Hub name");
    setWorkspaceMainRepository(initial, "hub/selected");
    createTagCatalogEntry(initial, "curated");
  });
  const created = await rig.ok("create_doc", { title: "Shared document", description: "Both roles can edit documents." });
  await caughtUp(rig);
  const observer = await client({ ...config, databasePath: tempDatabasePath() });
  await observer.ok("get_doc", { uuid: created.uuid });
  await caughtUp(observer);
  const witnessedNames = [getWorkspaceName(observer.instance.replicas.settings().doc)];
  observer.instance.replicas.settings().doc.on("update", () => {
    witnessedNames.push(getWorkspaceName(observer.instance.replicas.settings().doc));
  });
  const docRoom = roomForDoc(WORKSPACE, created.uuid);
  const documentAdmissions = hub.authentications.filter(({ room }) => room === docRoom).length;
  const warn = vi.spyOn(log, "warn");
  hub.changeRole(WORKSPACE, "member");
  let refusedTag = "";
  initial.transact(() => {
    setWorkspaceName(initial, "Refused live rename");
    setWorkspaceMainRepository(initial, "member/refused");
    refusedTag = createTagCatalogEntry(initial, "refused-tag").id;
  });
  setTags(rig.instance.replicas.replica(created.uuid).doc, [refusedTag]);
  await waitUntil("the live settings refusal to restore the hub state", () => rig.instance.store.settingsReset() !== null &&
    getWorkspaceName(rig.instance.replicas.settings().doc) === "Hub name");
  await caughtUp(rig);
  expect(getWorkspaceMainRepository(rig.instance.replicas.settings().doc)).toBe("hub/selected");
  expect(listTagCatalog(rig.instance.replicas.settings().doc).map(tag => tag.name)).toEqual(["curated"]);
  expect((await rig.ok("get_doc", { uuid: created.uuid })).tags).toEqual([]);
  await caughtUp(observer);
  expect(getWorkspaceName(observer.instance.replicas.settings().doc)).toBe("Hub name");
  expect(witnessedNames).not.toContain("Refused live rename");
  expect(refusals(warn)).toHaveLength(1);
  expect(refusals(warn)[0]).toContain("workspace name, main repository, tag catalog");

  setTitle(rig.instance.replicas.replica(created.uuid).doc, "Member document edit");
  await caughtUp(rig);
  expect(hub.readRoom(docRoom, getMeta)?.title).toBe("Member document edit");
  expect(hub.authentications.filter(({ room }) => room === docRoom)).toHaveLength(documentAdmissions);
  expect(hub.renewalCount).toBe(0);
  expect(readHubLogins(env).logins[hub.origin]).toEqual(login);
  expect((await rig.ok("list_tags")).complete).toBe(true);
  expect(await rig.ok("sync_status")).toMatchObject({ unsyncedChanges: 0, inFlightUpdates: 0, pendingRooms: [] });

  hub.changeRole(WORKSPACE, "admin");
  setWorkspaceName(rig.instance.replicas.settings().doc, "Allowed after promotion");
  await caughtUp(rig);
  expect(hub.readRoom(settingsRoom(WORKSPACE), getWorkspaceName)).toBe("Allowed after promotion");
  expect(hub.readRoom(settingsRoom(WORKSPACE), getWorkspaceMainRepository)).toBe("hub/selected");
  expect(hub.readRoom(settingsRoom(WORKSPACE), listTagCatalog)?.map(tag => tag.name)).toEqual(["curated"]);
  expect(refusals(warn)).toHaveLength(1);
});

it("fences a stale local process when another process replaces refused settings", async () => {
  const { hub, config } = await fixture();
  hub.changeRole(WORKSPACE, "admin");
  const rig = await client(config);
  setWorkspaceName(rig.instance.replicas.settings().doc, "Hub name");
  await caughtUp(rig);
  const stale = openWorkspaceReplicas(config, { hubFree: true });
  localReplicas.push(stale);
  const staleDoc = stale.replicas.settings().doc;
  expect(getWorkspaceName(staleDoc)).toBe("Hub name");

  hub.changeRole(WORKSPACE, "member");
  setWorkspaceName(rig.instance.replicas.settings().doc, "Refused rename");
  await waitUntil("the active process to replace settings", () => rig.instance.store.settingsReset() !== null);
  await caughtUp(rig);
  setWorkspaceName(staleDoc, "A stale process must not restore refused history");
  await waitUntil("the stale process to adopt the replacement", () => getWorkspaceName(stale.replicas.settings().doc) === "Hub name");
  stale.replicas.assertHealthy();
  expect(stale.store.pendingRooms()).toEqual([]);
  expect(getWorkspaceName(rig.instance.replicas.settings().doc)).toBe("Hub name");

  hub.changeRole(WORKSPACE, "admin");
  setWorkspaceName(stale.replicas.settings().doc, "Fresh peer edit");
  await caughtUp(rig);
  expect(hub.readRoom(settingsRoom(WORKSPACE), getWorkspaceName)).toBe("Fresh peer edit");
  expect(hub.renewalCount).toBe(0);
});
