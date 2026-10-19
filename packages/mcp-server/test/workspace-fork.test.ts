import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import {
  appendBlock,
  deleteDirectoryEntry,
  DIRECTORY_SUFFIX,
  getMeta,
  getWorkspaceName,
  initDoc,
  listDeletedDirectoryUuids,
  listDirectory,
  roomForDoc,
  setWorkspaceMainRepository,
  setWorkspaceName,
  SETTINGS_SUFFIX,
  SIDEBAR_SUFFIX,
  tombstoneDirectoryEntry,
  upsertDirectoryEntry,
} from "@uberblick/schema";
import { afterEach, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { MirrorStore } from "../src/store.js";
import { readWorkspaceFork, writeWorkspaceFork } from "../src/workspace-fork.js";
import type { WorkspaceForkSnapshot } from "../src/workspace-fork.js";
import { removeTempDirs, tempDatabasePath, WORKSPACE } from "./shared.js";

const FORK = "42eb5ee1-3987-4a6e-831d-82306231f594";
const LIVE = "d4a130a0-9f2d-418a-abfa-393a5b730548";
const ARCHIVED = "ea636c11-59e6-42a0-acda-28c06b021a17";
const DELETED = "1f9b2de7-0810-468b-9a42-cf7569c22972";
const ORPHAN = "a1e8b9ec-c738-43f0-b9d1-2665f9a77039";
const stores: MirrorStore[] = [];
const documents: Y.Doc[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const store of stores.splice(0)) store.close();
  for (const doc of documents.splice(0)) doc.destroy();
  removeTempDirs();
});

function doc(): Y.Doc {
  const created = new Y.Doc({ gc: false });
  documents.push(created);
  return created;
}

function source(): { path: string; store: MirrorStore; directory: Y.Doc; settings: Y.Doc } {
  const path = tempDatabasePath();
  const store = new MirrorStore(path, WORKSPACE);
  stores.push(store);
  const directory = doc();
  // An empty directory can still have durable state.
  directory.getMap("docs").set(LIVE, { title: "Live", tags: [] });
  const settings = doc();
  setWorkspaceName(settings, "Source");
  setWorkspaceMainRepository(settings, "acme/notes");
  return { path, store, directory, settings };
}

function persist(store: MirrorStore, id: string, state: Y.Doc): void {
  const room = roomForDoc(WORKSPACE, id);
  const bytes = Y.encodeStateAsUpdate(state);
  const seq = store.appendUpdate(room, bytes, "remote");
  store.compact(room, bytes, seq);
}

function state(snapshot: WorkspaceForkSnapshot, id: string): Y.Doc {
  const found = snapshot.rooms.find(room => room.id === id);
  expect(found).toBeDefined();
  const loaded = doc();
  Y.applyUpdate(loaded, found!.state);
  return loaded;
}

function authoritativeState(path: string): unknown {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return {
      meta: db.prepare("SELECT * FROM meta ORDER BY key").all(),
      updates: db.prepare("SELECT * FROM updates ORDER BY seq").all(),
      snapshots: db.prepare("SELECT * FROM snapshots ORDER BY room").all(),
      pending: db.prepare("SELECT * FROM pending_rooms ORDER BY room").all(),
    };
  } finally {
    db.close();
  }
}

it("copies snapshot tails, archived content and workspace roots without touching an open source", () => {
  const { path, store, directory, settings } = source();
  upsertDirectoryEntry(directory, { uuid: ARCHIVED, title: "Archived", tags: [] });
  tombstoneDirectoryEntry(directory, ARCHIVED);
  upsertDirectoryEntry(directory, { uuid: DELETED, title: "Deleted", tags: [] });
  deleteDirectoryEntry(directory, DELETED);
  persist(store, DIRECTORY_SUFFIX, directory);
  persist(store, SETTINGS_SUFFIX, settings);
  const sidebar = doc();
  sidebar.getArray("order").push(["pinned-group"]);
  sidebar.getMap("groups").set("pinned-group", "Pinned");
  sidebar.getArray("pins:pinned-group").push([{ uuid: LIVE, since: 0 }]);
  persist(store, SIDEBAR_SUFFIX, sidebar);
  for (const id of [LIVE, ARCHIVED, DELETED, ORPHAN]) {
    const note = doc();
    initDoc(note, { uuid: id, title: id, description: "Content and annotations" });
    appendBlock(note, { type: "paragraph", text: "Before" });
    persist(store, id, note);
    const vector = Y.encodeStateVector(note);
    appendBlock(note, { type: "paragraph", text: `Local change with link ${LIVE}` });
    note.getMap("annotations").set("thread", { body: "Unacknowledged comment", resolved: false });
    note.getMap("data").set("records", [{ id: "one", value: 42 }]);
    store.appendUpdate(roomForDoc(WORKSPACE, id), Y.encodeStateAsUpdate(note, vector), "local");
  }
  const db = new DatabaseSync(path);
  try {
    db.exec("INSERT INTO meta (key, value) VALUES ('last_sync_at', '1700000000000'), ('settings_reset', '7'), ('settings_reset_notice_seq', '7'), ('serving_holder', 'source-holder')");
  } finally {
    db.close();
  }
  const before = authoritativeState(path);
  const snapshot = readWorkspaceFork(path, `source-${WORKSPACE}`);
  expect(getWorkspaceName(state(snapshot, SETTINGS_SUFFIX))).toBe("Source");
  expect(snapshot.missing).toEqual([]);
  expect(snapshot.rooms.map(room => room.id).sort()).toEqual([DIRECTORY_SUFFIX, SETTINGS_SUFFIX, SIDEBAR_SUFFIX, LIVE, ARCHIVED, ORPHAN].sort());
  expect(listDirectory(state(snapshot, DIRECTORY_SUFFIX), { includeDeleted: true }).find(entry => entry.uuid === ARCHIVED)?.deleted).toBe(true);
  expect(listDeletedDirectoryUuids(state(snapshot, DIRECTORY_SUFFIX))).toEqual([DELETED]);
  expect(getMeta(state(snapshot, ARCHIVED)).uuid).toBe(ARCHIVED);
  expect(state(snapshot, LIVE).getMap("annotations").get("thread")).toEqual({ body: "Unacknowledged comment", resolved: false });
  const destination = tempDatabasePath();
  writeWorkspaceFork(destination, FORK, snapshot);
  const copied = readWorkspaceFork(destination, FORK);
  expect(copied).toEqual(snapshot);
  expect(authoritativeState(path)).toEqual(before);
  const fork = new DatabaseSync(destination, { readOnly: true });
  try {
    expect(fork.prepare("SELECT * FROM meta").all()).toEqual([{ key: "workspace", value: FORK }]);
    expect(fork.prepare("SELECT room FROM pending_rooms ORDER BY room").all()).toEqual(snapshot.rooms.map(room => ({ room: roomForDoc(FORK, room.id) })).sort((a, b) => a.room.localeCompare(b.room)));
    expect(fork.prepare("SELECT * FROM doc_index").all()).toEqual([]);
  } finally {
    fork.close();
  }
});

it("samples all rooms before a concurrent writer appends and compacts source changes", () => {
  const { path, store, directory, settings } = source();
  const note = doc();
  initDoc(note, { uuid: LIVE, title: "Before" });
  persist(store, DIRECTORY_SUFFIX, directory);
  persist(store, SETTINGS_SUFFIX, settings);
  persist(store, LIVE, note);
  const original = DatabaseSync.prototype.prepare;
  let interleaved = false;
  vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function(this: DatabaseSync, sql: string) {
    const prepared = original.call(this, sql);
    if (!interleaved && sql === "SELECT state, through_seq FROM snapshots WHERE room = ?") {
      interleaved = true;
      setWorkspaceName(settings, "After");
      initDoc(note, { uuid: LIVE, title: "After" });
      persist(store, SETTINGS_SUFFIX, settings);
      persist(store, LIVE, note);
    }
    return prepared;
  });
  const snapshot = readWorkspaceFork(path, WORKSPACE);
  expect(interleaved).toBe(true);
  expect(getWorkspaceName(state(snapshot, SETTINGS_SUFFIX))).toBe("Source");
  expect(getMeta(state(snapshot, LIVE)).title).toBe("Before");
  const after = readWorkspaceFork(path, WORKSPACE);
  expect(getWorkspaceName(state(after, SETTINGS_SUFFIX))).toBe("After");
  expect(getMeta(state(after, LIVE)).title).toBe("After");
});

it("reports every unhydrated live or archived document and refuses before destination creation", () => {
  const { path, store, directory } = source();
  upsertDirectoryEntry(directory, { uuid: ARCHIVED, title: "Archived", tags: [] });
  tombstoneDirectoryEntry(directory, ARCHIVED);
  upsertDirectoryEntry(directory, { uuid: DELETED, title: "Deleted", tags: [] });
  deleteDirectoryEntry(directory, DELETED);
  persist(store, DIRECTORY_SUFFIX, directory);
  const shell = doc();
  appendBlock(shell, { type: "paragraph", text: "A room name is not hydration" });
  persist(store, ARCHIVED, shell);
  const snapshot = readWorkspaceFork(path, WORKSPACE);
  expect(snapshot.missing).toEqual([{ uuid: ARCHIVED, title: "Archived" }, { uuid: LIVE, title: "Live" }]);
  const destination = tempDatabasePath();
  expect(() => writeWorkspaceFork(destination, FORK, snapshot)).toThrow("missing local content");
  expect(existsSync(destination)).toBe(false);
});

it("does not treat an absent directory or an absent database as a complete empty workspace", () => {
  const { path } = source();
  expect(readWorkspaceFork(path, WORKSPACE).missing).toEqual([{ uuid: DIRECTORY_SUFFIX, title: "Workspace directory" }]);
  const absent = tempDatabasePath();
  expect(() => readWorkspaceFork(absent, WORKSPACE)).toThrow();
  expect(existsSync(absent)).toBe(false);
});

it("refuses a foreign source claim and a pre-existing destination without changing either", () => {
  const { path } = source();
  const before = authoritativeState(path);
  expect(() => readWorkspaceFork(path, FORK)).toThrow("different workspace");
  expect(() => writeWorkspaceFork(path, FORK, { rooms: [], missing: [] })).toThrow("already exists");
  expect(authoritativeState(path)).toEqual(before);
});
