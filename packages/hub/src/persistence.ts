/**
 * Persist one SQLite row of full Yjs v1 state per document; this is not the local
 * replica's append-only log and needs no pruning. Keep the extension-sqlite
 * table, queries and bytes compatible so its databases open unchanged.
 * A small node:sqlite adapter avoids a native addon and owns pre-bind database
 * opening and store-failure propagation. Hub-internal tables share its one handle.
 */

import { chmodSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { createDataDirectory } from "./storage.js";
import type {
  Extension,
  onLoadDocumentPayload,
  onStoreDocumentPayload,
} from "@hocuspocus/server";
import * as Y from "yjs";

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
      createDataDirectory(dirname(this.databasePath));
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
    const row = this.prepared().select.get({ name: documentName });
    const data = row?.data;
    if (data instanceof Uint8Array) {
      Y.applyUpdate(document, data);
    }
  }

  async onStoreDocument({
    document,
    documentName,
  }: onStoreDocumentPayload): Promise<void> {
    try {
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
  }

  private prepared(): { select: StatementSync; upsert: StatementSync } {
    if (this.statements === undefined) {
      throw new Error("HubDatabase: the database is not open");
    }
    return this.statements;
  }
}
