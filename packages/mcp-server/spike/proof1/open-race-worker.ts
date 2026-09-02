/**
 * Proof 1, case 1c — the child.
 *
 * Waits at a barrier, then opens the shared store with the same two pragmas
 * `MirrorStore`'s constructor issues, in the shipping order or with the busy
 * timeout set first, and closes again. The parent releases every opener at once,
 * which is what a machine starting several MCP servers together looks like.
 */

import { DatabaseSync } from "node:sqlite";
import { now, onMessage, send } from "./common.js";

interface Params {
  id: string;
  databasePath: string;
  order: "shipping" | "swapped";
}

const params = JSON.parse(process.argv[2] as string) as Params;

/** Exactly what `MirrorStore`'s constructor does, in either order. */
function openOnce(): number {
  const started = now();
  const db = new DatabaseSync(params.databasePath);
  try {
    if (params.order === "swapped") {
      db.exec("PRAGMA busy_timeout = 5000");
      db.exec("PRAGMA journal_mode = WAL");
    } else {
      db.exec("PRAGMA journal_mode = WAL");
      db.exec("PRAGMA busy_timeout = 5000");
    }
    db.exec("PRAGMA foreign_keys = ON");
    db.prepare(
      "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'updates'",
    ).get();
    db.prepare("SELECT COUNT(*) AS n FROM updates").get();
    return now() - started;
  } finally {
    db.close();
  }
}

send({ type: "ready", id: params.id });
onMessage<{ type: string }>((message) => {
  if (message.type === "go") {
    try {
      send({ type: "opened", id: params.id, ms: openOnce(), error: null });
    } catch (error) {
      send({
        type: "opened",
        id: params.id,
        ms: null,
        error: String(error),
        code: (error as { errcode?: number }).errcode ?? null,
      });
    }
    return;
  }
  if (message.type === "quit") process.exit(0);
});
