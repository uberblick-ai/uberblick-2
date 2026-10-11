import { chmodSync, existsSync } from "node:fs";
import { dirname } from "node:path";
// Decision: 90ce6355-9455-4e18-aa56-eb2347e57d6d
import { DatabaseSync } from "node:sqlite";
import { createDataDirectory } from "@uberblick/mcp-server/storage";
import { getWorkspaceName, settingsRoom } from "@uberblick/schema";
import * as Y from "yjs";
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
 * Initial WAL conversion bypasses SQLite's busy handler. Retry only this
 * startup pragma, within the same timeout, so simultaneous creators can open.
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

/** Both origins are logged; only local updates also raise the pending watermark. */
export type UpdateOrigin = "local" | "remote";

export interface LoggedUpdate {
  seq: number;
  payload: Uint8Array;
}

/** Yjs v1 state, compatible with hub persistence and schema replay. */
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
  /** GitHub items linked by a decision's prose, as normalized owner/repo#n. */
  githubRefs?: readonly string[];
  /** The document's block text, concatenated, for full-text search. */
  body: string;
}

export interface SearchHit {
  uuid: string;
  title: string;
  tags: string[];
  /** The document's description, or null when it has none. */
  description: string | null;
  /** Body excerpt (possibly its leading description), or title for a title match. */
  snippet: string;
}

/**
 * Release only through the acknowledged local watermark; a quiet process must
 * not clear work a peer appended after its last poll.
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

/** Parse packed catalog IDs without ambiguous in-band separators. */
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
 * File facts cannot be rebuilt from documents. Workspace binds the corpus;
 * last_sync_at is the machine's latest hub acknowledgement in epoch ms, not
 * hub storage. The serving holder row is diagnostic; its separate live lock
 * supplies authority. Run only this schema before claimWorkspace checks ownership.
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
  catalog_through_seq INTEGER NOT NULL DEFAULT 0,
  github_refs_indexed INTEGER NOT NULL DEFAULT 0
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
CREATE TABLE IF NOT EXISTS decision_github_refs (
  source TEXT NOT NULL,
  target TEXT NOT NULL,
  PRIMARY KEY (source, target)
);
CREATE INDEX IF NOT EXISTS decision_github_refs_target ON decision_github_refs (target);

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

/** Quote tokens as literal search terms; only trailing * retains FTS5 operator meaning. */
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

/** node:sqlite's array bindings check neither arity nor order; declare both here. */
interface Prepared<P extends SQLInputValue[]> {
  run(...params: P): StatementResultingChanges;
  get(...params: P): Record<string, SQLOutputValue> | undefined;
  all(...params: P): Record<string, SQLOutputValue>[];
}

/**
 * Deferred reads pin a snapshot without blocking writers; writes enter the
 * queue on their first statement. Immediate migrations lock before checking.
 * Do not nest wrappers: BEGIN fails before try and leaves the outer transaction
 * intact to roll back. A successful body commits; a thrown body rolls back.
 */
function transactional<A extends unknown[], R>(
  db: DatabaseSync,
  body: (...args: A) => R,
  mode: "deferred" | "immediate" = "deferred",
): (...args: A) => R {
  return (...args: A): R => {
    db.exec(mode === "immediate" ? "BEGIN IMMEDIATE" : "BEGIN");
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

/**
 * Inspect an existing local replica without constructing a store: that would
 * create files, claim the workspace and migrate its schema. Names are optional;
 * a missing, old or unreadable database must not hide its workspace from a list.
 */
export function readWorkspaceName(databasePath: string, workspaceId: string): string | null {
  const doc = new Y.Doc();
  try {
    const db = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const room = settingsRoom(workspaceId);
      // Like readSinceTx, pin snapshot and tail to one log state. A concurrent
      // compactor may replace and prune the tail between these two queries.
      const { snapshot, updates } = transactional(db, () => {
        const snapshot = db.prepare(
          "SELECT state, through_seq FROM snapshots WHERE room = ?",
        ).get(room);
        const updates = db.prepare(
          "SELECT payload FROM updates WHERE room = ? AND seq > ? ORDER BY seq",
        ).all(room, snapshot?.through_seq ?? 0);
        return { snapshot, updates };
      })();
      if (snapshot !== undefined) {
        Y.applyUpdate(doc, snapshot.state as Uint8Array);
      }
      for (const update of updates) {
        Y.applyUpdate(doc, update.payload as Uint8Array);
      }
      return getWorkspaceName(doc);
    } finally {
      db.close();
    }
  } catch {
    return null;
  } finally {
    doc.destroy();
  }
}

/**
 * Check an existing replica without opening the write-capable store. Replaying
 * into bare Y.Docs validates its authoritative state without replica repairs,
 * and absent tables or workspace claims remain valid pre-migration states.
 */
export function inspectExistingStore(databasePath: string, workspaceId: string): void {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    transactional(db, () => {
      const checks = db.prepare("PRAGMA quick_check").all();
      if (checks.some((check) => Object.values(check).some((value) => value !== "ok"))) {
        throw new Error("The database failed SQLite's integrity check.");
      }
      const tables = new Set(
        (db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all() as { name: string }[])
          .map((table) => table.name),
      );
      if (tables.has("meta")) {
        const row = db.prepare("SELECT value FROM meta WHERE key = 'workspace'").get();
        const recorded = row?.value;
        if (recorded !== undefined && recorded !== workspaceId) {
          throw new Error(
            `${databasePath} is the replica of workspace ${recorded ?? "unknown"}, ` +
              `but this server is configured for workspace ${workspaceId}. One ` +
              "database holds one workspace: unset UBERBLICK_DB to use the " +
              "per-workspace default file, or point it at a different path.",
          );
        }
      }
      const roomQueries = [];
      const snapshot = tables.has("snapshots")
        ? db.prepare("SELECT state, through_seq FROM snapshots WHERE room = ?")
        : null;
      const updates = tables.has("updates")
        ? db.prepare("SELECT payload FROM updates WHERE room = ? AND seq > ? ORDER BY seq")
        : null;
      if (snapshot !== null) roomQueries.push("SELECT room FROM snapshots");
      if (updates !== null) roomQueries.push("SELECT room FROM updates");
      if (roomQueries.length === 0) return;

      const rooms = db.prepare(roomQueries.join(" UNION ")).all() as { room: string }[];
      for (const { room } of rooms) {
        const doc = new Y.Doc();
        try {
          const stored = snapshot?.get(room);
          if (stored !== undefined) Y.applyUpdate(doc, stored.state as Uint8Array);
          for (const update of updates?.all(room, stored?.through_seq ?? 0) ?? []) {
            Y.applyUpdate(doc, update.payload as Uint8Array);
          }
        } finally {
          doc.destroy();
        }
      }
    })();
  } finally {
    db.close();
  }
}

export class MirrorStore {
  readonly databasePath: string;

  private readonly db: DatabaseSync;

  /**
   * Wake after same-process commits: data_version detects only other connections,
   * and a replica engine cannot rely on MCP calls arriving to discover changes.
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
    dropGithubRefs: Prepared<[string]>;
    putGithubRef: Prepared<[string, string]>;
    dropFts: Prepared<[string]>;
    putFts: Prepared<[string, string, string]>;
    search: Prepared<[string, string | null, string | null, number]>;
    backlinks: Prepared<[string]>;
    decisionsForGithub: Prepared<[string]>;
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

  // biome-ignore lint/complexity/noExcessiveLinesPerFunction: This function predates the length limit.
  constructor(databasePath: string, workspaceId: string) {
    this.databasePath = databasePath;
    // Owner-only: this tree holds the corpus and may later receive credentials.
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
    // Keep write transactions small; peer replicas catch up by polling the log.
    this.db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    enableWal(this.db);
    this.db.exec("PRAGMA foreign_keys = ON");
    // Check before schema creation to distinguish adoption from a new database.
    const preexisting =
      this.db
        .prepare(
          "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'updates'",
        )
        .get() !== undefined;
    // Refuse foreign workspaces before any corpus schema, index or migration writes.
    this.db.exec(META_SCHEMA);
    this.claimWorkspace(workspaceId, preexisting);
    this.db.exec(SCHEMA);
    // After the schema, so the backfill can read `updates` and `snapshots`.
    this.migratePendingRooms();
    this.migrateDocDescription();
    this.migrateCatalogIndexSequence();
    this.migrateGithubRefsIndexSequence();

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
      // Never replace a newer snapshot after its source rows have been pruned.
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
        "INSERT INTO doc_index_seq (uuid, indexed_through_seq, catalog_through_seq, github_refs_indexed) VALUES (?, ?, ?, 1) " +
          "ON CONFLICT (uuid) DO UPDATE SET " +
          "indexed_through_seq = excluded.indexed_through_seq, " +
          "catalog_through_seq = excluded.catalog_through_seq, " +
          "github_refs_indexed = excluded.github_refs_indexed " +
          "WHERE doc_index_seq.indexed_through_seq <= excluded.indexed_through_seq " +
          "AND doc_index_seq.catalog_through_seq <= excluded.catalog_through_seq " +
          "AND (doc_index_seq.indexed_through_seq < excluded.indexed_through_seq " +
          "OR doc_index_seq.catalog_through_seq < excluded.catalog_through_seq " +
          "OR doc_index_seq.github_refs_indexed = 0)",
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
      dropGithubRefs: prepare("DELETE FROM decision_github_refs WHERE source = ?"),
      putGithubRef: prepare(
        "INSERT INTO decision_github_refs (source, target) VALUES (?, ?) ON CONFLICT DO NOTHING",
      ),
      dropFts: prepare("DELETE FROM docs_fts WHERE uuid = ?"),
      putFts: prepare(
        "INSERT INTO docs_fts (uuid, title, body) VALUES (?, ?, ?)",
      ),
      // Pack unambiguous JSON IDs into each hit to keep search to one query.
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
      decisionsForGithub: prepare(
        "SELECT r.source AS uuid, d.title AS title " +
          "FROM decision_github_refs r JOIN doc_index d ON d.uuid = r.source " +
          "WHERE r.target = ? ORDER BY title, r.source",
      ),
    };

    // AUTOINCREMENT follows serialized writer commits, so replay cannot miss
    // an earlier seq arriving later. Commit local updates and pending markers
    // together so even SIGKILL leaves offline work discoverable for pushing.
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

    // Atomically snapshot then prune: a crash must not drop uncovered updates.
    // Monotonic upserts leave a snapshot covering the cut even if this write loses.
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

    // Pin snapshot and tail together so concurrent compaction cannot prune an
    // unseen gap that a reader then advances past.
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

    // Pin pending watermarks and unapplied cuts together: a peer append/release
    // between separate reads could otherwise conceal that this replica is behind.
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
      // Reject stale cuts before deleting rows; the winning cuts, metadata and
      // dependent rows must commit together.
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
      this.statements.dropGithubRefs.run(doc.uuid);
      for (const target of new Set(doc.githubRefs ?? [])) {
        this.statements.putGithubRef.run(doc.uuid, target);
      }
      this.statements.dropFts.run(doc.uuid);
      // Leading descriptions let description-only matches return relevant snippets.
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
      this.statements.dropGithubRefs.run(uuid);
      this.statements.dropDoc.run(uuid);
      this.statements.dropIndexSeq.run(uuid);
    });
  }

  /**
   * Commit both origins synchronously before a mutating tool returns; local
   * updates raise the pending watermark atomically. Payloads must be Yjs v1,
   * matching hub persistence and schema, never v2. Return the committed seq.
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

  /** Detect foreign commits; same-connection commits use onAppend instead. */
  dataVersion(): number {
    const row = this.statements.dataVersion.get() as {
      data_version: number;
    };
    return Number(row.data_version);
  }

  /** Last caught-up time on this machine, or null for a replica predating it. */
  readLastSync(): number | null {
    const row = this.db
      .prepare("SELECT value FROM meta WHERE key = 'last_sync_at'")
      .get() as { value: string } | undefined;
    if (row === undefined) return null;
    const timestamp = Number(row.value);
    if (
      !Number.isSafeInteger(timestamp) ||
      Number.isNaN(new Date(timestamp).getTime())
    ) {
      throw new Error("invalid last_sync_at timestamp");
    }
    return timestamp;
  }

  /**
   * Advance the shared acknowledgement time in one SQLite statement. A stale
   * process or a clock behind the stored time cannot overwrite a newer reading.
   * Metadata statements are prepared here so their failures remain isolated by
   * the caller, rather than preventing the replica from opening.
   */
  recordLastSync(timestamp: number): void {
    this.db
      .prepare(
        "INSERT INTO meta (key, value) VALUES ('last_sync_at', ?) " +
          "ON CONFLICT (key) DO UPDATE SET value = excluded.value " +
          "WHERE CAST(meta.value AS INTEGER) < CAST(excluded.value AS INTEGER)",
      )
      .run(String(timestamp));
  }

  /**
   * Replay through this consistent snapshot-plus-tail read; separate reads can
   * lose unseen updates to concurrent compaction. Apply an ahead snapshot first.
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
   * throughSeq must be applied to the document supplying state; keep later rows.
   * Return false if the stored snapshot already covers the cut, retaining its
   * state but still pruning the prefix it covers.
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

  /** Clear only acknowledged throughSeq; leave newer peer updates pending. */
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
   * Sample pending and applied cuts in one transaction without update BLOBs;
   * a peer releasing a marker must not conceal an unapplied cut.
   */
  syncSnapshot(
    positions: readonly RoomLogPosition[],
  ): StoreSyncSnapshot {
    return this.syncSnapshotTx(positions);
  }

  /**
   * Derive from contiguous document and settings cuts; stale input on either
   * must not replace newer rows. Commit cuts, metadata and dependents together;
   * allow one equal-cut replacement for rows lacking GitHub-reference derivation.
   */
  indexDoc(
    doc: IndexedDoc,
    throughSeq: number,
    catalogThroughSeq = 0,
  ): void {
    this.indexTx(doc, throughSeq, catalogThroughSeq);
  }

  /** Check before deleting: this WAL read avoids busy-timeout waits for absent rows. */
  isIndexed(uuid: string): boolean {
    return this.statements.hasDoc.get(uuid) !== undefined;
  }

  /** Archived docs must leave search, but retain their authoritative room log. */
  unindexDoc(uuid: string): void {
    this.unindexTx(uuid);
  }

  /** All index rows are disposable caches; rebuild from log-hydrated replicas. */
  clearDerived(): void {
    transactional(this.db, () => {
      this.db.exec(
        "DELETE FROM doc_index; DELETE FROM doc_index_seq; DELETE FROM doc_tags; " +
          "DELETE FROM doc_links; DELETE FROM decision_github_refs; DELETE FROM docs_fts;",
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

  /** Indexed decision records linking one normalized GitHub item, by title then UUID. */
  decisionsForGithub(key: string): { uuid: string; title: string }[] {
    return this.statements.decisionsForGithub.all(key) as {
      uuid: string;
      title: string;
    }[];
  }

  /**
   * The file isolates corpora: indexes lack workspace columns and room keys are
   * opaque, even when UBERBLICK_DB overrides the default path. Claim before
   * corpus schema writes; insert-if-absent then read back so concurrent openers
   * cannot overwrite another workspace. Adopt an unclaimed legacy file once.
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
   * Preserve legacy pending flags: a room may lack a directory stub after a
   * crash and otherwise never attach or push. Use its highest log seq, snapshot
   * cut or zero as unacknowledged; duplicate pushes are safe, lost writes are not.
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
   * An empty description default preserves rows without a rebuild. FTS5 cannot
   * add columns, so descriptions join body and reindex as each document changes.
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
   * Tags depend on document assignments and settings alias resolution. Rows
   * lacking a catalog cut start at zero so catalog-aware derivation replaces them.
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
   * Mark missing GitHub derivation for one equal-cut replacement without
   * clearing cuts and admitting stale replicas. indexTx commits flag and rows
   * together; reopening must not reset the flag.
   */
  private migrateGithubRefsIndexSequence(): void {
    const hasFlag = (): boolean => {
      const columns = this.db
        .prepare("SELECT name FROM pragma_table_info('doc_index_seq')")
        .all() as { name: string }[];
      return columns.some((column) => column.name === "github_refs_indexed");
    };
    if (hasFlag()) {
      return;
    }
    // Simultaneous startups can both see the old schema. Take the write lock
    // before checking again, so only the winner attempts the alteration.
    transactional(
      this.db,
      () => {
        if (!hasFlag()) {
          this.db.exec(
            "ALTER TABLE doc_index_seq ADD COLUMN github_refs_indexed INTEGER NOT NULL DEFAULT 0",
          );
        }
      },
      "immediate",
    )();
  }

  /** Both server shutdown and the supplying owner may close; keep it idempotent. */
  close(): void {
    this.appendListeners.clear();
    if (this.db.isOpen) {
      this.db.close();
    }
  }
}
