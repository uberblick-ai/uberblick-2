/**
 * The local SQLite mirror.
 *
 * Two different kinds of data live in this file, and confusing them is the one
 * mistake that matters:
 *
 * 1. **The update log** (`updates`, `snapshots`) is the authoritative local
 *    replica. Replicas hydrate from it on boot, never from the hub. Every
 *    update — local *and* remote origin — is appended synchronously before the
 *    call that produced it returns, which is what makes `kill -9` after a write
 *    lose nothing.
 * 2. **The derived index** (`doc_index`, `docs_fts`, `doc_tags`, `doc_links`)
 *    is a cache of what the Y.Docs say, rebuildable at any time from the log —
 *    see {@link MirrorStore.clearDerived}. It is never authoritative, and no
 *    document state exists only here.
 *
 * Encoding is Yjs v1 everywhere (`Y.encodeStateAsUpdate` / `Y.applyUpdate`),
 * matching the hub's persistence and the schema package. Never v2.
 *
 * Concurrency: two MCP server instances sharing one database is the normal
 * case (a user runs Claude Code twice), so the file is opened in WAL with a
 * busy timeout, writes are small single-statement transactions, and readers
 * catch up by polling the log tail — see `replica.ts`.
 *
 * Sequence numbers come from an `AUTOINCREMENT` rowid. SQLite serialises
 * writers, so a row's `seq` order is also its commit order: a poller that has
 * applied everything up to `seq` cannot miss an earlier row appearing later.
 */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import type { Database as Db, Statement } from "better-sqlite3";

/** Where an update came from. Both are logged; the distinction is diagnostic. */
export type UpdateOrigin = "local" | "remote";

export interface LoggedUpdate {
  seq: number;
  payload: Uint8Array;
}

export interface StoredSnapshot {
  state: Uint8Array;
  /** The last log `seq` folded into this snapshot. */
  throughSeq: number;
}

/** What the derived index knows about one document. */
export interface IndexedDoc {
  uuid: string;
  title: string;
  tags: string[];
  /** Outbound links, by target document UUID. */
  links: string[];
  /** The document's block text, concatenated, for full-text search. */
  body: string;
}

export interface SearchHit {
  uuid: string;
  title: string;
  tags: string[];
  /** A match excerpt from the body, or the title when the title matched. */
  snippet: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS updates (
  seq     INTEGER PRIMARY KEY AUTOINCREMENT,
  room    TEXT NOT NULL,
  payload BLOB NOT NULL,
  origin  TEXT NOT NULL,
  logged_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS updates_room_seq ON updates (room, seq);

CREATE TABLE IF NOT EXISTS snapshots (
  room        TEXT PRIMARY KEY,
  state       BLOB NOT NULL,
  through_seq INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

-- Rooms holding local changes not known to have reached the hub. Survives a
-- restart, so a doc created offline is re-attached and pushed on reconnect.
CREATE TABLE IF NOT EXISTS pending_rooms (
  room  TEXT PRIMARY KEY,
  since INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS doc_index (
  uuid  TEXT PRIMARY KEY,
  title TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS doc_tags (
  uuid TEXT NOT NULL,
  tag  TEXT NOT NULL,
  PRIMARY KEY (uuid, tag)
);
CREATE INDEX IF NOT EXISTS doc_tags_tag ON doc_tags (tag);
CREATE TABLE IF NOT EXISTS doc_links (
  source TEXT NOT NULL,
  target TEXT NOT NULL,
  PRIMARY KEY (source, target)
);
CREATE INDEX IF NOT EXISTS doc_links_target ON doc_links (target);

CREATE VIRTUAL TABLE IF NOT EXISTS docs_fts USING fts5 (
  uuid UNINDEXED,
  title,
  body
);
`;

/**
 * Turn a user query into an FTS5 MATCH expression.
 *
 * Every token is quoted, so a query containing FTS5 operators (`NEAR`, `OR`, a
 * stray quote) is searched for rather than executed. A trailing `*` survives as
 * a prefix match, which is the one operator worth keeping.
 */
export function ftsQuery(raw: string): string | null {
  const tokens = raw.match(/[\p{L}\p{N}_]+\*?/gu);
  if (tokens === null || tokens.length === 0) {
    return null;
  }
  return tokens
    .map((token) =>
      token.endsWith("*") ? `"${token.slice(0, -1)}"*` : `"${token}"`,
    )
    .join(" ");
}

function toBuffer(bytes: Uint8Array): Buffer {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function toBytes(value: Buffer | Uint8Array): Uint8Array {
  return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
}

export class MirrorStore {
  readonly databasePath: string;

  private readonly db: Db;

  private readonly statements: {
    append: Statement<[string, Buffer, string, number]>;
    after: Statement<[string, number]>;
    countRoom: Statement<[string]>;
    countAll: Statement<[]>;
    snapshot: Statement<[string]>;
    putSnapshot: Statement<[string, Buffer, number, number]>;
    pruneUpdates: Statement<[string, number]>;
    markPending: Statement<[string, number]>;
    clearPending: Statement<[string]>;
    listPending: Statement<[]>;
    putDoc: Statement<[string, string]>;
    dropDoc: Statement<[string]>;
    dropTags: Statement<[string]>;
    putTag: Statement<[string, string]>;
    dropLinks: Statement<[string]>;
    putLink: Statement<[string, string]>;
    dropFts: Statement<[string]>;
    putFts: Statement<[string, string, string]>;
    tagsOf: Statement<[string]>;
    search: Statement<[string, number]>;
    backlinks: Statement<[string]>;
  };

  private readonly compactTx: (
    room: string,
    state: Buffer,
    throughSeq: number,
  ) => void;

  private readonly indexTx: (doc: IndexedDoc) => void;

  private readonly unindexTx: (uuid: string) => void;

  constructor(databasePath: string) {
    this.databasePath = databasePath;
    if (databasePath !== ":memory:") {
      mkdirSync(dirname(databasePath), { recursive: true });
    }

    this.db = new Database(databasePath);
    // WAL so a reader never blocks the writer, and a busy timeout so a second
    // MCP server instance waits its turn instead of failing the tool call.
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    this.db.pragma("foreign_keys = ON");
    this.db.exec(SCHEMA);

    const prepare = <T extends unknown[]>(sql: string): Statement<T> =>
      this.db.prepare(sql) as Statement<T>;

    this.statements = {
      append: prepare(
        "INSERT INTO updates (room, payload, origin, logged_at) VALUES (?, ?, ?, ?)",
      ),
      after: prepare(
        "SELECT seq, payload FROM updates WHERE room = ? AND seq > ? ORDER BY seq",
      ),
      countRoom: prepare(
        "SELECT COUNT(*) AS n FROM updates WHERE room = ?",
      ),
      countAll: prepare("SELECT COUNT(*) AS n FROM updates"),
      snapshot: prepare(
        "SELECT state, through_seq FROM snapshots WHERE room = ?",
      ),
      putSnapshot: prepare(
        "INSERT INTO snapshots (room, state, through_seq, updated_at) VALUES (?, ?, ?, ?) " +
          "ON CONFLICT (room) DO UPDATE SET state = excluded.state, " +
          "through_seq = excluded.through_seq, updated_at = excluded.updated_at",
      ),
      pruneUpdates: prepare(
        "DELETE FROM updates WHERE room = ? AND seq <= ?",
      ),
      markPending: prepare(
        "INSERT INTO pending_rooms (room, since) VALUES (?, ?) ON CONFLICT (room) DO NOTHING",
      ),
      clearPending: prepare("DELETE FROM pending_rooms WHERE room = ?"),
      listPending: prepare("SELECT room FROM pending_rooms ORDER BY room"),
      putDoc: prepare(
        "INSERT INTO doc_index (uuid, title) VALUES (?, ?) " +
          "ON CONFLICT (uuid) DO UPDATE SET title = excluded.title",
      ),
      dropDoc: prepare("DELETE FROM doc_index WHERE uuid = ?"),
      dropTags: prepare("DELETE FROM doc_tags WHERE uuid = ?"),
      putTag: prepare(
        "INSERT INTO doc_tags (uuid, tag) VALUES (?, ?) ON CONFLICT DO NOTHING",
      ),
      dropLinks: prepare("DELETE FROM doc_links WHERE source = ?"),
      putLink: prepare(
        "INSERT INTO doc_links (source, target) VALUES (?, ?) ON CONFLICT DO NOTHING",
      ),
      dropFts: prepare("DELETE FROM docs_fts WHERE uuid = ?"),
      putFts: prepare(
        "INSERT INTO docs_fts (uuid, title, body) VALUES (?, ?, ?)",
      ),
      tagsOf: prepare("SELECT tag FROM doc_tags WHERE uuid = ? ORDER BY tag"),
      search: prepare(
        "SELECT f.uuid AS uuid, d.title AS title, " +
          "snippet(docs_fts, 2, '', '', '…', 16) AS snippet " +
          "FROM docs_fts f JOIN doc_index d ON d.uuid = f.uuid " +
          "WHERE docs_fts MATCH ? ORDER BY bm25(docs_fts) LIMIT ?",
      ),
      backlinks: prepare(
        "SELECT l.source AS uuid, COALESCE(d.title, '') AS title " +
          "FROM doc_links l LEFT JOIN doc_index d ON d.uuid = l.source " +
          "WHERE l.target = ? ORDER BY title, l.source",
      ),
    };

    // Snapshot-then-delete in ONE transaction: a crash between the two would
    // otherwise drop updates that no snapshot covers.
    this.compactTx = this.db.transaction(
      (room: string, state: Buffer, throughSeq: number) => {
        this.statements.putSnapshot.run(room, state, throughSeq, Date.now());
        this.statements.pruneUpdates.run(room, throughSeq);
      },
    );

    this.indexTx = this.db.transaction((doc: IndexedDoc) => {
      this.statements.putDoc.run(doc.uuid, doc.title);
      this.statements.dropTags.run(doc.uuid);
      for (const tag of new Set(doc.tags)) {
        this.statements.putTag.run(doc.uuid, tag);
      }
      this.statements.dropLinks.run(doc.uuid);
      for (const target of new Set(doc.links)) {
        if (target !== doc.uuid) this.statements.putLink.run(doc.uuid, target);
      }
      this.statements.dropFts.run(doc.uuid);
      this.statements.putFts.run(doc.uuid, doc.title, doc.body);
    });

    this.unindexTx = this.db.transaction((uuid: string) => {
      this.statements.dropFts.run(uuid);
      this.statements.dropTags.run(uuid);
      this.statements.dropLinks.run(uuid);
      this.statements.dropDoc.run(uuid);
    });
  }

  /**
   * Append one update to the log and return its `seq`.
   *
   * Synchronous and committed on return: the caller is a Yjs `update` observer,
   * so by the time a mutating tool returns, the update is on disk.
   */
  appendUpdate(
    room: string,
    payload: Uint8Array,
    origin: UpdateOrigin,
  ): number {
    const info = this.statements.append.run(
      room,
      toBuffer(payload),
      origin,
      Date.now(),
    );
    return Number(info.lastInsertRowid);
  }

  /** Log entries for one room after `seq`, in order. */
  updatesAfter(room: string, seq: number): LoggedUpdate[] {
    const rows = this.statements.after.all(room, seq) as {
      seq: number;
      payload: Buffer;
    }[];
    return rows.map((row) => ({ seq: row.seq, payload: toBytes(row.payload) }));
  }

  /** Whether the log holds anything at all for a room. */
  hasRoom(room: string): boolean {
    return (
      this.updateCount(room) > 0 || this.statements.snapshot.get(room) !== undefined
    );
  }

  snapshot(room: string): StoredSnapshot | null {
    const row = this.statements.snapshot.get(room) as
      | { state: Buffer; through_seq: number }
      | undefined;
    return row === undefined
      ? null
      : { state: toBytes(row.state), throughSeq: row.through_seq };
  }

  /**
   * Replace a room's log prefix with a state snapshot.
   *
   * `throughSeq` must be a sequence the caller has provably applied to the
   * document `state` came from — everything above it stays in the log.
   */
  compact(room: string, state: Uint8Array, throughSeq: number): void {
    this.compactTx(room, toBuffer(state), throughSeq);
  }

  updateCount(room: string): number {
    return (this.statements.countRoom.get(room) as { n: number }).n;
  }

  logSize(): number {
    return (this.statements.countAll.get() as { n: number }).n;
  }

  markPending(room: string): void {
    this.statements.markPending.run(room, Date.now());
  }

  clearPending(room: string): void {
    this.statements.clearPending.run(room);
  }

  pendingRooms(): string[] {
    return (this.statements.listPending.all() as { room: string }[]).map(
      (row) => row.room,
    );
  }

  /** Upsert one document's derived rows. Idempotent. */
  indexDoc(doc: IndexedDoc): void {
    this.indexTx(doc);
  }

  /**
   * Drop one document's derived rows — a document tombstoned in the directory
   * must not surface in search. The doc's log is untouched: the tombstone is a
   * directory fact, not a reason to forget the replica.
   */
  unindexDoc(uuid: string): void {
    this.unindexTx(uuid);
  }

  /**
   * Drop every derived row. The rebuild path: callers follow this by
   * re-indexing each document read out of its log-hydrated replica, which is
   * why nothing here has to be authoritative.
   */
  clearDerived(): void {
    this.db.exec(
      "DELETE FROM doc_index; DELETE FROM doc_tags; DELETE FROM doc_links; DELETE FROM docs_fts;",
    );
  }

  tagsOf(uuid: string): string[] {
    return (this.statements.tagsOf.all(uuid) as { tag: string }[]).map(
      (row) => row.tag,
    );
  }

  search(query: string, limit: number): SearchHit[] {
    const match = ftsQuery(query);
    if (match === null) {
      return [];
    }
    const rows = this.statements.search.all(match, limit) as {
      uuid: string;
      title: string;
      snippet: string;
    }[];
    return rows.map((row) => ({
      uuid: row.uuid,
      title: row.title,
      tags: this.tagsOf(row.uuid),
      snippet: row.snippet === "" ? row.title : row.snippet,
    }));
  }

  /** Documents whose `links` name `uuid`. */
  backlinks(uuid: string): { uuid: string; title: string }[] {
    return this.statements.backlinks.all(uuid) as {
      uuid: string;
      title: string;
    }[];
  }

  close(): void {
    this.db.close();
  }
}
