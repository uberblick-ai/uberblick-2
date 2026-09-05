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
 * 2. **The derived index** (`doc_index`, `doc_index_seq`, `docs_fts`,
 *    `doc_tags`, `doc_links`) is a cache of what the Y.Docs say, rebuildable at
 *    any time from the log — see {@link MirrorStore.clearDerived}. It is never
 *    authoritative, and no document state exists only here.
 *
 * Alongside both, `meta` records process-local facts that cannot be derived
 * from documents. The permanent `workspace` row binds the file to its corpus;
 * the serving engine's holder row is meaningful only while its separate
 * process-held SQLite lock is live — see `serving-role.ts`.
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

import { chmodSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createDataDirectory } from "@uberblick/hub/storage";
import type {
  SQLInputValue,
  SQLOutputValue,
  StatementResultingChanges,
} from "node:sqlite";
import { log } from "./log.js";

const BUSY_TIMEOUT_MS = 5_000;
const WAL_RETRY_MS = 10;
const walRetryWaiter = new Int32Array(new SharedArrayBuffer(4));

/** SQLite's primary busy result, including extended codes such as BUSY_RECOVERY. */
function isBusy(error: unknown): boolean {
  const errcode = (error as { errcode?: unknown } | null)?.errcode;
  return typeof errcode === "number" && (errcode & 0xff) === 5;
}

/**
 * Enable WAL within the same bound as the connection's busy handler.
 *
 * SQLite does not consult that handler while the first connection converts a
 * new file from rollback journalling to WAL, so simultaneous creators have to
 * retry this pragma itself. Nothing after initialization is retried here.
 */
function enableWal(db: DatabaseSync): void {
  const deadline = Date.now() + BUSY_TIMEOUT_MS;
  for (;;) {
    try {
      db.exec("PRAGMA journal_mode = WAL");
      return;
    } catch (error) {
      const remaining = deadline - Date.now();
      if (!isBusy(error) || remaining <= 0) {
        throw error;
      }
      Atomics.wait(walRetryWaiter, 0, 0, Math.min(WAL_RETRY_MS, remaining));
    }
  }
}

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
  /** Canonical catalog identities, never display names. */
  tags: string[];
  /** The document's description, or the empty string when it has none. */
  description: string;
  /** Outbound links, by target document UUID. */
  links: string[];
  /** The document's block text, concatenated, for full-text search. */
  body: string;
}

export interface SearchHit {
  uuid: string;
  title: string;
  tags: string[];
  /** The document's description, or null when it has none. */
  description: string | null;
  /**
   * A match excerpt from the body, or the title when the title matched.
   *
   * The description leads the indexed body, so this can be description text —
   * either because the description is what matched, or because the match sat
   * near enough to the start of a short document for the snippet window to
   * reach back over it.
   */
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

/** One replica's contiguous position in the authoritative room log. */
export interface RoomLogPosition {
  room: string;
  throughSeq: number;
}

/** Store facts sampled together for a sync-status reading. */
export interface StoreSyncSnapshot {
  /** Rooms whose local-origin watermark has not been released. */
  pendingRooms: PendingRoom[];
  /** Rooms with a snapshot or update beyond the supplied replica position. */
  unappliedRooms: Set<string>;
}

/**
 * Read a search row's packed catalog identities. `json_group_array` preserves
 * the UUID strings without an in-band separator.
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

/**
 * Process-local facts about this file, as opposed to document state. The
 * `workspace` row is the uuid whose corpus this replica holds. The index tables
 * carry no workspace column, so the file itself is the boundary. The serving
 * role also keeps its diagnostic holder here; its authority is the separate
 * process-held lock, never this persistent row.
 *
 * Its own script, run before {@link SCHEMA}: it is everything the store is
 * allowed to write to a file it has not yet established is its own. See
 * \`claimWorkspace\`.
 */
const META_SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

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
  uuid        TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS doc_index_seq (
  uuid                TEXT PRIMARY KEY,
  indexed_through_seq INTEGER NOT NULL,
  catalog_through_seq INTEGER NOT NULL DEFAULT 0
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

-- The description is searched as part of \`body\` rather than as a column of its
-- own. FTS5 has no ADD COLUMN, so a fourth column would mean dropping and
-- recreating this table — throwing away every existing row's body index for a
-- field no document had until now. Concatenating costs nothing and reindexes
-- one document at a time, as descriptions are written.
--
-- The cost is paid in ranking. bm25 weights columns, and a description folded
-- into \`body\` cannot be weighted apart from it: a term in a description ranks
-- as an ordinary body term rather than as the strong signal about a document
-- that it is, and it lengthens the column it joins, which bm25 reads as
-- slightly diluting every other term in that document. Both effects are small
-- at 300 characters against a whole document, and neither is fixable without
-- the column FTS5 will not add — so this is an accepted trade, not an
-- oversight.
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
 * The deferred `BEGIN` is what the old binding issued. The read-only body takes
 * a consistent snapshot without blocking another instance's writer; write
 * bodies acquire their place in the writer queue at their first statement.
 *
 * Nesting is unsupported and does not occur: none of the wrapped bodies calls
 * another (the one that spans three reads calls plain statement methods). A
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

  /**
   * Same-process commits, observed only after their transaction completed.
   *
   * SQLite's `data_version` deliberately does not move for the connection that
   * made a commit. A process driving replicas without MCP tool calls therefore
   * needs this second wake path beside its foreign-commit poll.
   */
  private readonly appendListeners = new Set<() => void>();

  private readonly statements: {
    dataVersion: Prepared<[]>;
    append: Prepared<[string, Uint8Array, string, number]>;
    after: Prepared<[string, number]>;
    countRoom: Prepared<[string]>;
    countAll: Prepared<[]>;
    snapshotSeq: Prepared<[string]>;
    snapshotAfter: Prepared<[string, number]>;
    snapshot: Prepared<[string]>;
    updateAfter: Prepared<[string, number]>;
    putSnapshot: Prepared<[string, Uint8Array, number, number]>;
    pruneUpdates: Prepared<[string, number]>;
    markPending: Prepared<[string, number]>;
    clearPending: Prepared<[string, number]>;
    listPending: Prepared<[]>;
    advanceIndex: Prepared<[string, number, number]>;
    putDoc: Prepared<[string, string, string]>;
    hasDoc: Prepared<[string]>;
    dropDoc: Prepared<[string]>;
    dropIndexSeq: Prepared<[string]>;
    dropTags: Prepared<[string]>;
    putTag: Prepared<[string, string]>;
    dropLinks: Prepared<[string]>;
    putLink: Prepared<[string, string]>;
    dropFts: Prepared<[string]>;
    putFts: Prepared<[string, string, string]>;
    search: Prepared<[string, string | null, string | null, number]>;
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

  private readonly syncSnapshotTx: (
    positions: readonly RoomLogPosition[],
  ) => StoreSyncSnapshot;

  private readonly indexTx: (
    doc: IndexedDoc,
    throughSeq: number,
    catalogThroughSeq: number,
  ) => void;

  private readonly unindexTx: (uuid: string) => void;

  constructor(databasePath: string, workspaceId: string) {
    this.databasePath = databasePath;
    // Owner-only: this replica holds the whole corpus, and it is as often as
    // not the first thing to create the user's data tree — a directory left at
    // the umask here is one `ub init` then writes credentials.json into.
    const durable = databasePath !== ":memory:";
    const fresh = durable && !existsSync(databasePath);
    if (durable) {
      createDataDirectory(dirname(databasePath));
    }

    this.db = new DatabaseSync(databasePath);
    // Only a file this constructor created, and before the WAL exists, so the
    // -wal and -shm files SQLite creates beside it inherit the same mode.
    if (fresh) {
      chmodSync(databasePath, 0o600);
    }
    // WAL so a reader never blocks the writer, and a busy timeout so a second
    // MCP server instance waits its turn instead of failing the tool call.
    this.db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    enableWal(this.db);
    this.db.exec("PRAGMA foreign_keys = ON");
    // Whether this file already held a corpus, asked before anything creates
    // the table it asks about: it is what tells adopting an existing database
    // apart from stamping a new one.
    const preexisting =
      this.db
        .prepare(
          "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'updates'",
        )
        .get() !== undefined;
    // Ownership first, and on its own table: a file belonging to another
    // workspace is left exactly as it was found — no tables created, no index
    // built, no migration run.
    this.db.exec(META_SCHEMA);
    this.claimWorkspace(workspaceId, preexisting);
    this.db.exec(SCHEMA);
    // After the schema, so the backfill can read `updates` and `snapshots`.
    this.migratePendingRooms();
    this.migrateDocDescription();
    this.migrateCatalogIndexSequence();

    const prepare = <P extends SQLInputValue[]>(sql: string): Prepared<P> =>
      this.db.prepare(sql) as Prepared<P>;

    this.statements = {
      dataVersion: prepare("PRAGMA data_version"),
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
      snapshotSeq: prepare(
        "SELECT through_seq FROM snapshots WHERE room = ?",
      ),
      snapshotAfter: prepare(
        "SELECT 1 AS present FROM snapshots WHERE room = ? AND through_seq > ?",
      ),
      snapshot: prepare(
        "SELECT state, through_seq FROM snapshots WHERE room = ?",
      ),
      updateAfter: prepare(
        "SELECT 1 AS present FROM updates WHERE room = ? AND seq > ? LIMIT 1",
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
      advanceIndex: prepare(
        "INSERT INTO doc_index_seq (uuid, indexed_through_seq, catalog_through_seq) VALUES (?, ?, ?) " +
          "ON CONFLICT (uuid) DO UPDATE SET " +
          "indexed_through_seq = excluded.indexed_through_seq, " +
          "catalog_through_seq = excluded.catalog_through_seq " +
          "WHERE doc_index_seq.indexed_through_seq <= excluded.indexed_through_seq " +
          "AND doc_index_seq.catalog_through_seq <= excluded.catalog_through_seq " +
          "AND (doc_index_seq.indexed_through_seq < excluded.indexed_through_seq " +
          "OR doc_index_seq.catalog_through_seq < excluded.catalog_through_seq)",
      ),
      putDoc: prepare(
        "INSERT INTO doc_index (uuid, title, description) VALUES (?, ?, ?) " +
          "ON CONFLICT (uuid) DO UPDATE SET title = excluded.title, " +
          "description = excluded.description",
      ),
      hasDoc: prepare("SELECT 1 AS present FROM doc_index WHERE uuid = ?"),
      dropDoc: prepare("DELETE FROM doc_index WHERE uuid = ?"),
      dropIndexSeq: prepare("DELETE FROM doc_index_seq WHERE uuid = ?"),
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
      // The packing is a JSON array, not a joined string, so the representation
      // stays unambiguous and independently parseable.
      search: prepare(
        "SELECT f.uuid AS uuid, d.title AS title, d.description AS description, " +
          "snippet(docs_fts, 2, '', '', '…', 16) AS snippet, " +
          "(SELECT json_group_array(t.tag) FROM " +
          "(SELECT tag FROM doc_tags WHERE uuid = f.uuid ORDER BY tag) t) AS tags " +
          "FROM docs_fts f JOIN doc_index d ON d.uuid = f.uuid " +
          "WHERE docs_fts MATCH ? AND (? IS NULL OR EXISTS " +
          "(SELECT 1 FROM doc_tags WHERE uuid = f.uuid AND tag = ?)) " +
          "ORDER BY bm25(docs_fts) LIMIT ?",
      ),
      backlinks: prepare(
        "SELECT l.source AS uuid, COALESCE(d.title, '') AS title, " +
          "COALESCE(d.description, '') AS description " +
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
        const snapshotSeq = this.snapshotThroughSeq(room);
        const ahead = snapshotSeq !== null && snapshotSeq > seq;
        const stored = ahead ? this.snapshot(room) : null;
        const from = stored?.throughSeq ?? seq;
        return {
          snapshot: stored,
          updates: this.updatesAfter(room, from),
        };
      },
    );

    // Pending watermarks and replica positions are one SQLite snapshot. Read
    // separately, another process could append and release a room between the
    // two reads, leaving neither half able to prove this replica is behind.
    this.syncSnapshotTx = transactional(
      this.db,
      (positions: readonly RoomLogPosition[]): StoreSyncSnapshot => {
        const unappliedRooms = new Set<string>();
        for (const { room, throughSeq } of positions) {
          if (
            this.statements.snapshotAfter.get(room, throughSeq) !== undefined ||
            this.statements.updateAfter.get(room, throughSeq) !== undefined
          ) {
            unappliedRooms.add(room);
          }
        }
        return { pendingRooms: this.pendingRooms(), unappliedRooms };
      },
    );

    this.indexTx = transactional(this.db, (
      doc: IndexedDoc,
      throughSeq: number,
      catalogThroughSeq: number,
    ) => {
      // The guarded row is both the directory metadata and the generation
      // marker for every dependent row below. A stale derivation loses before
      // it can delete anything; the winner and all of its rows commit together.
      const written =
        this.statements.advanceIndex.run(
          doc.uuid,
          throughSeq,
          catalogThroughSeq,
        ).changes > 0;
      if (!written) {
        return;
      }
      this.statements.putDoc.run(doc.uuid, doc.title, doc.description);
      this.statements.dropTags.run(doc.uuid);
      for (const tag of new Set(doc.tags)) {
        this.statements.putTag.run(doc.uuid, tag);
      }
      this.statements.dropLinks.run(doc.uuid);
      for (const target of new Set(doc.links)) {
        if (target !== doc.uuid) this.statements.putLink.run(doc.uuid, target);
      }
      this.statements.dropFts.run(doc.uuid);
      // The description leads the indexed body, so a description-only match
      // gives a snippet that reads as the description rather than as an
      // unrelated fragment of the document.
      this.statements.putFts.run(
        doc.uuid,
        doc.title,
        doc.description === "" ? doc.body : `${doc.description}\n${doc.body}`,
      );
    });

    this.unindexTx = transactional(this.db, (uuid: string) => {
      this.statements.dropFts.run(uuid);
      this.statements.dropTags.run(uuid);
      this.statements.dropLinks.run(uuid);
      this.statements.dropDoc.run(uuid);
      this.statements.dropIndexSeq.run(uuid);
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
    const seq = this.appendTx(room, payload, origin);
    for (const listener of [...this.appendListeners]) {
      try {
        listener();
      } catch (error) {
        // The update is already committed. An observer cannot turn a durable
        // append into a reported failure or starve the remaining observers.
        log.warn("an update-log append observer failed", error);
      }
    }
    return seq;
  }

  /**
   * Run `listener` after every successful append made through this store
   * instance. Returns an idempotent unsubscribe.
   */
  onAppend(listener: () => void): () => void {
    this.appendListeners.add(listener);
    return () => {
      this.appendListeners.delete(listener);
    };
  }

  /**
   * SQLite's connection-local view of commits made by other connections.
   * Commits made through this instance are intentionally reported by
   * {@link onAppend} instead.
   */
  dataVersion(): number {
    const row = this.statements.dataVersion.get() as {
      data_version: number;
    };
    return Number(row.data_version);
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

  /** Read the snapshot cut without loading its state BLOB. */
  protected snapshotThroughSeq(room: string): number | null {
    const row = this.statements.snapshotSeq.get(room) as
      | { through_seq: number }
      | undefined;
    return row?.through_seq ?? null;
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

  /**
   * Sample the store half of hub acknowledgement without loading update BLOBs.
   *
   * The batch is one read transaction so a peer cannot release the shared
   * pending marker between that read and the check that this replica has
   * applied the store's current cut.
   */
  syncSnapshot(
    positions: readonly RoomLogPosition[],
  ): StoreSyncSnapshot {
    return this.syncSnapshotTx(positions);
  }

  /**
   * Upsert one document's derived rows when they came from a newer log cut.
   *
   * `throughSeq` and `catalogThroughSeq` are the highest contiguous document
   * and settings log cuts used for the derivation. The metadata row, both cuts
   * and every dependent row land in one transaction, so a derivation stale on
   * either input cannot replace one newer on both.
   */
  indexDoc(
    doc: IndexedDoc,
    throughSeq: number,
    catalogThroughSeq = 0,
  ): void {
    this.indexTx(doc, throughSeq, catalogThroughSeq);
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
    transactional(this.db, () => {
      this.db.exec(
        "DELETE FROM doc_index; DELETE FROM doc_index_seq; DELETE FROM doc_tags; " +
          "DELETE FROM doc_links; DELETE FROM docs_fts;",
      );
    })();
  }

  search(query: string, limit: number, tag?: string): SearchHit[] {
    const match = ftsQuery(query);
    if (match === null) {
      return [];
    }
    const rows = this.statements.search.all(
      match,
      tag ?? null,
      tag ?? null,
      limit,
    ) as {
      uuid: string;
      title: string;
      description: string;
      snippet: string;
      tags: string | null;
    }[];
    return rows.map((row) => ({
      uuid: row.uuid,
      title: row.title,
      tags: parseTags(row.tags),
      description: row.description === "" ? null : row.description,
      snippet: row.snippet === "" ? row.title : row.snippet,
    }));
  }

  /** Documents whose `links` name `uuid`. */
  backlinks(
    uuid: string,
  ): { uuid: string; title: string; description: string | null }[] {
    const rows = this.statements.backlinks.all(uuid) as {
      uuid: string;
      title: string;
      description: string;
    }[];
    return rows.map((row) => ({
      uuid: row.uuid,
      title: row.title,
      description: row.description === "" ? null : row.description,
    }));
  }

  /**
   * Bind this file to one workspace, or refuse to open it.
   *
   * The derived index has no workspace column and room keys are opaque to the
   * store, so the file is the only thing separating two corpora — and
   * `UBERBLICK_DB` outranks the per-workspace default path silently. Two
   * servers pinned to different workspaces at one database would union their
   * corpora in `search` and `backlinks`. Recording the workspace makes the file
   * self-describing, so the second one to open says so and stops.
   *
   * It runs before the rest of the schema, on the one table it needs, so that
   * a refused open leaves the other workspace's file byte-identical.
   *
   * The insert is `DO NOTHING` and the recorded value is read back after it:
   * two processes creating one database at once both try, one wins, and the
   * loser refuses rather than overwriting the claim.
   *
   * A database from before this row existed is adopted rather than refused —
   * there is exactly one workspace it can belong to, the one whose server is
   * opening it, and refusing would strand a corpus that is not in fact
   * ambiguous. It is stamped once and is an ordinary file afterwards.
   */
  private claimWorkspace(workspaceId: string, preexisting: boolean): void {
    const claimed = this.db
      .prepare(
        "INSERT INTO meta (key, value) VALUES ('workspace', ?) " +
          "ON CONFLICT (key) DO NOTHING",
      )
      .run(workspaceId).changes;
    const row = this.db
      .prepare("SELECT value FROM meta WHERE key = 'workspace'")
      .get() as { value: string } | undefined;
    const recorded = row?.value;

    if (recorded !== workspaceId) {
      this.close();
      throw new Error(
        `${this.databasePath} is the replica of workspace ${recorded ?? "unknown"}, ` +
          `but this server is configured for workspace ${workspaceId}. One ` +
          "database holds one workspace: unset UBERBLICK_DB to use the " +
          "per-workspace default file, or point it at a different path.",
      );
    }
    if (claimed > 0 && preexisting) {
      log.info("adopted a database that recorded no workspace", {
        database: this.databasePath,
        workspace: workspaceId,
      });
    }
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
   * Add `doc_index.description` to a database written before descriptions
   * existed.
   *
   * A plain `ADD COLUMN` with a default, because `doc_index` is an ordinary
   * table and the column starts empty for every row — which is exactly true:
   * no document had a description before this migration, and each one's row is
   * rewritten the moment it gets one. Nothing is dropped and no rebuild is
   * needed, which is why the description rides `docs_fts.body` rather than a
   * column FTS5 cannot add.
   */
  private migrateDocDescription(): void {
    const columns = this.db
      .prepare("SELECT name FROM pragma_table_info('doc_index')")
      .all() as { name: string }[];
    if (columns.some((column) => column.name === "description")) {
      return;
    }
    this.db.exec(
      "ALTER TABLE doc_index ADD COLUMN description TEXT NOT NULL DEFAULT ''",
    );
  }

  /**
   * Add the catalog half of the derived-index generation.
   *
   * Tag rows now depend on two replicas: the document that stores assignments
   * and the settings document that resolves aliases to canonical identities.
   * Existing rows were derived without that second cut, so zero is their exact
   * starting value and the next catalog-aware pass replaces them.
   */
  private migrateCatalogIndexSequence(): void {
    const columns = this.db
      .prepare("SELECT name FROM pragma_table_info('doc_index_seq')")
      .all() as { name: string }[];
    if (columns.some((column) => column.name === "catalog_through_seq")) {
      return;
    }
    this.db.exec(
      "ALTER TABLE doc_index_seq ADD COLUMN catalog_through_seq INTEGER NOT NULL DEFAULT 0",
    );
  }

  /**
   * Idempotent, because a store outlives no single owner: the server closes it
   * on shutdown and whoever handed it in may close it again. `node:sqlite`
   * throws on a second close where better-sqlite3 shrugged, and a teardown path
   * is the worst place to learn that.
   */
  close(): void {
    this.appendListeners.clear();
    if (this.db.isOpen) {
      this.db.close();
    }
  }
}
