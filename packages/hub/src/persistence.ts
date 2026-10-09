/**
 * Document persistence: one SQLite row per document, holding
 * `Y.encodeStateAsUpdate(doc)`.
 *
 * This is what `@hocuspocus/extension-sqlite` did, minus the native addon and
 * the two behaviours the hub had to subclass around. The extension was a
 * two-column adapter over better-sqlite3; Node 26 ships SQLite in the runtime
 * (`node:sqlite`), so the adapter is cheaper to own than to depend on — and
 * owning it is what lets the hub open the database before it binds the socket
 * and see a failed store as a failure. Nothing about the *file* changes: same
 * table, same queries, same Yjs v1 bytes, so every database written by the
 * extension opens here untouched (`test/fixtures/extension-sqlite.sqlite` is
 * one, and `persistence.test.ts` proves it).
 *
 * It is a full state snapshot per document, never an appended update stream, so
 * there is nothing to prune — the MCP server's append-only log is the local
 * replica; this is the hub's.
 *
 * The handle is opened once and owned here. {@link HubDatabase.connection} is
 * the seam for hub-internal tables (the workspace registry, #216): they extend
 * this connection rather than opening a second one on the same file, where two
 * writers would meet each other's locks.
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
 * The extension's schema, character for character — including the `varchar(255)`
 * SQLite does not enforce and the implicit unique index that `UNIQUE(name)`
 * creates. It is `IF NOT EXISTS`, so opening an existing database changes
 * nothing about it, and rewriting it here to taste would be a migration nobody
 * asked for.
 */
const SCHEMA = `CREATE TABLE IF NOT EXISTS "documents" (
  "name" varchar(255) NOT NULL,
  "data" blob NOT NULL,
  UNIQUE(name)
)`;

/** The extension's two queries, likewise verbatim. */
const SELECT_DOCUMENT = `
  SELECT data FROM "documents" WHERE name = $name ORDER BY rowid DESC
`;

const UPSERT_DOCUMENT = `
  INSERT INTO "documents" ("name", "data") VALUES ($name, $data)
    ON CONFLICT(name) DO UPDATE SET data = $data
`;

/**
 * How long SQLite waits for another process to release a write lock before it
 * gives up (ms). Not a tuning knob: better-sqlite3 defaulted to 5s and
 * `node:sqlite` defaults to 0, and for this hub a lock held for a moment — a
 * backup reading the file, an inspection tool, a second hub starting — would
 * otherwise fail one store *permanently*, because a failed store is sticky by
 * design and every later flush and the shutdown then report the state as not
 * durable. Waiting is what that contract costs.
 */
const BUSY_TIMEOUT_MS = 5_000;

/**
 * The two anonymous database forms SQLite accepts, which the hub's
 * configuration accepts too: `":memory:"` and `""` (an unnamed temporary file).
 * Neither names a directory to create, and neither survives the close.
 */
export function isEphemeralDatabase(databasePath: string): boolean {
  return databasePath === ":memory:" || databasePath === "";
}

/**
 * The hub's SQLite handle and the two Hocuspocus hooks that use it.
 *
 * `onLoadDocument` hydrates a room from its row; `onStoreDocument` upserts the
 * document's full state back. A store that throws is reported to
 * `onStoreFailed` — where it is still an exception — before it is rethrown:
 * `Hocuspocus.storeDocumentHooks` catches, logs and *resolves*, so without this
 * nothing downstream could tell a write that landed from one that did not, and
 * `Hub.stop()` would exit 0 having written nothing.
 *
 * There is deliberately no `onConfigure`: Hocuspocus fires that from its own
 * constructor without awaiting it, which is how a bad database path used to
 * become an unhandled rejection after the hub had announced itself as
 * listening. {@link createHub} calls {@link open} itself, first.
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
   * Open the database and make sure the table exists. Synchronous, like every
   * `node:sqlite` call, and called before the socket binds so that a hub which
   * is listening is a hub that can persist.
   *
   * That check is what SQLite can answer at open time — a missing or unwritable
   * directory, a path that is not a database — not every way a write can later
   * fail; an existing file that is read-only opens here and surfaces as the
   * sticky store failure instead.
   *
   * @throws when the path cannot be opened — leaving no handle behind.
   */
  open(): void {
    if (this.db !== undefined) {
      throw new Error("HubDatabase.open: already open");
    }
    // Owner-only, and created here because the hub is often the first thing to
    // touch the user's data tree: a directory it left world-readable would
    // still be world-readable when `ub workspace create` writes credentials.json into the
    // same tree, where `mode: 0o700` on an existing directory does nothing.
    const durable = !isEphemeralDatabase(this.databasePath);
    const fresh = durable && !existsSync(this.databasePath);
    if (durable) {
      createDataDirectory(dirname(this.databasePath));
    }

    const db = new DatabaseSync(this.databasePath, {
      timeout: BUSY_TIMEOUT_MS,
    });
    // Only a file this open created: the mode of a database somebody already
    // has is theirs to choose, and tightening it under them is not this
    // constructor's business. Before any schema is written, so that a journal
    // or WAL file SQLite creates alongside inherits the same permissions.
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

  /**
   * The one handle, for the rest of `packages/hub`. Hub-internal on purpose:
   * it is not re-exported from the package entry, because a second connection
   * to the same file is a second writer, and callers outside the hub have no
   * business holding either.
   */
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
      this.onStoreFailed(error);
      throw error;
    }
  }

  /**
   * Idempotent: shutdown paths are the worst place to learn about a double
   * close. The handle is dropped as well as closed, so {@link connection} fails
   * with "not open" afterwards instead of handing out a closed database.
   */
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
