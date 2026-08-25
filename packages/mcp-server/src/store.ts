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
 * The binding is Node's built-in `node:sqlite` (`DatabaseSync`), synchronous
 * like the process it serves and with nothing to compile at install time. It
 * ships two conveniences fewer than better-sqlite3 did: pragmas go through
 * `exec`, and transactions through {@link transactional}. The file format is
 * ordinary SQLite either way, so a database written by the old binding opens
 * here unchanged.
 *
 * Sequence numbers come from an `AUTOINCREMENT` rowid. SQLite serialises
 * writers, so a row's `seq` order is also its commit order: a poller that has
 * applied everything up to `seq` cannot miss an earlier row appearing later.
 */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  SQLInputValue,
  SQLOutputValue,
  StatementResultingChanges,
} from "node:sqlite";

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

/**
 * A room holding local changes not known to have reached the hub, and the
 * highest local log sequence it is waiting on. The sequence is the watermark: a
 * room is only released up to a sequence that has been acknowledged, so a quiet
 * process cannot clear work another process appended after it last looked.
 */
export interface PendingRoom {
  room: string;
  seq: number;
}

/** One consistent read of a room's log: a snapshot to seed with, then the tail. */
export interface LogSlice {
  /**
   * The stored snapshot, when it is ahead of the caller's position — apply it
   * before `updates`. Null when the caller is already past it.
   */
  snapshot: StoredSnapshot | null;
  /** Log entries after `max(caller position, snapshot.throughSeq)`, in order. */
  updates: LoggedUpdate[];
}

/**
 * Read a search row's packed tags. `json_group_array` gives back a JSON array,
 * which survives tags containing anything at all — separators, quotes, nothing.
 */
function parseTags(packed: string | null): string[] {
  if (packed === null) {
    return [];
  }
  const parsed: unknown = JSON.parse(packed);
  return Array.isArray(parsed)
    ? parsed.filter((tag): tag is string => typeof tag === "string")
    : [];
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
--
-- \`seq\` is the highest local log sequence the room is waiting on, written in the
-- same transaction as the update itself. It is a watermark, not a flag: a
-- process that saw the hub acknowledge everything up to seq N clears only
-- \`seq <= N\`, so work another process appended at N+1 survives.
CREATE TABLE IF NOT EXISTS pending_rooms (
  room TEXT PRIMARY KEY,
  seq  INTEGER NOT NULL
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

/**
 * A prepared statement whose parameter list is typed. `node:sqlite` types every
 * binding as `SQLInputValue[]`, which checks neither arity nor order, so the
 * statement table below is the one place those are declared.
 */
interface Prepared<P extends SQLInputValue[]> {
  run(...params: P): StatementResultingChanges;
  get(...params: P): Record<string, SQLOutputValue> | undefined;
  all(...params: P): Record<string, SQLOutputValue>[];
}

/**
 * better-sqlite3's `.transaction()` wrapper, in the lines `node:sqlite` leaves
 * to the caller: run `body` between BEGIN and COMMIT, roll back if it throws.
 *
 * A deferred `BEGIN`, which is what the old binding issued — a body that only
 * reads takes a read snapshot and never blocks the other instance's writer.
 *
 * Nesting is unsupported and does not occur: none of the wrapped bodies calls
 * another (the one that spans two reads calls plain statement methods). A
 * nested call would fail loudly on SQLite's own "cannot start a transaction
 * within a transaction", raised by `BEGIN` before the `try`, leaving the outer
 * transaction intact for its own rollback.
 */
function transactional<A extends unknown[], R>(
  db: DatabaseSync,
  body: (...args: A) => R,
): (...args: A) => R {
  return (...args: A): R => {
    db.exec("BEGIN");
    try {
      const result = body(...args);
      db.exec("COMMIT");
      return result;
    } catch (error) {
      // Some failures (a full disk, an ON CONFLICT ROLLBACK) unwind the
      // transaction inside SQLite; asking again would throw over the real error.
      if (db.isTransaction) {
        db.exec("ROLLBACK");
      }
      throw error;
    }
  };
}

export class MirrorStore {
  readonly databasePath: string;

  private readonly db: DatabaseSync;

  private readonly statements: {
    append: Prepared<[string, Uint8Array, string, number]>;
    after: Prepared<[string, number]>;
    countRoom: Prepared<[string]>;
    countAll: Prepared<[]>;
    snapshot: Prepared<[string]>;
    putSnapshot: Prepared<[string, Uint8Array, number, number]>;
    pruneUpdates: Prepared<[string, number]>;
    markPending: Prepared<[string, number]>;
    clearPending: Prepared<[string, number]>;
    listPending: Prepared<[]>;
    putDoc: Prepared<[string, string]>;
    hasDoc: Prepared<[string]>;
    dropDoc: Prepared<[string]>;
    dropTags: Prepared<[string]>;
    putTag: Prepared<[string, string]>;
    dropLinks: Prepared<[string]>;
    putLink: Prepared<[string, string]>;
    dropFts: Prepared<[string]>;
    putFts: Prepared<[string, string, string]>;
    search: Prepared<[string, number]>;
    backlinks: Prepared<[string]>;
  };

  private readonly appendTx: (
    room: string,
    payload: Uint8Array,
    origin: UpdateOrigin,
  ) => number;

  private readonly compactTx: (
    room: string,
    state: Uint8Array,
    throughSeq: number,
  ) => boolean;

  private readonly readSinceTx: (room: string, seq: number) => LogSlice;

  private readonly indexTx: (doc: IndexedDoc) => void;

  private readonly unindexTx: (uuid: string) => void;

  constructor(databasePath: string) {
    this.databasePath = databasePath;
    if (databasePath !== ":memory:") {
      mkdirSync(dirname(databasePath), { recursive: true });
    }

    this.db = new DatabaseSync(databasePath);
    // WAL so a reader never blocks the writer, and a busy timeout so a second
    // MCP server instance waits its turn instead of failing the tool call.
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec(SCHEMA);
    // After the schema, so the backfill can read `updates` and `snapshots`.
    this.migratePendingRooms();

    const prepare = <P extends SQLInputValue[]>(sql: string): Prepared<P> =>
      this.db.prepare(sql) as Prepared<P>;

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
      // Monotonic: a compactor holding an older view of the document must never
      // replace a newer snapshot, whose rows the newer transaction has already
      // pruned. Losing the race means losing the write, not the data.
      putSnapshot: prepare(
        "INSERT INTO snapshots (room, state, through_seq, updated_at) VALUES (?, ?, ?, ?) " +
          "ON CONFLICT (room) DO UPDATE SET state = excluded.state, " +
          "through_seq = excluded.through_seq, updated_at = excluded.updated_at " +
          "WHERE snapshots.through_seq < excluded.through_seq",
      ),
      pruneUpdates: prepare(
        "DELETE FROM updates WHERE room = ? AND seq <= ?",
      ),
      markPending: prepare(
        "INSERT INTO pending_rooms (room, seq) VALUES (?, ?) " +
          "ON CONFLICT (room) DO UPDATE SET seq = MAX(pending_rooms.seq, excluded.seq)",
      ),
      // Only through the acknowledged watermark: a row whose seq has moved on
      // is work this caller never saw acknowledged.
      clearPending: prepare(
        "DELETE FROM pending_rooms WHERE room = ? AND seq <= ?",
      ),
      listPending: prepare("SELECT room, seq FROM pending_rooms ORDER BY room"),
      putDoc: prepare(
        "INSERT INTO doc_index (uuid, title) VALUES (?, ?) " +
          "ON CONFLICT (uuid) DO UPDATE SET title = excluded.title",
      ),
      hasDoc: prepare("SELECT 1 AS present FROM doc_index WHERE uuid = ?"),
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
      // Tags come back packed into the row rather than one query per hit: a
      // search over a growing corpus should cost one query, not 1 + limit.
      // The packing is a JSON array, not a joined string — tags are arbitrary
      // text, so any in-band separator would split a tag that contains it and
      // swallow an empty one.
      search: prepare(
        "SELECT f.uuid AS uuid, d.title AS title, " +
          "snippet(docs_fts, 2, '', '', '…', 16) AS snippet, " +
          "(SELECT json_group_array(t.tag) FROM " +
          "(SELECT tag FROM doc_tags WHERE uuid = f.uuid ORDER BY tag) t) AS tags " +
          "FROM docs_fts f JOIN doc_index d ON d.uuid = f.uuid " +
          "WHERE docs_fts MATCH ? ORDER BY bm25(docs_fts) LIMIT ?",
      ),
      backlinks: prepare(
        "SELECT l.source AS uuid, COALESCE(d.title, '') AS title " +
          "FROM doc_links l LEFT JOIN doc_index d ON d.uuid = l.source " +
          "WHERE l.target = ? ORDER BY title, l.source",
      ),
    };

    // The update and its pending marker land together, so a SIGKILL can never
    // leave a logged local change that nothing remembers to push.
    this.appendTx = transactional(
      this.db,
      (room: string, payload: Uint8Array, origin: UpdateOrigin): number => {
        const info = this.statements.append.run(
          room,
          payload,
          origin,
          Date.now(),
        );
        const seq = Number(info.lastInsertRowid);
        if (origin === "local") {
          this.statements.markPending.run(room, seq);
        }
        return seq;
      },
    );

    // Snapshot-then-prune in ONE transaction: a crash between the two would
    // otherwise drop updates that no snapshot covers. The upsert is monotonic,
    // so a stale compactor's write is refused rather than overwriting a newer
    // snapshot — and pruning stays safe either way, because whichever snapshot
    // survives covers at least as far as this one.
    this.compactTx = transactional(
      this.db,
      (room: string, state: Uint8Array, throughSeq: number): boolean => {
        const written =
          this.statements.putSnapshot.run(room, state, throughSeq, Date.now())
            .changes > 0;
        this.statements.pruneUpdates.run(room, throughSeq);
        return written;
      },
    );

    // Snapshot and tail in ONE transaction, so the pair is always consistent.
    // Read apart, a concurrent compaction can prune the rows between the
    // snapshot the reader saw and the tail it then reads, and the reader
    // advances past a gap Yjs can never fill.
    this.readSinceTx = transactional(
      this.db,
      (room: string, seq: number): LogSlice => {
        const stored = this.snapshot(room);
        const ahead = stored !== null && stored.throughSeq > seq;
        const from = ahead && stored !== null ? stored.throughSeq : seq;
        return {
          snapshot: ahead ? stored : null,
          updates: this.updatesAfter(room, from),
        };
      },
    );

    this.indexTx = transactional(this.db, (doc: IndexedDoc) => {
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

    this.unindexTx = transactional(this.db, (uuid: string) => {
      this.statements.dropFts.run(uuid);
      this.statements.dropTags.run(uuid);
      this.statements.dropLinks.run(uuid);
      this.statements.dropDoc.run(uuid);
    });
  }

  /**
   * Append one update to the log and return its `seq`. A local-origin update
   * also raises the room's pending watermark, in the same transaction.
   *
   * Synchronous and committed on return: the caller is a Yjs `update` observer,
   * so by the time a mutating tool returns, the update is on disk.
   */
  appendUpdate(
    room: string,
    payload: Uint8Array,
    origin: UpdateOrigin,
  ): number {
    return this.appendTx(room, payload, origin);
  }

  /**
   * One consistent read of everything a replica at `seq` has not seen: the
   * snapshot to seed from when it is ahead of `seq`, then the log tail.
   *
   * This is the only way to read the log for replay. Reading the snapshot and
   * the tail as two statements lets a concurrent compaction fall between them,
   * and the reader then advances past updates neither half contained.
   */
  readSince(room: string, seq: number): LogSlice {
    return this.readSinceTx(room, seq);
  }

  /** Log entries for one room after `seq`, in order. */
  updatesAfter(room: string, seq: number): LoggedUpdate[] {
    const rows = this.statements.after.all(room, seq) as {
      seq: number;
      payload: Uint8Array;
    }[];
    return rows.map((row) => ({ seq: row.seq, payload: row.payload }));
  }

  /** Whether the log holds anything at all for a room. */
  hasRoom(room: string): boolean {
    return (
      this.updateCount(room) > 0 || this.statements.snapshot.get(room) !== undefined
    );
  }

  snapshot(room: string): StoredSnapshot | null {
    const row = this.statements.snapshot.get(room) as
      | { state: Uint8Array; through_seq: number }
      | undefined;
    return row === undefined
      ? null
      : { state: row.state, throughSeq: row.through_seq };
  }

  /**
   * Replace a room's log prefix with a state snapshot.
   *
   * `throughSeq` must be a sequence the caller has provably applied to the
   * document `state` came from — everything above it stays in the log.
   *
   * Returns false when a newer snapshot already covers at least this far, in
   * which case the stored state is left alone. The prefix is pruned regardless:
   * the surviving snapshot covers it.
   */
  compact(room: string, state: Uint8Array, throughSeq: number): boolean {
    return this.compactTx(room, state, throughSeq);
  }

  updateCount(room: string): number {
    return (this.statements.countRoom.get(room) as { n: number }).n;
  }

  logSize(): number {
    return (this.statements.countAll.get() as { n: number }).n;
  }

  /**
   * Release a room's pending marker, but only up to `throughSeq` — the highest
   * local sequence the caller saw acknowledged. A marker that has moved past it
   * belongs to a change this caller never watched land, possibly one another
   * process appended a moment ago.
   */
  clearPending(room: string, throughSeq: number): void {
    this.statements.clearPending.run(room, throughSeq);
  }

  /** Rooms with local changes not known to have reached the hub. */
  pendingRooms(): PendingRoom[] {
    const rows = this.statements.listPending.all() as {
      room: string;
      seq: number;
    }[];
    return rows.map((row) => ({ room: row.room, seq: row.seq }));
  }

  /** Upsert one document's derived rows. Idempotent. */
  indexDoc(doc: IndexedDoc): void {
    this.indexTx(doc);
  }

  /**
   * Whether the derived index holds anything for this document.
   *
   * A primary-key lookup, and a read: in WAL a reader never waits on a writer,
   * so asking is free even while the database is locked for writing. That is
   * what makes it worth asking before attempting a delete that would otherwise
   * sit out the busy timeout only to find nothing to remove.
   */
  isIndexed(uuid: string): boolean {
    return this.statements.hasDoc.get(uuid) !== undefined;
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

  search(query: string, limit: number): SearchHit[] {
    const match = ftsQuery(query);
    if (match === null) {
      return [];
    }
    const rows = this.statements.search.all(match, limit) as {
      uuid: string;
      title: string;
      snippet: string;
      tags: string | null;
    }[];
    return rows.map((row) => ({
      uuid: row.uuid,
      title: row.title,
      tags: parseTags(row.tags),
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

  /**
   * Bring a `pending_rooms` table from before the watermark up to the new shape.
   *
   * The old shape recorded only *that* a room was pending, which is not enough
   * to release it safely — but it may be the only record that a room exists at
   * all. The crash window the old code left open is exactly that: a local update
   * logged and marked, with the directory stub never written. Deleting the marker
   * would strand that document forever — nothing would attach its room, so it
   * could never be discovered or pushed.
   *
   * So the marker is kept and given a conservative watermark: the room's highest
   * logged sequence (or its snapshot's, or 0). Conservative means "assume none of
   * it was acknowledged" — re-pushing an update the hub already has is free,
   * losing one is not.
   */
  private migratePendingRooms(): void {
    const columns = this.db
      .prepare("SELECT name FROM pragma_table_info('pending_rooms')")
      .all() as { name: string }[];
    if (columns.length === 0 || columns.some((column) => column.name === "seq")) {
      return;
    }

    transactional(this.db, () => {
      this.db.exec(
        "CREATE TABLE pending_rooms_migrated (room TEXT PRIMARY KEY, seq INTEGER NOT NULL);" +
          "INSERT INTO pending_rooms_migrated (room, seq) SELECT p.room, COALESCE(" +
          "(SELECT MAX(u.seq) FROM updates u WHERE u.room = p.room), " +
          "(SELECT s.through_seq FROM snapshots s WHERE s.room = p.room), 0) " +
          "FROM pending_rooms p;" +
          "DROP TABLE pending_rooms;" +
          "ALTER TABLE pending_rooms_migrated RENAME TO pending_rooms;",
      );
    })();
  }

  /**
   * Idempotent, because a store outlives no single owner: the server closes it
   * on shutdown and whoever handed it in may close it again. `node:sqlite`
   * throws on a second close where better-sqlite3 shrugged, and a teardown path
   * is the worst place to learn that.
   */
  close(): void {
    if (this.db.isOpen) {
      this.db.close();
    }
  }
}
