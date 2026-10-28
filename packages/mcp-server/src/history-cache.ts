import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { RevisionEntry } from "@uberblick/schema";
import { readHubLogins } from "./auth-store.js";
import { HistoryHoldSession } from "./history-holds.js";
import { selectHistorySnapshots } from "./history-retention.js";
import { tryAcquireInitLock } from "./init-lock.js";
import type { HistoryRetention } from "./local-settings.js";
import { authenticationOrigin, hubIdentity } from "./remote-url.js";
import { readWorkspaceHub } from "./workspace-registry.js";
import { captureWorkspaceDetachGeneration, workspaceDetachGeneration } from "./workspace-generation.js";

export const HISTORY_CACHE_FORMAT = 1;
const CHUNK_BYTES = 64 * 1024;
const RETRY_TIMEOUT_MS = 2_000;
const TABLES = ["history_v1_catalog_chunks", "history_v1_snapshot_chunks", "history_v1_snapshots",
  "history_v1_pages", "history_v1_holds", "history_v1_deleted"] as const;
const HEADER = `CREATE TABLE IF NOT EXISTS history_cache (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1), format INTEGER NOT NULL,
  generation TEXT NOT NULL, hub TEXT NOT NULL, workspace TEXT NOT NULL, account TEXT NOT NULL
)`;
// Each format owns its physical tables. The stable header is checked before
// preparing statements, so an older client never interprets a newer layout.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS history_v1_pages (
  generation TEXT NOT NULL, uuid TEXT NOT NULL, catalog TEXT NOT NULL,
  version TEXT, refreshed_at INTEGER, complete INTEGER NOT NULL, failed INTEGER NOT NULL,
  PRIMARY KEY (generation, uuid)
);
CREATE TABLE IF NOT EXISTS history_v1_catalog_chunks (
  generation TEXT NOT NULL, uuid TEXT NOT NULL, catalog TEXT NOT NULL,
  part INTEGER NOT NULL, bytes BLOB NOT NULL,
  PRIMARY KEY (generation, uuid, catalog, part)
);
CREATE TABLE IF NOT EXISTS history_v1_snapshots (
  generation TEXT NOT NULL, uuid TEXT NOT NULL, revision TEXT NOT NULL,
  download TEXT NOT NULL, checksum TEXT NOT NULL, byte_length INTEGER NOT NULL,
  PRIMARY KEY (generation, uuid, revision)
);
CREATE TABLE IF NOT EXISTS history_v1_snapshot_chunks (
  generation TEXT NOT NULL, uuid TEXT NOT NULL, revision TEXT NOT NULL,
  download TEXT NOT NULL, part INTEGER NOT NULL, bytes BLOB NOT NULL,
  PRIMARY KEY (generation, uuid, revision, download, part)
);
CREATE TABLE IF NOT EXISTS history_v1_holds (
  generation TEXT NOT NULL, uuid TEXT NOT NULL, revision TEXT NOT NULL, session TEXT NOT NULL,
  PRIMARY KEY (generation, uuid, revision, session)
);
CREATE TABLE IF NOT EXISTS history_v1_deleted (
  generation TEXT NOT NULL, uuid TEXT NOT NULL, PRIMARY KEY (generation, uuid)
);`;

/** The caller owns the workspace write transaction and configuration lock. */
export function discardDownloadedHistory(db: DatabaseSync): void {
  const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all();
  for (const { name } of tables) {
    if (name === "history_cache" || (typeof name === "string" &&
      /^history_v[0-9]+_(?:catalog_chunks|snapshot_chunks|snapshots|pages|holds|deleted)$/.test(name))) {
      db.exec(`DELETE FROM ${name}`);
    }
  }
}

export interface HistoryCacheStamp { hub: string; workspace: string; account: string }
export interface HistoryCacheFileIdentity { dev: number; ino: number }
export interface HistoryCacheToken extends HistoryCacheStamp { generation: string }
export type HistoryCacheResult<T> = { status: "ready"; value: T }
  | { status: "unavailable" | "update-required" | "superseded" };
export interface CachedHistoryCatalog {
  revisions: RevisionEntry[];
  version: string | null;
  refreshedAt: number | null;
  complete: boolean;
  failed: boolean;
  /** Opaque local publication identity; not the hub's version token. */
  catalog: string;
}
type Header = HistoryCacheToken & { format: number };
class CacheRefusal extends Error {
  constructor(readonly status: "unavailable" | "update-required" | "superseded") { super(status); }
}
const waiter = new Int32Array(new SharedArrayBuffer(4));
function busy(error: unknown): boolean {
  const code = (error as { errcode?: number })?.errcode;
  return typeof code === "number" && (code & 255) === 5;
}
function chunks(bytes: Uint8Array): Uint8Array[] {
  const result: Uint8Array[] = [];
  for (let offset = 0; offset < bytes.length; offset += CHUNK_BYTES) {
    result.push(bytes.slice(offset, offset + CHUNK_BYTES));
  }
  return result;
}

/** Disposable storage uses its own connection and never participates in a document transaction. */
export class HistoryCache {
  private db: DatabaseSync | undefined;
  private session: HistoryHoldSession | undefined;
  private identity: HistoryCacheFileIdentity | null | undefined;
  private closed = false;
  private readonly localHolds = new Map<string, number>();
  private readonly detachGeneration: string | null;

  constructor(private readonly path: string, private readonly workspace: string,
    private readonly env: NodeJS.ProcessEnv = process.env, identity?: HistoryCacheFileIdentity | null,
    detachGeneration = captureWorkspaceDetachGeneration(path)) {
    this.identity = identity;
    this.detachGeneration = detachGeneration;
  }

  private connection(): DatabaseSync {
    if (this.closed || this.path === ":memory:" || this.identity === null) throw new CacheRefusal("unavailable");
    const identity = statSync(this.path);
    if (this.identity !== undefined && (identity.dev !== this.identity.dev || identity.ino !== this.identity.ino)) {
      throw new CacheRefusal("unavailable");
    }
    if (this.db === undefined) {
      const db = new DatabaseSync(this.path);
      try {
        db.exec("PRAGMA busy_timeout = 0");
        if (db.prepare("SELECT value FROM meta WHERE key = 'workspace'").get()?.value !== this.workspace) {
          throw new CacheRefusal("unavailable");
        }
        this.identity = identity;
        this.db = db;
      } catch (error) { db.close(); throw error; }
    }
    if (workspaceDetachGeneration(this.db) !== this.detachGeneration) throw new CacheRefusal("superseded");
    return this.db;
  }

  private result<T>(action: () => T): HistoryCacheResult<T> {
    try { return { status: "ready", value: action() }; }
    catch (error) { return { status: error instanceof CacheRefusal ? error.status : "unavailable" }; }
  }

  private header(): Header | null {
    const db = this.connection();
    if (!db.prepare("SELECT 1 FROM sqlite_schema WHERE name = 'history_cache' AND type = 'table'").get()) return null;
    const row = db.prepare("SELECT format, generation, hub, workspace, account FROM history_cache WHERE singleton = 1").get();
    if (row === undefined) return null;
    if (typeof row.format !== "number" || !Number.isSafeInteger(row.format)) throw new CacheRefusal("unavailable");
    if (row.format > HISTORY_CACHE_FORMAT) throw new CacheRefusal("update-required");
    return row as unknown as Header;
  }

  private check(token: HistoryCacheToken): void {
    const current = this.header();
    if (current?.format !== HISTORY_CACHE_FORMAT || current.generation !== token.generation ||
      current.hub !== token.hub || current.workspace !== token.workspace || current.account !== token.account) {
      throw new CacheRefusal("superseded");
    }
  }

  /** Opening holds the init lock; token operations also fence against the SQLite generation. */
  private authority(stamp: HistoryCacheStamp, existing: Header | null): void {
    const hub = readWorkspaceHub(this.workspace, this.env);
    if (stamp.workspace !== this.workspace || hub === undefined || hub === null || hubIdentity(hub) !== stamp.hub) {
      throw new CacheRefusal("superseded");
    }
    const logins = readHubLogins(this.env);
    const origin = authenticationOrigin(hub);
    if (logins.state === "unreadable" || logins.state === "refused" || logins.unreadableHubs.includes(origin)) {
      throw new CacheRefusal("unavailable");
    }
    const account = logins.logins[origin]?.identity.githubAccountId;
    if (account !== undefined ? account !== stamp.account : existing?.account !== stamp.account || existing.hub !== stamp.hub) {
      throw new CacheRefusal("superseded");
    }
  }

  private write<T>(token: HistoryCacheToken | null, action: (db: DatabaseSync) => T,
    stamp?: HistoryCacheStamp | false): T {
    const deadline = Date.now() + RETRY_TIMEOUT_MS;
    for (;;) {
      let lock: ReturnType<typeof tryAcquireInitLock> = null;
      const db = this.connection();
      try {
        // Detect a future format before schema preparation, configuration checks or writes.
        this.header();
        if (stamp !== undefined && stamp !== false) {
          lock = tryAcquireInitLock(this.env);
          if (lock === null) {
            if (Date.now() >= deadline) throw new CacheRefusal("unavailable");
            Atomics.wait(waiter, 0, 0, 2);
            continue;
          }
        }
        if (stamp !== false && (stamp !== undefined || token !== null)) {
          this.authority(stamp ?? token as HistoryCacheToken, this.header());
        }
        db.exec("BEGIN IMMEDIATE");
        try {
          if (workspaceDetachGeneration(db) !== this.detachGeneration) throw new CacheRefusal("superseded");
          this.header();
          if (token !== null) this.check(token);
          const value = action(db);
          db.exec("COMMIT");
          return value;
        } catch (error) {
          if (db.isTransaction) db.exec("ROLLBACK");
          throw error;
        }
      } catch (error) {
        if (!busy(error) || Date.now() >= deadline) throw error;
      } finally { lock?.release(); }
      Atomics.wait(waiter, 0, 0, 2);
    }
  }

  private read<T>(token: HistoryCacheToken, action: (db: DatabaseSync) => T, purge = false): T {
    const db = this.connection();
    if (!purge) this.authority(token, this.header());
    db.exec("BEGIN");
    try {
      this.check(token);
      const value = action(db);
      db.exec("COMMIT");
      return value;
    } catch (error) {
      if (db.isTransaction) db.exec("ROLLBACK");
      throw error;
    }
  }

  /** Resume the retained stamp after sign-out, still checking the current binding and login. */
  resume(): HistoryCacheResult<HistoryCacheToken | null> {
    return this.result(() => {
      const header = this.header();
      if (header === null) return null;
      const opened = this.open({ hub: header.hub, workspace: header.workspace, account: header.account });
      if (opened.status !== "ready") throw new CacheRefusal(opened.status);
      return opened.value;
    });
  }

  open(stamp: HistoryCacheStamp): HistoryCacheResult<HistoryCacheToken> {
    return this.result(() => {
      const normalized = { ...stamp, hub: hubIdentity(stamp.hub) };
      const token = this.write(null, db => {
        const previous = this.header();
        db.exec(HEADER);
        db.exec(SCHEMA);
        if (previous?.format === HISTORY_CACHE_FORMAT && previous.hub === normalized.hub &&
          previous.workspace === normalized.workspace && previous.account === normalized.account) return previous;
        const next = { ...normalized, generation: randomUUID() };
        db.prepare("INSERT OR REPLACE INTO history_cache VALUES (1, ?, ?, ?, ?, ?)")
          .run(HISTORY_CACHE_FORMAT, next.generation, next.hub, next.workspace, next.account);
        return next;
      }, normalized);
      this.cleanObsolete(token);
      this.cleanPriorFormats(token);
      this.collectGarbage(token);
      return { hub: token.hub, workspace: token.workspace, account: token.account, generation: token.generation };
    });
  }

  private cleanObsolete(token: HistoryCacheToken): void {
    for (const table of TABLES) this.deleteRows(token, table, "generation <> ?", [token.generation]);
  }

  private cleanPriorFormats(token: HistoryCacheToken): void {
    const tables = this.read(token, db => db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all());
    for (const { name } of tables) {
      if (typeof name !== "string") continue;
      const version = /^history_v([0-9]+)_(?:catalog_chunks|snapshot_chunks|snapshots|pages|holds|deleted)$/.exec(name);
      if (version !== null && Number(version[1]) < HISTORY_CACHE_FORMAT) {
        this.deleteRows(token, name, "1", []);
      }
    }
  }

  private deleteRows(token: HistoryCacheToken, table: string, where: string,
    values: SQLInputValue[], purge = false): void {
    for (;;) {
      const row = this.read(token, db => db.prepare(`SELECT rowid FROM ${table} WHERE ${where} LIMIT 1`).get(...values), purge);
      if (row === undefined) return;
      this.write(token, current => current.prepare(
        `DELETE FROM ${table} WHERE rowid = ? AND (${where})`,
      ).run(row.rowid as number, ...values), purge ? false : undefined);
      // Release the write lock between chunks so document writers can make progress.
      Atomics.wait(waiter, 0, 0, 1);
    }
  }

  private pagePresent(db: DatabaseSync, token: HistoryCacheToken, uuid: string): void {
    if (db.prepare("SELECT 1 FROM history_v1_deleted WHERE generation = ? AND uuid = ?").get(token.generation, uuid)) {
      throw new CacheRefusal("superseded");
    }
  }

  /** Unpublished chunks can survive a crashed downloader; live staging holds protect them. */
  private collectGarbage(token: HistoryCacheToken): void {
    const candidates = this.read(token, db => [
      ...db.prepare("SELECT c.rowid, c.uuid, c.catalog AS publication FROM history_v1_catalog_chunks c WHERE c.generation = ? " +
        "AND NOT EXISTS (SELECT 1 FROM history_v1_pages p WHERE p.generation = c.generation AND p.uuid = c.uuid AND p.catalog = c.catalog)")
        .all(token.generation).map(row => ({ row, kind: "catalog" as const })),
      ...db.prepare("SELECT c.rowid, c.uuid, c.revision, c.download AS publication FROM history_v1_snapshot_chunks c WHERE c.generation = ? " +
        "AND NOT EXISTS (SELECT 1 FROM history_v1_snapshots s WHERE s.generation = c.generation AND s.uuid = c.uuid AND s.revision = c.revision AND s.download = c.download)")
        .all(token.generation).map(row => ({ row, kind: "snapshot" as const })),
    ]);
    const recordedHolds = this.read(token, db => db.prepare("SELECT rowid, session FROM history_v1_holds WHERE generation = ?")
      .all(token.generation));
    if (candidates.length === 0 && recordedHolds.length === 0) return;
    this.session ??= new HistoryHoldSession(this.path);
    const session = this.session;
    const deadSessions = new Set(recordedHolds.map(hold => hold.session as string).filter(id => !session.isAlive(id)));
    for (const hold of recordedHolds) {
      if (!deadSessions.has(hold.session as string)) continue;
      this.write(token, db => db.prepare("DELETE FROM history_v1_holds WHERE rowid = ? AND generation = ? AND session = ?")
        .run(hold.rowid as number, token.generation, hold.session as string));
    }
    for (const { row, kind } of candidates) {
      const revision = kind === "catalog" ? `catalog:${row.publication}` : row.revision as string;
      const holds = this.read(token, db => db.prepare("SELECT session FROM history_v1_holds WHERE generation = ? AND uuid = ? AND revision = ?")
        .all(token.generation, row.uuid as string, revision));
      const dead = new Set(holds.map(hold => hold.session as string).filter(id => !session.isAlive(id)));
      this.write(token, db => {
        const currentHolds = db.prepare("SELECT session FROM history_v1_holds WHERE generation = ? AND uuid = ? AND revision = ?")
          .all(token.generation, row.uuid as string, revision);
        if (currentHolds.some(hold => !dead.has(hold.session as string))) return;
        const manifest = kind === "catalog" ? "history_v1_pages" : "history_v1_snapshots";
        const column = kind === "catalog" ? "catalog" : "download";
        const revisionFilter = kind === "catalog" ? "" : " AND revision = ?";
        const values: SQLInputValue[] = [token.generation, row.uuid as string, row.publication as string];
        if (kind === "snapshot") values.push(revision);
        if (db.prepare(`SELECT 1 FROM ${manifest} WHERE generation = ? AND uuid = ? AND ${column} = ?${revisionFilter}`)
          .get(...values)) return;
        const table = kind === "catalog" ? "history_v1_catalog_chunks" : "history_v1_snapshot_chunks";
        db.prepare(`DELETE FROM ${table} WHERE rowid = ? AND generation = ? AND ${column} = ?`)
          .run(row.rowid as number, token.generation, row.publication as string);
      });
      Atomics.wait(waiter, 0, 0, 1);
    }
  }

  readCatalog(token: HistoryCacheToken, uuid: string): HistoryCacheResult<CachedHistoryCatalog | null> {
    return this.result(() => {
      const stored = this.read(token, db => {
        if (db.prepare("SELECT 1 FROM history_v1_deleted WHERE generation = ? AND uuid = ?").get(token.generation, uuid)) return null;
        const row = db.prepare("SELECT * FROM history_v1_pages WHERE generation = ? AND uuid = ?").get(token.generation, uuid);
        if (row === undefined) return null;
        const parts = db.prepare("SELECT bytes FROM history_v1_catalog_chunks WHERE generation = ? AND uuid = ? AND catalog = ? ORDER BY part")
          .all(token.generation, uuid, row.catalog as string);
        return { row, parts };
      });
      if (stored === null) return null;
      const { row, parts } = stored;
      const revisions = JSON.parse(Buffer.concat(parts.map(part => part.bytes as Uint8Array)).toString("utf8")) as RevisionEntry[];
      if (!Array.isArray(revisions)) throw new CacheRefusal("unavailable");
      return { revisions, catalog: row.catalog as string, version: row.version as string | null,
        refreshedAt: row.refreshed_at as number | null, complete: row.complete === 1, failed: row.failed === 1 };
    });
  }

  putCatalog(token: HistoryCacheToken, uuid: string, input: Omit<CachedHistoryCatalog, "catalog">): HistoryCacheResult<void> {
    return this.result(() => {
      const parts = chunks(Buffer.from(JSON.stringify(input.revisions)));
      const catalog = randomUUID();
      const previous = this.readCatalog(token, uuid);
      if (previous.status !== "ready") throw new CacheRefusal(previous.status);
      const staging = this.hold(token, uuid, `catalog:${catalog}`);
      if (staging.status !== "ready") throw new CacheRefusal(staging.status);
      try {
        for (const [part, bytes] of parts.entries()) this.write(token, db => {
          this.pagePresent(db, token, uuid);
          db.prepare("INSERT INTO history_v1_catalog_chunks VALUES (?, ?, ?, ?, ?)")
            .run(token.generation, uuid, catalog, part, bytes);
        });
        this.write(token, db => {
          this.pagePresent(db, token, uuid);
          const current = db.prepare("SELECT catalog FROM history_v1_pages WHERE generation = ? AND uuid = ?").get(token.generation, uuid);
          if ((current?.catalog ?? null) !== (previous.value?.catalog ?? null)) throw new CacheRefusal("superseded");
          db.prepare("INSERT OR REPLACE INTO history_v1_pages VALUES (?, ?, ?, ?, ?, ?, ?)")
            .run(token.generation, uuid, catalog, input.version, input.refreshedAt, Number(input.complete), Number(input.failed));
        });
        if (previous.value !== null) this.deleteRows(token, "history_v1_catalog_chunks", "generation = ? AND uuid = ? AND catalog = ?",
          [token.generation, uuid, previous.value.catalog]);
      } finally { staging.value.release(); }
    });
  }

  markRefreshFailed(token: HistoryCacheToken, uuid: string): HistoryCacheResult<void> {
    return this.result(() => this.write(token, db => {
      db.prepare("UPDATE history_v1_pages SET failed = 1 WHERE generation = ? AND uuid = ?").run(token.generation, uuid);
    }));
  }

  hold(token: HistoryCacheToken, uuid: string, revision: string): HistoryCacheResult<{ release(): void }> {
    return this.result(() => {
      this.read(token, db => this.pagePresent(db, token, uuid));
      this.session ??= new HistoryHoldSession(this.path);
      const session = this.session;
      const key = JSON.stringify([token.generation, uuid, revision]);
      this.write(token, db => {
        this.pagePresent(db, token, uuid);
        db.prepare("INSERT OR IGNORE INTO history_v1_holds VALUES (?, ?, ?, ?)").run(token.generation, uuid, revision, session.id);
      });
      this.localHolds.set(key, (this.localHolds.get(key) ?? 0) + 1);
      let released = false;
      return { release: () => {
        if (released) return;
        released = true;
        const remaining = (this.localHolds.get(key) ?? 1) - 1;
        if (remaining > 0) { this.localHolds.set(key, remaining); return; }
        this.localHolds.delete(key);
        this.result(() => this.write(token, db => {
          db.prepare("DELETE FROM history_v1_holds WHERE generation = ? AND uuid = ? AND revision = ? AND session = ?")
            .run(token.generation, uuid, revision, session.id);
        }));
      } };
    });
  }

  putSnapshot(token: HistoryCacheToken, uuid: string, revision: string, checksum: string,
    state: Uint8Array): HistoryCacheResult<void> {
    return this.result(() => {
      const parts = chunks(state);
      const catalog = this.readCatalog(token, uuid);
      if (catalog.status !== "ready") throw new CacheRefusal(catalog.status);
      if (!catalog.value?.revisions.some(entry => entry.id === revision && entry.checksum === checksum)) {
        throw new CacheRefusal("superseded");
      }
      const previous = this.read(token, db => db.prepare("SELECT download FROM history_v1_snapshots WHERE generation = ? AND uuid = ? AND revision = ?")
        .get(token.generation, uuid, revision));
      const held = this.hold(token, uuid, revision);
      if (held.status !== "ready") throw new CacheRefusal(held.status);
      const download = randomUUID();
      try {
        for (const [part, bytes] of parts.entries()) this.write(token, db => {
          this.pagePresent(db, token, uuid);
          db.prepare("INSERT INTO history_v1_snapshot_chunks VALUES (?, ?, ?, ?, ?, ?)")
            .run(token.generation, uuid, revision, download, part, bytes);
        });
        this.write(token, db => {
          this.pagePresent(db, token, uuid);
          if (db.prepare("SELECT catalog FROM history_v1_pages WHERE generation = ? AND uuid = ?")
            .get(token.generation, uuid)?.catalog !== catalog.value?.catalog) throw new CacheRefusal("superseded");
          db.prepare("INSERT OR REPLACE INTO history_v1_snapshots VALUES (?, ?, ?, ?, ?, ?)")
            .run(token.generation, uuid, revision, download, checksum, state.byteLength);
        });
        if (previous !== undefined) this.deleteRows(token, "history_v1_snapshot_chunks", "generation = ? AND uuid = ? AND revision = ? AND download = ?",
          [token.generation, uuid, revision, previous.download as string]);
      } finally { held.value.release(); }
    });
  }

  readSnapshot(token: HistoryCacheToken, uuid: string, revision: string): HistoryCacheResult<{ state: Uint8Array; checksum: string } | null> {
    return this.result(() => this.read(token, db => {
      if (db.prepare("SELECT 1 FROM history_v1_deleted WHERE generation = ? AND uuid = ?").get(token.generation, uuid)) return null;
      const row = db.prepare("SELECT download, checksum, byte_length FROM history_v1_snapshots WHERE generation = ? AND uuid = ? AND revision = ?")
        .get(token.generation, uuid, revision);
      if (row === undefined) return null;
      const parts = db.prepare("SELECT bytes FROM history_v1_snapshot_chunks WHERE generation = ? AND uuid = ? AND revision = ? AND download = ? ORDER BY part")
        .all(token.generation, uuid, revision, row.download as string);
      const state = Buffer.concat(parts.map(part => part.bytes as Uint8Array));
      if (state.byteLength !== row.byte_length) throw new CacheRefusal("unavailable");
      return { state, checksum: row.checksum as string };
    }));
  }

  listPages(token: HistoryCacheToken): HistoryCacheResult<string[]> {
    return this.result(() => this.read(token, db => db.prepare("SELECT uuid FROM history_v1_pages WHERE generation = ? ORDER BY uuid")
      .all(token.generation).map(row => String(row.uuid))));
  }

  hasSnapshot(token: HistoryCacheToken, uuid: string, revision: string, checksum: string): HistoryCacheResult<boolean> {
    return this.result(() => this.read(token, db => db.prepare("SELECT 1 FROM history_v1_snapshots WHERE generation = ? AND uuid = ? AND revision = ? AND checksum = ? " +
      "AND NOT EXISTS (SELECT 1 FROM history_v1_deleted WHERE generation = ? AND uuid = ?)")
      .get(token.generation, uuid, revision, checksum, token.generation, uuid) !== undefined));
  }

  newestDownloadedRevision(token: HistoryCacheToken, uuid: string, revisions: readonly RevisionEntry[]): HistoryCacheResult<string | null> {
    return this.result(() => this.read(token, db => {
      const snapshots = db.prepare("SELECT revision, checksum FROM history_v1_snapshots WHERE generation = ? AND uuid = ? " +
        "AND NOT EXISTS (SELECT 1 FROM history_v1_deleted WHERE generation = ? AND uuid = ?)")
        .all(token.generation, uuid, token.generation, uuid);
      const downloaded = new Map(snapshots.map(snapshot => [String(snapshot.revision), String(snapshot.checksum)]));
      return revisions.find(revision => revision.checksum !== undefined && downloaded.get(revision.id) === revision.checksum)?.id ?? null;
    }));
  }

  evict(token: HistoryCacheToken, uuid: string, retention: HistoryRetention, now: number): HistoryCacheResult<void> {
    return this.result(() => {
      const catalog = this.readCatalog(token, uuid);
      if (catalog.status !== "ready") throw new CacheRefusal(catalog.status);
      if (catalog.value === null) return;
      const page = catalog.value;
      if (!page.complete) return;
      this.session ??= new HistoryHoldSession(this.path);
      const session = this.session;
      const { snapshots, held } = this.read(token, db => ({
        snapshots: db.prepare("SELECT revision, download FROM history_v1_snapshots WHERE generation = ? AND uuid = ?")
          .all(token.generation, uuid),
        held: db.prepare("SELECT revision, session FROM history_v1_holds WHERE generation = ? AND uuid = ?")
          .all(token.generation, uuid),
      }));
      const dead = new Set(held.map(row => row.session as string).filter(id => !session.isAlive(id)));
      const keep = selectHistorySnapshots({ revisions: page.revisions,
        downloaded: new Set(snapshots.map(row => row.revision as string)),
        held: new Set(held.filter(row => !dead.has(row.session as string)).map(row => row.revision as string)),
        ...(page.revisions[0]?.final === false ? { currentHeadId: page.revisions[0].id } : {}) }, retention, now);
      for (const snapshot of snapshots) {
        if (keep.has(snapshot.revision as string)) continue;
        const removed = this.write(token, current => {
          if (current.prepare("SELECT catalog FROM history_v1_pages WHERE generation = ? AND uuid = ?")
            .get(token.generation, uuid)?.catalog !== catalog.value?.catalog) throw new CacheRefusal("superseded");
          const index = page.revisions.findIndex(entry => entry.id === snapshot.revision);
          const newer = page.revisions[index - 1]?.id ?? snapshot.revision as string;
          const holds = current.prepare("SELECT session FROM history_v1_holds WHERE generation = ? AND uuid = ? AND revision IN (?, ?)")
            .all(token.generation, uuid, snapshot.revision as string, newer);
          if (holds.some(row => !dead.has(row.session as string))) return false;
          return current.prepare("DELETE FROM history_v1_snapshots WHERE generation = ? AND uuid = ? AND revision = ? AND download = ?")
            .run(token.generation, uuid, snapshot.revision as string, snapshot.download as string).changes !== 0;
        });
        if (removed) this.deleteRows(token, "history_v1_snapshot_chunks", "generation = ? AND uuid = ? AND revision = ? AND download = ?",
          [token.generation, uuid, snapshot.revision as string, snapshot.download as string]);
      }
      this.collectGarbage(token);
    });
  }

  /** Called only by the store's already-authorized permanent-deletion path. */
  purgeDoc(uuid: string): HistoryCacheResult<void> {
    return this.result(() => {
      const header = this.header();
      if (header === null || header.format !== HISTORY_CACHE_FORMAT) return;
      const deleted = this.read(header, db => db.prepare("SELECT 1 FROM history_v1_deleted WHERE generation = ? AND uuid = ?")
        .get(header.generation, uuid), true);
      if (deleted === undefined) this.write(header, db => {
        db.prepare("INSERT OR IGNORE INTO history_v1_deleted VALUES (?, ?)").run(header.generation, uuid);
        db.prepare("DELETE FROM history_v1_pages WHERE generation = ? AND uuid = ?").run(header.generation, uuid);
      }, false);
      for (const table of TABLES) {
        if (table !== "history_v1_deleted") this.deleteRows(header, table, "generation = ? AND uuid = ?", [header.generation, uuid], true);
      }
    });
  }

  close(): void {
    this.closed = true;
    try { this.session?.close(); } catch { /* Disposable locks must not fail store shutdown. */ }
    try { this.db?.close(); } catch { /* Disposable connections must not fail store shutdown. */ }
  }
}
