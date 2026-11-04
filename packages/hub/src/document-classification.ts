import type { DatabaseSync } from "node:sqlite";
import * as Y from "yjs";
import { canonicalDocumentUuid, getMetaMap, parseRoom } from "@uberblick/schema";

interface Classification {
  /** A page has no topic; adoption fixes its topic to its own UUID. */
  topic: string | null;
  deleted: boolean;
}

/** Hub-private identity evidence, independent of later writer-controlled metadata. */
export class DocumentClassifications {
  readonly rooms = new Map<string, Classification>();
  private readonly workspaces = new Map<string, Map<string, Classification>>();

  constructor(private readonly db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS document_classifications (
      name TEXT PRIMARY KEY, topic TEXT, deleted INTEGER NOT NULL DEFAULT 0
    )`);
    for (const row of db.prepare("SELECT name, topic, deleted FROM document_classifications").all()) {
      this.remember(row.name as string, { topic: row.topic as string | null, deleted: row.deleted === 1 });
    }
  }

  forWorkspace(workspaceId: string): ReadonlyMap<string, Classification> {
    return this.workspaces.get(workspaceId) ?? new Map();
  }

  observeEntry(room: string, entry: unknown): boolean {
    if (typeof entry !== "object" || entry === null) return false;
    const { uuid } = parseRoom(room);
    if (canonicalDocumentUuid(uuid) === null) return false;
    const candidate = entry as { kind?: unknown; topic?: unknown };
    const previous = this.rooms.get(room);
    if (previous?.deleted) return false;
    if (previous?.topic !== undefined && previous.topic !== null) return false;
    if (previous !== undefined && candidate.kind !== "decision") return false;
    const topic = candidate.kind === "decision"
      ? previous === undefined ? canonicalDocumentUuid(candidate.topic) ?? uuid : uuid
      : null;
    const classification = { topic, deleted: false };
    this.save(room, classification);
    return true;
  }

  observeRoom(room: string, document: Y.Doc, metadataOnly = false): boolean {
    const meta = getMetaMap(document);
    // Merely opening a room creates no page: a decision's first update may follow.
    if (meta.size === 0 && (metadataOnly || Y.encodeStateAsUpdate(document).length <= 2)) return false;
    return this.observeEntry(room, { kind: meta.get("kind"), topic: meta.get("topic") });
  }

  /** Caller commits these with the directory mark and purge, then remembers them. */
  persistDeleted(rooms: readonly string[], topics: ReadonlyMap<string, string> = new Map()): void {
    const statement = this.db.prepare(`INSERT INTO document_classifications (name, topic, deleted) VALUES (?, ?, 1)
      ON CONFLICT(name) DO UPDATE SET deleted = 1`);
    for (const room of rooms) statement.run(room, topics.get(room) ?? null);
  }

  rememberDeleted(rooms: readonly string[], topics: ReadonlyMap<string, string> = new Map()): void {
    for (const room of rooms) {
      const previous = this.rooms.get(room);
      this.remember(room, { topic: previous === undefined ? topics.get(room) ?? null : previous.topic, deleted: true });
    }
  }

  private remember(room: string, classification: Classification): void {
    const { workspaceId, uuid } = parseRoom(room);
    let workspace = this.workspaces.get(workspaceId);
    if (workspace === undefined) {
      workspace = new Map();
      this.workspaces.set(workspaceId, workspace);
    }
    this.rooms.set(room, classification);
    workspace.set(uuid, classification);
  }

  private save(room: string, classification: Classification): void {
    // A failed write forbids a durability claim, but cannot relax the live guard.
    this.remember(room, classification);
    this.db.prepare(`INSERT INTO document_classifications (name, topic, deleted) VALUES (?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET topic = excluded.topic, deleted = excluded.deleted`)
      .run(room, classification.topic, classification.deleted ? 1 : 0);
  }
}
