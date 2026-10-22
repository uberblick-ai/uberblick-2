import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  DIRECTORY_DOCS_KEY,
  isDirectoryEntryArchived,
  parseRoom,
  roomForDoc,
  snapshotRevision,
} from "@uberblick/schema";
import type * as Y from "yjs";
import { getUpdateAttribution, type UpdateAuthor } from "./update-attribution.js";

const STRETCH_MS = 15 * 60 * 1_000;
const MAX_SURFACE_LENGTH = 256;

export interface StoredRevision {
  id: string;
  author: UpdateAuthor | null;
  startedAt: number | null;
  endedAt: number | null;
}

interface Snapshot {
  state: Uint8Array;
  checksum: string;
  empty: boolean;
}

interface Head {
  id: string;
  author: string | null;
  author_key: string;
  started_at: number;
  checksum: string;
  previous_checksum: string;
  data: Uint8Array | null;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function snapshot(document: Y.Doc): Snapshot {
  const result = snapshotRevision(document);
  return { ...result, checksum: digest(result.checksum) };
}

function boundedSurface(value: string): string {
  const points: string[] = [];
  for (const point of value) {
    if (points.length === MAX_SURFACE_LENGTH) return `${points.slice(0, MAX_SURFACE_LENGTH - 1).join("")}…`;
    points.push(point);
  }
  return value;
}

function authorIdentity(author: UpdateAuthor | null): { key: string; label: string | null } {
  if (author === null) return { key: "unknown", label: null };
  return {
    key: digest(JSON.stringify([author.principalId, author.surface.kind, author.surface.name])),
    label: JSON.stringify({ principalId: author.principalId, surface: {
      kind: boundedSurface(author.surface.kind), name: boundedSurface(author.surface.name),
    } }),
  };
}

/** Closed rows never change; the head's deadline also closes it without a timer. */
export class HubRevisions {
  private readonly observed = new WeakSet<Y.Doc>();

  constructor(
    private readonly db: DatabaseSync,
    readonly enabled: boolean,
    private readonly isDeleted: (room: string) => boolean,
    private readonly onStoreFailed: (error: unknown) => void,
    private readonly now: () => number = Date.now,
  ) {
    db.exec(`CREATE TABLE IF NOT EXISTS document_revisions (
      id TEXT PRIMARY KEY NOT NULL,
      room TEXT NOT NULL,
      author TEXT,
      started_at INTEGER,
      ended_at INTEGER NOT NULL,
      checksum TEXT NOT NULL,
      data BLOB NOT NULL
    );
    CREATE INDEX IF NOT EXISTS document_revisions_room ON document_revisions(room);
    CREATE TABLE IF NOT EXISTS document_revision_heads (
      room TEXT PRIMARY KEY NOT NULL,
      id TEXT UNIQUE NOT NULL,
      author TEXT,
      author_key TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      checksum TEXT NOT NULL,
      previous_checksum TEXT NOT NULL,
      data BLOB
    );
    CREATE TABLE IF NOT EXISTS document_revision_documents (room TEXT PRIMARY KEY NOT NULL)`);
  }

  observe(room: string, document: Y.Doc): void {
    if (!this.enabled || this.observed.has(document)) return;
    this.observed.add(document);
    let before = snapshot(document);
    let missedCapture = false;
    document.on("afterTransaction", (transaction: Y.Transaction) => {
      if (transaction.changed.size === 0 || this.isDeleted(room)) return;
      try {
        const after = snapshot(document);
        if (before.checksum === after.checksum) return;
        this.record(room, before, after, missedCapture ? null : getUpdateAttribution(transaction.origin)?.author ?? null);
        before = after;
        missedCapture = false;
      } catch (error) {
        missedCapture = true;
        this.onStoreFailed(error);
        throw error;
      }
    });
  }

  observeDirectory(room: string, document: Y.Doc): void {
    if (!this.enabled || this.observed.has(document)) return;
    this.observed.add(document);
    const { workspaceId } = parseRoom(room);
    const archiveState = (): Map<string, boolean> => new Map(
      [...document.getMap(DIRECTORY_DOCS_KEY).keys()].map(uuid => [uuid, isDirectoryEntryArchived(document, uuid)]),
    );
    let before = archiveState();
    document.on("afterTransaction", (transaction: Y.Transaction) => {
      if (transaction.changed.size === 0) return;
      try {
        const after = archiveState();
        const at = this.now();
        for (const [uuid, archived] of after) {
          if (archived !== (before.get(uuid) ?? false)) this.close(roomForDoc(workspaceId, uuid), at);
        }
        before = after;
      } catch (error) {
        this.onStoreFailed(error);
        throw error;
      }
    });
  }

  list(room: string): StoredRevision[] {
    const rows = this.db.prepare(`SELECT id, author, started_at, ended_at FROM document_revisions
      WHERE room = ? ORDER BY rowid DESC`).all(room);
    const head = this.head(room);
    const result: StoredRevision[] = rows.map(row => ({
      id: row.id as string,
      author: row.author === null ? null : JSON.parse(row.author as string) as UpdateAuthor,
      startedAt: row.started_at as number | null,
      endedAt: row.ended_at as number,
    }));
    if (head !== undefined && head.checksum !== head.previous_checksum) result.unshift({
      id: head.id,
      author: head.author === null ? null : JSON.parse(head.author) as UpdateAuthor,
      startedAt: head.started_at,
      endedAt: this.now() >= head.started_at + STRETCH_MS ? head.started_at + STRETCH_MS : null,
    });
    return result;
  }

  get(room: string, id: string): Uint8Array | null {
    const head = this.head(room);
    if (head?.id === id && head.checksum !== head.previous_checksum) return head.data;
    const row = this.db.prepare("SELECT data FROM document_revisions WHERE room = ? AND id = ?").get(room, id);
    return row?.data instanceof Uint8Array ? row.data : null;
  }

  /** Caller owns the transaction that also deletes the document's stored room. */
  purge(room: string): void {
    this.db.prepare("DELETE FROM document_revisions WHERE room = ?").run(room);
    this.db.prepare("DELETE FROM document_revision_heads WHERE room = ?").run(room);
    this.db.prepare("DELETE FROM document_revision_documents WHERE room = ?").run(room);
  }

  private record(room: string, before: Snapshot, after: Snapshot, author: UpdateAuthor | null): void {
    if (this.isDeleted(room)) return;
    const at = this.now();
    const identity = authorIdentity(author);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      let head = this.head(room);
      if (head !== undefined && (head.author_key !== identity.key || at >= head.started_at + STRETCH_MS)) {
        this.closeHead(room, head, at);
        head = undefined;
      }
      if (head === undefined) {
        const recorded = this.db.prepare("SELECT room FROM document_revision_documents WHERE room = ?").get(room);
        if (recorded === undefined) {
          if (!before.empty) this.insert(room, randomUUID(), null, null, at, before);
          this.db.prepare("INSERT INTO document_revision_documents (room) VALUES (?)").run(room);
        }
        this.db.prepare(`INSERT INTO document_revision_heads
          (room, id, author, author_key, started_at, checksum, previous_checksum, data)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
          room, randomUUID(), identity.label, identity.key, at, after.checksum, before.checksum, after.state,
        );
      } else {
        this.db.prepare("UPDATE document_revision_heads SET checksum = ?, data = ? WHERE room = ?")
          .run(after.checksum, after.checksum === head.previous_checksum ? null : after.state, room);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private head(room: string): Head | undefined {
    return this.db.prepare("SELECT * FROM document_revision_heads WHERE room = ?").get(room) as unknown as Head | undefined;
  }

  private close(room: string, at: number): void {
    const head = this.head(room);
    if (head === undefined) return;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.closeHead(room, head, at);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private closeHead(room: string, head: Head, at: number): void {
    if (head.checksum !== head.previous_checksum && head.data !== null) this.insert(
      room, head.id, head.author, head.started_at, Math.min(at, head.started_at + STRETCH_MS),
      { state: head.data, checksum: head.checksum, empty: false },
    );
    this.db.prepare("DELETE FROM document_revision_heads WHERE room = ?").run(room);
  }

  private insert(room: string, id: string, author: string | null, start: number | null, end: number, value: Snapshot): void {
    this.db.prepare(`INSERT INTO document_revisions
      (id, room, author, started_at, ended_at, checksum, data) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(id, room, author, start, end, value.checksum, value.state);
  }
}
