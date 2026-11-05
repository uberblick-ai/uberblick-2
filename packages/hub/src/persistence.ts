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
  DIRECTORY_DELETED_KEY,
  DIRECTORY_DELETED_DECISION_TOPICS_KEY,
  DIRECTORY_DOCS_KEY,
  canonicalDocumentUuid,
  enforceDeletedDirectoryEntries,
  isDirectoryEntryArchived,
  isCanonicalRoom,
  listDeletedDirectoryUuids,
  parseRoom,
  roomForDoc,
} from "@uberblick/schema";
import { DOC_DELETED_REASON } from "@uberblick/schema/protocol";
import { addCredentialCeiling, revokeHmacCredentials } from "./credentials-schema.js";
import { writeDatabaseRelease } from "./database-release.js";
import { DocumentClassifications } from "./document-classification.js";
import type { HubLogger } from "./log.js";
import { HubRevisions } from "./revisions.js";
import type { RestoreRevisionResult } from "./revisions.js";
import type { UpdateAuthor } from "./update-attribution.js";

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

function isArchivedEntry(entry: unknown): boolean {
  return typeof entry === "object" && entry !== null && (entry as { deleted?: unknown }).deleted === true;
}

function entryDecisionTopic(entry: unknown, uuid: string): string | undefined {
  if (typeof entry !== "object" || entry === null) return undefined;
  const candidate = entry as { kind?: unknown; topic?: unknown };
  if (candidate.kind !== "decision") return undefined;
  return typeof candidate.topic === "string" ? candidate.topic : uuid;
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
  private revisionStore: HubRevisions | undefined;
  private classifications: DocumentClassifications | undefined;

  private readonly deletedRooms = new Set<string>();
  private readonly pendingDeletedRooms = new Set<string>();
  private readonly reconcilingDirectories = new WeakSet<Y.Doc>();
  private readonly directories = new Map<string, Y.Doc>();
  private deletionHandler: (rooms: readonly string[]) => void = () => {};
  private loadedRoom: (room: string) => boolean = () => false;

  private statements:
    | { select: StatementSync; upsert: StatementSync }
    | undefined;

  constructor(
    databasePath: string,
    onStoreFailed: (error: unknown) => void,
    private readonly options: { revisions?: boolean; now?: () => number; log?: HubLogger } = {},
  ) {
    this.databasePath = databasePath;
    this.onStoreFailed = onStoreFailed;
  }

  /**
   * Synchronous pre-bind setup; a path that cannot open leaves no handle. A
   * read-only file may still open and fail later through the sticky store path.
   */
  open(hubVersion?: string): void {
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
      if (hubVersion !== undefined && durable) writeDatabaseRelease(db, hubVersion);
      db.exec(SCHEMA);
      revokeHmacCredentials(db);
      addCredentialCeiling(db);
      this.statements = {
        select: db.prepare(SELECT_DOCUMENT),
        upsert: db.prepare(UPSERT_DOCUMENT),
      };
      this.revisionStore = new HubRevisions(db, this.options.revisions ?? false,
        room => this.isDeletedRoom(room), this.onStoreFailed, this.options.now, this.options.log);
      this.classifications = new DocumentClassifications(db);
    } catch (error) {
      db.close();
      throw error;
    }
    this.db = db;
    try {
      // At upgrade, prefer room metadata, then directory stubs, then other room
      // content. Seed everything before considering any persisted deletion mark.
      db.exec("BEGIN IMMEDIATE");
      try {
        for (const phase of ["metadata", "directory", "content"]) {
          for (const row of db.prepare("SELECT name, data FROM documents").iterate()) {
            if (typeof row.name !== "string" || !isCanonicalRoom(row.name) || !(row.data instanceof Uint8Array)) continue;
            const isDirectory = parseRoom(row.name).isDirectory;
            if (isDirectory !== (phase === "directory")) continue;
            if (!isDirectory && this.classifications.rooms.has(row.name)) continue;
            const document = new Y.Doc();
            try {
              // A corrupt ordinary room is refused when loaded; it must not keep
              // healthy rooms from starting or receiving upgrade protection.
              try { Y.applyUpdate(document, row.data); } catch { continue; }
              if (isDirectory) this.classifyDirectory(row.name, document);
              else this.classifications.observeRoom(row.name, document, phase === "metadata");
            } finally { document.destroy(); }
          }
        }
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      // Positive marks must fence admission even when nobody opens the directory.
      for (const row of db.prepare('SELECT name, data FROM documents WHERE name GLOB ?').all("*/_directory")) {
        if (typeof row.name !== "string" || !(row.data instanceof Uint8Array)) continue;
        const directory = new Y.Doc();
        try {
          Y.applyUpdate(directory, row.data);
          this.fenceStoredDeletions(row.name, directory);
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

  /** A loaded room may have no stored row until its debounced store runs. */
  onLoadedRoom(predicate: (room: string) => boolean): void {
    this.loadedRoom = predicate;
  }

  isDeletedRoom(room: string): boolean {
    return this.deletedRooms.has(room);
  }

  /** Loaded directory state takes precedence over its debounced persisted copy. */
  isArchivedRoom(room: string): boolean {
    const { workspaceId, uuid } = parseRoom(room);
    const name = roomForDoc(workspaceId, "_directory");
    const loaded = this.directories.get(name);
    if (loaded !== undefined) return isDirectoryEntryArchived(loaded, uuid);
    const data = this.prepared().select.get({ name })?.data;
    if (!(data instanceof Uint8Array)) return false;
    const directory = new Y.Doc();
    try {
      Y.applyUpdate(directory, data);
      return isDirectoryEntryArchived(directory, uuid);
    } finally { directory.destroy(); }
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

  get revisions(): HubRevisions {
    if (this.revisionStore === undefined) throw new Error("HubDatabase.revisions: the database is not open");
    return this.revisionStore;
  }

  private get documentClassifications(): DocumentClassifications {
    if (this.classifications === undefined) throw new Error("HubDatabase: the database is not open");
    return this.classifications;
  }

  restoreRevision(room: string, document: Y.Doc, checksum: string, id: string, author: UpdateAuthor): RestoreRevisionResult {
    return this.revisions.restore(room, document, checksum, id, author, state => {
      this.prepared().upsert.run({ name: room, data: state });
    });
  }

  async onLoadDocument({
    document,
    documentName,
  }: Pick<onLoadDocumentPayload, "document" | "documentName">): Promise<void> {
    this.requireRoom(documentName);
    if (parseRoom(documentName).isDirectory) {
      // A type first created by a remote update is replaced on its first getMap,
      // leaving that transaction's change records keyed by the discarded type.
      document.getMap(DIRECTORY_DOCS_KEY);
      document.getMap(DIRECTORY_DELETED_KEY);
      document.getMap(DIRECTORY_DELETED_DECISION_TOPICS_KEY);
    }
    const row = this.prepared().select.get({ name: documentName });
    const data = row?.data;
    if (data instanceof Uint8Array) {
      Y.applyUpdate(document, data);
    }
    if (parseRoom(documentName).isDirectory) {
      this.directories.set(documentName, document);
      document.on("destroy", () => {
        if (this.directories.get(documentName) === document) this.directories.delete(documentName);
      });
      this.reconcileDirectory(documentName, document);
      // This runs synchronously, before an update can be acknowledged. A
      // debounced directory store could otherwise lose its deletion evidence.
      document.on("afterTransaction", (transaction: Y.Transaction) => {
        if (transaction.changed.size === 0) return;
        try {
          this.reconcileDirectory(documentName, document, transaction);
        } catch (error) {
          this.onStoreFailed(error);
          throw error;
        }
      });
      this.revisions.observeDirectory(documentName, document);
    } else if (canonicalDocumentUuid(parseRoom(documentName).uuid) !== null) {
      if (this.documentClassifications.observeRoom(documentName, document)) this.reconcileRoomTopic(documentName);
      this.requireRoom(documentName);
      document.on("afterTransaction", (transaction: Y.Transaction) => {
        if (transaction.changed.size === 0) return;
        try {
          if (this.documentClassifications.observeRoom(documentName, document)) this.reconcileRoomTopic(documentName);
        } catch (error) {
          this.onStoreFailed(error);
          throw error;
        }
      });
      this.revisions.observe(documentName, document);
    }
  }

  async onStoreDocument({
    document,
    documentName,
  }: Pick<onStoreDocumentPayload, "document" | "documentName">): Promise<void> {
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
    this.revisionStore = undefined;
    this.classifications = undefined;
    this.deletedRooms.clear();
    this.pendingDeletedRooms.clear();
    this.directories.clear();
  }

  private fenceStoredDeletions(room: string, directory: Y.Doc): void {
    const { workspaceId } = parseRoom(room);
    // Stored UUID marks were already accepted. Fence them and retry any
    // unfinished purge before considering writer-controlled membership.
    for (const [uuid, value] of directory.getMap(DIRECTORY_DELETED_KEY)) {
      if (value !== true || canonicalDocumentUuid(uuid) === null) continue;
      const name = roomForDoc(workspaceId, uuid);
      this.deletedRooms.add(name);
      this.pendingDeletedRooms.add(name);
    }
  }

  private classifyDirectory(room: string, directory: Y.Doc, transaction?: Y.Transaction): void {
    const { workspaceId } = parseRoom(room);
    const docs = directory.getMap<unknown>(DIRECTORY_DOCS_KEY);
    const changes = transaction === undefined ? undefined : [...transaction.changedParentTypes]
      .find(([type]) => (type as unknown) === docs)?.[1].find(event => event.target === docs)?.changes.keys;
    for (const [uuid, change] of changes ?? []) {
      if (canonicalDocumentUuid(uuid) !== null) this.documentClassifications.observeEntry(roomForDoc(workspaceId, uuid), change.oldValue);
    }
    const entries = transaction === undefined ? docs : [...(changes?.keys() ?? [])].map(uuid => [uuid, docs.get(uuid)] as const);
    for (const [uuid, entry] of entries) {
      if (canonicalDocumentUuid(uuid) !== null) this.documentClassifications.observeEntry(roomForDoc(workspaceId, uuid), entry);
    }
  }

  private reconcileRoomTopic(room: string): void {
    const { workspaceId } = parseRoom(room);
    const topic = this.documentClassifications.rooms.get(room)?.topic;
    if (topic === undefined || topic === null) return;
    const topicRoom = roomForDoc(workspaceId, topic);
    if (!this.documentClassifications.rooms.get(topicRoom)?.deleted && !this.deletedRooms.has(topicRoom)) return;
    const name = roomForDoc(workspaceId, "_directory");
    const loaded = this.directories.get(name);
    if (loaded !== undefined) {
      this.reconcileDirectory(name, loaded);
      return;
    }
    const directory = new Y.Doc();
    try {
      const data = this.prepared().select.get({ name })?.data;
      if (data instanceof Uint8Array) Y.applyUpdate(directory, data);
      this.reconcileDirectory(name, directory);
    } finally { directory.destroy(); }
  }

  /** Authorize from hub identity, before expanding or purging directory marks. */
  private refuseUnauthorizedDeletions(room: string, directory: Y.Doc, authorizedTopics: Set<string>, transaction?: Y.Transaction): boolean {
    const marks = directory.getMap<unknown>(DIRECTORY_DELETED_KEY);
    const { workspaceId } = parseRoom(room);
    const purgeable = new Set(listDeletedDirectoryUuids(directory));
    const docs = directory.getMap<unknown>(DIRECTORY_DOCS_KEY);
    const topics = directory.getMap<unknown>(DIRECTORY_DELETED_DECISION_TOPICS_KEY);
    const entryChanges = transaction === undefined ? undefined : [...transaction.changedParentTypes]
      .find(([type]) => (type as unknown) === docs)?.[1].find(event => event.target === docs)?.changes.keys;
    const classifications = this.documentClassifications;
    const workspaceClassifications = classifications.forWorkspace(workspaceId);
    const referencedTopics = new Set([...workspaceClassifications]
      .flatMap(([, classification]) => classification.topic === null ? [] : [classification.topic]));
    const refused: Array<{ uuid: string; before: unknown }> = [];
    const archivedBeforeOrNow = (uuid: string): boolean => {
      const change = entryChanges?.get(uuid);
      return isArchivedEntry(change === undefined ? docs.get(uuid) : change.oldValue) || isArchivedEntry(docs.get(uuid));
    };
    const authorizedTopicMark = (topic: string): boolean => {
      if (marks.get(topic) !== true) return false;
      const topicRoom = roomForDoc(workspaceId, topic);
      const classification = classifications.rooms.get(topicRoom);
      if (classification === undefined) return this.deletedRooms.has(topicRoom) || (!referencedTopics.has(topic) && !this.holdsRoom(topicRoom));
      return classification.topic === topic &&
        (classification.deleted || this.deletedRooms.has(topicRoom) || archivedBeforeOrNow(topic));
    };
    for (const [uuid, classification] of workspaceClassifications) {
      const name = roomForDoc(workspaceId, uuid);
      if (classification.topic === null) continue;
      if (authorizedTopicMark(classification.topic)) {
        authorizedTopics.add(classification.topic);
        purgeable.add(uuid);
      } else if (marks.get(classification.topic) === true && !this.deletedRooms.has(name)) {
        // An unheld topic mark must not become authority for a held record.
        purgeable.add(classification.topic);
      }
    }
    // Offline deletions and pre-upgrade purges may leave only UUIDs and their
    // saved topic links. Preserve that evidence without authorizing held records.
    for (const [uuid, topic] of topics) {
      const classification = workspaceClassifications.get(uuid);
      if (classification !== undefined && classification.topic !== topic) continue;
      if (purgeable.has(uuid) && uuid !== topic && typeof topic === "string" && canonicalDocumentUuid(topic) !== null && authorizedTopicMark(topic)) {
        authorizedTopics.add(topic);
      }
    }
    for (const uuid of purgeable) {
      const target = roomForDoc(workspaceId, uuid);
      if (this.deletedRooms.has(target) || classifications.rooms.get(target)?.deleted) continue;
      const change = entryChanges?.get(uuid);
      const before = change === undefined ? docs.get(uuid) : change.oldValue;
      const classification = classifications.rooms.get(target);
      if (classification?.topic !== undefined && classification.topic !== null) {
        if (authorizedTopicMark(classification.topic)) continue;
      } else {
        const inherited = [entryDecisionTopic(before, uuid), entryDecisionTopic(docs.get(uuid), uuid), topics.get(uuid)]
          .some(topic => typeof topic === "string" && topic !== uuid && marks.get(topic) === true);
        const isTopic = classification === undefined && referencedTopics.has(uuid);
        const savedTopic = topics.get(uuid);
        const unseenTopicRecord = classification === undefined && typeof savedTopic === "string" &&
          canonicalDocumentUuid(savedTopic) !== null && authorizedTopicMark(savedTopic);
        if (unseenTopicRecord || (!isTopic && !inherited && (!this.holdsRoom(target) || archivedBeforeOrNow(uuid)))) continue;
      }
      refused.push({ uuid, before });
    }
    if (refused.length === 0) return false;
    directory.transact(() => {
      for (const { uuid } of refused) {
        marks.delete(uuid);
        topics.delete(uuid);
      }
      for (const { uuid, before } of refused) {
        const entry = docs.get(uuid) ?? before;
        if (entry === undefined) continue;
        const classification = classifications.rooms.get(roomForDoc(workspaceId, uuid));
        const inherited = entryDecisionTopic(entry, uuid);
        if (inherited !== undefined && inherited !== uuid && marks.get(inherited) === true &&
            classification !== undefined) {
          const corrected = { ...entry as Record<string, unknown> };
          if (classification.topic === null) {
            delete corrected.kind;
            delete corrected.topic;
          } else if (classification.topic === inherited) {
            delete corrected.topic;
          } else {
            corrected.kind = "decision";
            corrected.topic = classification.topic;
          }
          docs.set(uuid, corrected);
        } else if (!docs.has(uuid)) docs.set(uuid, entry);
      }
    });
    return true;
  }

  private holdsRoom(room: string): boolean {
    return this.loadedRoom(room) || this.prepared().select.get({ name: room }) !== undefined;
  }

  private reconcileDirectory(room: string, directory: Y.Doc, transaction?: Y.Transaction): void {
    if (this.reconcilingDirectories.has(directory)) return;
    this.reconcilingDirectories.add(directory);
    try {
      const { workspaceId, isDirectory } = parseRoom(room);
      if (!isDirectory) return;
      this.classifyDirectory(room, directory, transaction);
      const marks = directory.getMap(DIRECTORY_DELETED_KEY);
      // A failed purge keeps its accepted fence. Restore it before authorization,
      // without extending it through writer-controlled topic membership.
      for (const deletedRoom of this.pendingDeletedRooms) {
        const parsed = parseRoom(deletedRoom);
        if (parsed.workspaceId === workspaceId && marks.get(parsed.uuid) !== true) marks.set(parsed.uuid, true);
      }
      // Accepted UUID evidence survives both rewritten directory state and restart.
      const workspaceClassifications = this.documentClassifications.forWorkspace(workspaceId);
      for (const [uuid, classification] of workspaceClassifications) {
        if (classification.deleted && marks.get(uuid) !== true) {
          marks.set(uuid, true);
        }
      }
      const authorizedTopics = new Set<string>();
      const corrected = this.refuseUnauthorizedDeletions(room, directory, authorizedTopics, transaction);
      // A writer may have removed or reclassified a record's directory entry.
      // Whole-topic deletion still includes every record the hub classified.
      for (const [uuid, classification] of workspaceClassifications) {
        if (classification.topic !== null &&
            authorizedTopics.has(classification.topic)) {
          const marks = directory.getMap(DIRECTORY_DELETED_KEY);
          if (marks.get(uuid) !== true) marks.set(uuid, true);
          if (uuid !== classification.topic) {
            const topics = directory.getMap(DIRECTORY_DELETED_DECISION_TOPICS_KEY);
            if (topics.get(uuid) !== classification.topic) topics.set(uuid, classification.topic);
          }
        }
      }
      const deleted = listDeletedDirectoryUuids(directory).map(uuid => roomForDoc(workspaceId, uuid));
      if (deleted.length === 0) {
        if (corrected) this.prepared().upsert.run({ name: room, data: directoryState(directory) });
        return;
      }
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
      const inferredTopics = new Map<string, string>();
      const topics = directory.getMap<unknown>(DIRECTORY_DELETED_DECISION_TOPICS_KEY);
      for (const [uuid, topic] of topics) {
        if (uuid !== topic && marks.get(uuid) === true && typeof topic === "string" && authorizedTopics.has(topic)) {
          inferredTopics.set(roomForDoc(workspaceId, topic), topic);
          inferredTopics.set(roomForDoc(workspaceId, uuid), topic);
        }
      }
      const database = this.connection;
      database.exec("BEGIN IMMEDIATE");
      try {
        this.prepared().upsert.run({ name: room, data: directoryState(directory) });
        this.documentClassifications.persistDeleted(deleted, inferredTopics);
        const remove = database.prepare('DELETE FROM documents WHERE name = ?');
        for (const name of deleted) {
          remove.run(name);
          this.revisions.purge(name);
        }
        database.exec("COMMIT");
        this.documentClassifications.rememberDeleted(deleted, inferredTopics);
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
