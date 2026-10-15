/**
 * Persist one SQLite row of full Yjs v1 state per document; this is not the local
 * replica's append-only log and needs no pruning. Keep the extension-sqlite
 * table, queries and bytes compatible so its databases open unchanged.
 * A small node:sqlite adapter avoids a native addon and owns pre-bind database
 * opening and store-failure propagation. Hub-internal tables share its one handle.
 */

import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import type {
  Extension,
  onLoadDocumentPayload,
  onStoreDocumentPayload,
} from "@hocuspocus/server";
import * as Y from "yjs";
import {
  deleteDirectoryEntry,
  enforceDeletedDirectoryEntries,
  isDirectoryEntryDeleted,
  listDeletedDirectoryUuids,
  parseRoom,
  roomForDoc,
} from "@uberblick/schema";
import { DOC_DELETED_REASON } from "@uberblick/schema/protocol";

/**
 * Retain the exact extension schema and unique index; SQLite does not enforce
 * varchar(255). IF NOT EXISTS leaves existing databases intact.
 */
const SCHEMA = `CREATE TABLE IF NOT EXISTS "documents" (
  "name" varchar(255) NOT NULL,
  "data" blob NOT NULL,
  UNIQUE(name)
)`;

/** Keep these queries compatible with extension-written databases. */
const SELECT_DOCUMENT = `
  SELECT data FROM "documents" WHERE name = $name ORDER BY rowid DESC
`;

const UPSERT_DOCUMENT = `
  INSERT INTO "documents" ("name", "data") VALUES ($name, $data)
    ON CONFLICT(name) DO UPDATE SET data = $data
`;

/**
 * Wait through brief external locks rather than make a transient conflict a
 * sticky store failure that every later flush and shutdown reports as not durable.
 */
const BUSY_TIMEOUT_MS = 5_000;

/** afterTransaction runs before GC; persist no deleted directory metadata. */
function directoryState(document: Y.Doc): Uint8Array {
  const compacted = new Y.Doc();
  try {
    Y.applyUpdate(compacted, Y.encodeStateAsUpdate(document));
    return Y.encodeStateAsUpdate(compacted);
  } finally {
    compacted.destroy();
  }
}

/** Anonymous SQLite databases need no directory and do not survive close. */
export function isEphemeralDatabase(databasePath: string): boolean {
  return databasePath === ":memory:" || databasePath === "";
}

/**
 * createHub must call open before binding: Hocuspocus does not await onConfigure
 * from its constructor, so database setup there cannot gate successful startup.
 */
export class HubDatabase implements Extension {
  readonly databasePath: string;

  private readonly onStoreFailed: (error: unknown) => void;

  private db: DatabaseSync | undefined;

  private readonly deletedRooms = new Set<string>();
  private readonly pendingDeletedRooms = new Set<string>();
  private readonly reconcilingDirectories = new WeakSet<Y.Doc>();
  private deletionHandler: (rooms: readonly string[]) => void = () => {};

  private statements:
    | { select: StatementSync; upsert: StatementSync }
    | undefined;

  constructor(databasePath: string, onStoreFailed: (error: unknown) => void) {
    this.databasePath = databasePath;
    this.onStoreFailed = onStoreFailed;
  }

  /**
   * Synchronous pre-bind setup; a path that cannot open leaves no handle. A
   * read-only file may still open and fail later through the sticky store path.
   */
  open(): void {
    if (this.db !== undefined) {
      throw new Error("HubDatabase.open: already open");
    }
    // The first writer must create private directories; later mkdir modes cannot tighten them.
    const durable = !isEphemeralDatabase(this.databasePath);
    const fresh = durable && !existsSync(this.databasePath);
    if (durable) {
      mkdirSync(dirname(this.databasePath), { recursive: true, mode: 0o700 });
    }

    const db = new DatabaseSync(this.databasePath, {
      timeout: BUSY_TIMEOUT_MS,
    });
    // Tighten only new databases, before schema writes so journal/WAL files
    // inherit private permissions. Preserve the owner's mode on existing files.
    if (fresh) {
      chmodSync(this.databasePath, 0o600);
    }
    try {
      db.exec(SCHEMA);
      this.statements = {
        select: db.prepare(SELECT_DOCUMENT),
        upsert: db.prepare(UPSERT_DOCUMENT),
      };
    } catch (error) {
      db.close();
      throw error;
    }
    this.db = db;
    try {
      // Positive marks must fence admission even when nobody opens the directory.
      for (const row of db.prepare('SELECT name, data FROM documents WHERE name GLOB ?').all("*/_directory")) {
        if (typeof row.name !== "string" || !(row.data instanceof Uint8Array)) continue;
        const directory = new Y.Doc();
        try {
          Y.applyUpdate(directory, row.data);
          this.reconcileDirectory(row.name, directory);
        } finally {
          directory.destroy();
        }
      }
    } catch (error) {
      this.close();
      throw error;
    }
  }

  onDeleteRooms(handler: (rooms: readonly string[]) => void): void {
    this.deletionHandler = handler;
  }

  isDeletedRoom(room: string): boolean {
    return this.deletedRooms.has(room);
  }

  requireRoom(room: string): void {
    if (this.isDeletedRoom(room)) throw { reason: DOC_DELETED_REASON };
  }

  /** Hub-internal only: sharing this handle avoids competing connections to the same file. */
  get connection(): DatabaseSync {
    if (this.db === undefined) {
      throw new Error("HubDatabase.connection: the database is not open");
    }
    return this.db;
  }

  async onLoadDocument({
    document,
    documentName,
  }: onLoadDocumentPayload): Promise<void> {
    this.requireRoom(documentName);
    const row = this.prepared().select.get({ name: documentName });
    const data = row?.data;
    if (data instanceof Uint8Array) {
      Y.applyUpdate(document, data);
    }
    if (parseRoom(documentName).isDirectory) {
      this.reconcileDirectory(documentName, document);
      // This runs synchronously, before an update can be acknowledged. A
      // debounced directory store could otherwise lose its deletion evidence.
      document.on("afterTransaction", (transaction: Y.Transaction) => {
        if (transaction.changed.size === 0) return;
        try {
          this.reconcileDirectory(documentName, document);
        } catch (error) {
          this.onStoreFailed(error);
          throw error;
        }
      });
    }
  }

  async onStoreDocument({
    document,
    documentName,
  }: onStoreDocumentPayload): Promise<void> {
    try {
      // Queued stores retain their old document object after the room is closed.
      if (this.isDeletedRoom(documentName)) return;
      if (parseRoom(documentName).isDirectory) this.reconcileDirectory(documentName, document);
      this.prepared().upsert.run({
        name: documentName,
        data: Y.encodeStateAsUpdate(document),
      });
    } catch (error) {
      // Hocuspocus catches and resolves store-hook failures; report before it
      // swallows this exception so flush/shutdown cannot falsely claim durability.
      this.onStoreFailed(error);
      throw error;
    }
  }

  /** Idempotent shutdown; discard the handle so connection cannot return a closed database. */
  close(): void {
    if (this.db?.isOpen === true) {
      this.db.close();
    }
    this.db = undefined;
    this.statements = undefined;
    this.deletedRooms.clear();
    this.pendingDeletedRooms.clear();
  }

  private reconcileDirectory(room: string, directory: Y.Doc): void {
    if (this.reconcilingDirectories.has(directory)) return;
    this.reconcilingDirectories.add(directory);
    try {
      const { workspaceId, isDirectory } = parseRoom(room);
      if (!isDirectory) return;
      // Never forget a mark because a later writer changed the directory.
      for (const deletedRoom of this.deletedRooms) {
        const parsed = parseRoom(deletedRoom);
        if (parsed.workspaceId === workspaceId && !isDirectoryEntryDeleted(directory, parsed.uuid)) {
          deleteDirectoryEntry(directory, parsed.uuid);
        }
      }
      const deleted = listDeletedDirectoryUuids(directory).map(uuid => roomForDoc(workspaceId, uuid));
      if (deleted.length === 0) return;
      enforceDeletedDirectoryEntries(directory);
      const newlyDeleted = deleted.filter(name => !this.deletedRooms.has(name));
      // Retain the fence even if storage fails; the sticky failure forbids a
      // durability claim, and active clients still cannot republish the room.
      for (const name of deleted) this.deletedRooms.add(name);
      for (const name of newlyDeleted) this.pendingDeletedRooms.add(name);
      this.deletionHandler(newlyDeleted);
      // Ordinary directory writes use the debounced store. A failed mark must
      // still retry synchronously even though its room is already fenced.
      if (!deleted.some(name => this.pendingDeletedRooms.has(name))) return;
      const database = this.connection;
      database.exec("BEGIN IMMEDIATE");
      try {
        this.prepared().upsert.run({ name: room, data: directoryState(directory) });
        const remove = database.prepare('DELETE FROM documents WHERE name = ?');
        for (const name of deleted) remove.run(name);
        database.exec("COMMIT");
        for (const name of deleted) this.pendingDeletedRooms.delete(name);
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    } finally {
      this.reconcilingDirectories.delete(directory);
    }
  }

  private prepared(): { select: StatementSync; upsert: StatementSync } {
    if (this.statements === undefined) {
      throw new Error("HubDatabase: the database is not open");
    }
    return this.statements;
  }
}
