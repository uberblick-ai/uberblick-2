import { constants, type DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import * as Y from "yjs";
import { createTagCatalogEntry, getWorkspaceName, listTagCatalog, setWorkspaceName, settingsRoom } from "@uberblick/schema";
import { MirrorStore, SettingsResetError } from "../src/store.js";
import { openWorkspaceReplicas, type WorkspaceReplicaSet } from "../src/workspace-replicas.js";
import { cleanupTestResources, testConfig, WORKSPACE } from "./helpers.js";

const stores: MirrorStore[] = [];
const workspaces: WorkspaceReplicaSet[] = [];
afterEach(async () => {
  await cleanupTestResources({
    clients: workspaces.splice(0).map(workspace => () => workspace.close()),
    after: stores.splice(0).map(store => () => store.close()),
  });
});

function named(name: string): Uint8Array {
  const doc = new Y.Doc();
  try {
    setWorkspaceName(doc, name);
    return Y.encodeStateAsUpdate(doc);
  } finally { doc.destroy(); }
}

function readName(store: MirrorStore): string | null {
  const doc = new Y.Doc();
  try {
    const slice = store.readSince(settingsRoom(WORKSPACE), 0);
    if (slice.snapshot !== null) Y.applyUpdate(doc, slice.snapshot.state);
    for (const update of slice.updates) Y.applyUpdate(doc, update.payload);
    return getWorkspaceName(doc);
  } finally { doc.destroy(); }
}

it("replaces refused history atomically, fences stale peers and preserves other rooms across restart", () => {
  const config = testConfig();
  const store = new MirrorStore(config.databasePath, WORKSPACE);
  stores.push(store);
  const room = settingsRoom(WORKSPACE);
  const otherRoom = `${WORKSPACE}/other`;
  const refused = named("Refused");
  const oldSeq = store.appendUpdate(room, refused, "local", 0);
  store.compact(room, refused, oldSeq);
  const otherSeq = store.appendUpdate(otherRoom, named("Document survives"), "local");
  store.replaceSettings(named("Hub settings"), "Workspace name refused", 0);
  const reset = store.settingsReset();
  expect(reset?.seq).toBeGreaterThan(otherSeq);
  expect(store.pendingRooms()).toEqual([{ room: otherRoom, seq: otherSeq }]);
  expect(() => store.appendUpdate(room, refused, "local", 0)).toThrow(SettingsResetError);
  expect(() => store.replaceSettings(refused, "Stale recovery", 0)).toThrow(SettingsResetError);
  store.compact(room, refused, oldSeq);
  expect(readName(store)).toBe("Hub settings");
  const reopened = new MirrorStore(config.databasePath, WORKSPACE);
  stores.push(reopened);
  expect(readName(reopened)).toBe("Hub settings");
  expect(reopened.settingsReset()).toEqual(reset);
  expect(reopened.pendingRooms()).toEqual([{ room: otherRoom, seq: otherSeq }]);
});

it("rebuilds already-open peer replicas with fresh clocks instead of merging refused updates back", () => {
  const config = testConfig();
  const first = openWorkspaceReplicas(config, { hubFree: true });
  const peer = openWorkspaceReplicas(config, { hubFree: true });
  workspaces.push(first, peer);
  const old = peer.replicas.settings();
  setWorkspaceName(old.doc, "Offline refused");
  first.store.replaceSettings(named("Authoritative"), "Workspace name refused");
  // A tab or process can retain the old object until its next refresh.
  setWorkspaceName(old.doc, "Old client clock must not return");
  peer.replicas.refresh();
  const current = peer.replicas.settings();
  expect(current.doc).not.toBe(old.doc);
  expect(current.doc.clientID).not.toBe(old.doc.clientID);
  expect(getWorkspaceName(current.doc)).toBe("Authoritative");
  expect(peer.store.pendingRooms()).toEqual([]);
  expect(peer.replicas.persistenceError()).toBeNull();
  setWorkspaceName(current.doc, "A later legitimate edit");
  first.replicas.refresh();
  expect(getWorkspaceName(first.replicas.settings().doc)).toBe("A later legitimate edit");
});

it("rolls back replacement if its generation marker cannot be committed", () => {
  const config = testConfig();
  const store = new MirrorStore(config.databasePath, WORKSPACE);
  stores.push(store);
  const room = settingsRoom(WORKSPACE);
  const seq = store.appendUpdate(room, named("Original offline edit"), "local");
  const db = (store as unknown as { db: DatabaseSync }).db;
  db.setAuthorizer((action, table) => action === constants.SQLITE_INSERT && table === "meta"
    ? constants.SQLITE_DENY : constants.SQLITE_OK);
  try {
    expect(() => store.replaceSettings(named("Hub"), "Refused")).toThrow();
  } finally { db.setAuthorizer(null); }
  expect(readName(store)).toBe("Original offline edit");
  expect(store.pendingRooms()).toEqual([{ room, seq }]);
  expect(store.settingsReset()).toBeNull();
});

it("checks the settings generation on post-wait replay and compaction before refused history can become durable again", () => {
  const config = { ...testConfig(), compactAfter: 1 };
  const first = openWorkspaceReplicas(config, { hubFree: true });
  const peer = openWorkspaceReplicas(config, { hubFree: true });
  workspaces.push(first, peer);
  const room = settingsRoom(WORKSPACE);
  const stale = peer.replicas.settings();
  createTagCatalogEntry(stale.doc, "refused");
  const refusedState = Y.encodeStateAsUpdate(stale.doc);
  first.store.replaceSettings(named("Hub settings"), "Tag catalog refused");
  setWorkspaceName(first.replicas.settings().doc, "Later legitimate edit");
  const followingSeq = first.store.readSince(room, 0).updates.at(-1)!.seq;
  // The peer may resume a settle after its wait while another process has
  // replaced settings and appended a later valid update. The returned slice
  // itself must prevent merging either update into the refused generation.
  const postWait = peer.replicas as unknown as { pollAll(): void; compactLargeLogs(): void };
  postWait.pollAll();
  const rebuilt = peer.replicas.settings();
  expect(rebuilt.doc).not.toBe(stale.doc);
  expect(getWorkspaceName(rebuilt.doc)).toBe("Later legitimate edit");
  expect(listTagCatalog(rebuilt.doc)).toEqual([]);
  // Even an obsolete peer carrying a newer cut cannot replace the snapshot
  // or prune the valid tail from a previous settings generation.
  expect(() => peer.store.compact(room, refusedState, followingSeq, stale.settingsResetSeq))
    .toThrow(SettingsResetError);
  expect(readName(first.store)).toBe("Later legitimate edit");
  postWait.compactLargeLogs();
  const reopened = new MirrorStore(config.databasePath, WORKSPACE);
  stores.push(reopened);
  const restored = new Y.Doc();
  try {
    const slice = reopened.readSince(room, 0);
    if (slice.snapshot !== null) Y.applyUpdate(restored, slice.snapshot.state);
    for (const update of slice.updates) Y.applyUpdate(restored, update.payload);
    expect(getWorkspaceName(restored)).toBe("Later legitimate edit");
    expect(listTagCatalog(restored)).toEqual([]);
  } finally { restored.destroy(); }
});
