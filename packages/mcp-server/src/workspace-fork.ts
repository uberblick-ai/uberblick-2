import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import {
  canonicalDocumentUuid,
  DIRECTORY_SUFFIX,
  getMeta,
  listDeletedDirectoryUuids,
  listDirectory,
  parseWorkspaceId,
  roomForDoc,
  SETTINGS_SUFFIX,
  SIDEBAR_SUFFIX,
} from "@uberblick/schema";
import * as Y from "yjs";
import { MirrorStore } from "./store.js";

export interface WorkspaceForkSnapshot {
  rooms: readonly { id: string; state: Uint8Array }[];
  missing: readonly { uuid: string; title: string }[];
}

/** Read authoritative Yjs state without opening replicas or changing the source file. */
export function readWorkspaceFork(databasePath: string, workspaceId: string): WorkspaceForkSnapshot {
  const uuid = parseWorkspaceId(workspaceId).uuid;
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    // All roots and document tails must describe one cut, including during compaction.
    db.exec("BEGIN");
    const snapshot = readForkSnapshot(db, uuid);
    db.exec("COMMIT");
    return snapshot;
  } finally {
    try {
      if (db.isTransaction) db.exec("ROLLBACK");
    } finally {
      db.close();
    }
  }
}

function readForkSnapshot(db: DatabaseSync, workspaceId: string): WorkspaceForkSnapshot {
  const tables = new Set(db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all().map(row => row.name));
  const owner = tables.has("meta") ? db.prepare("SELECT value FROM meta WHERE key = 'workspace'").get() : undefined;
  if (owner !== undefined && owner.value !== workspaceId) {
    throw new Error("The source database belongs to a different workspace; unset UBERBLICK_DB to use the per-workspace replica.");
  }
  const snapshot = tables.has("snapshots")
    ? db.prepare("SELECT state, through_seq FROM snapshots WHERE room = ?") : null;
  const updates = tables.has("updates")
    ? db.prepare("SELECT payload FROM updates WHERE room = ? AND seq > ? ORDER BY seq") : null;
  const roomQueries = [];
  if (snapshot !== null) roomQueries.push("SELECT room FROM snapshots");
  if (updates !== null) roomQueries.push("SELECT room FROM updates");
  const prefix = `${workspaceId}/`;
  const held = new Set(roomQueries.length === 0 ? [] : db.prepare(roomQueries.join(" UNION ")).all()
    .map(row => row.room as string).filter(room => room.startsWith(prefix)).map(room => room.slice(prefix.length)));
  const rooms: { id: string; state: Uint8Array }[] = [];
  const missing: { uuid: string; title: string }[] = [];
  const read = (id: string): Y.Doc => {
    // Retain all stored Yjs history rather than collecting deleted structures while copying.
    const doc = new Y.Doc({ gc: false });
    try {
      const room = roomForDoc(workspaceId, id);
      const stored = snapshot?.get(room);
      if (stored !== undefined) Y.applyUpdate(doc, stored.state as Uint8Array);
      for (const update of updates?.all(room, stored?.through_seq ?? 0) ?? []) {
        Y.applyUpdate(doc, update.payload as Uint8Array);
      }
      return doc;
    } catch (error) {
      doc.destroy();
      throw error;
    }
  };
  const directory = read(DIRECTORY_SUFFIX);
  try {
    if (!held.has(DIRECTORY_SUFFIX)) missing.push({ uuid: DIRECTORY_SUFFIX, title: "Workspace directory" });
    rooms.push({ id: DIRECTORY_SUFFIX, state: Y.encodeStateAsUpdate(directory) });
    const deleted = new Set(listDeletedDirectoryUuids(directory));
    const listed = new Map(listDirectory(directory, { includeDeleted: true }).map(entry => [entry.uuid, entry]));
    const ids = new Set([...listed.keys(), ...[...held].filter(id => canonicalDocumentUuid(id) !== null)]);
    for (const id of ids) {
      if (deleted.has(id)) continue;
      const doc = read(id);
      try {
        const entry = listed.get(id);
        if (entry !== undefined && getMeta(doc).uuid === "") missing.push({ uuid: id, title: entry.title });
        rooms.push({ id, state: Y.encodeStateAsUpdate(doc) });
      } finally {
        doc.destroy();
      }
    }
  } finally {
    directory.destroy();
  }
  for (const id of [SETTINGS_SUFFIX, SIDEBAR_SUFFIX]) {
    const doc = read(id);
    try {
      rooms.push({ id, state: Y.encodeStateAsUpdate(doc) });
    } finally {
      doc.destroy();
    }
  }
  return { rooms, missing };
}

/** The caller holds the destination init lock and publishes its binding only after success. */
export function writeWorkspaceFork(databasePath: string, workspaceId: string, snapshot: WorkspaceForkSnapshot): void {
  if (snapshot.missing.length > 0) throw new Error("The source workspace has missing local content.");
  if (existsSync(databasePath)) throw new Error("The fork destination database already exists.");
  const uuid = parseWorkspaceId(workspaceId).uuid;
  const store = new MirrorStore(databasePath, uuid);
  try {
    for (const room of snapshot.rooms) store.appendUpdate(roomForDoc(uuid, room.id), room.state, "local");
  } finally {
    store.close();
  }
}
