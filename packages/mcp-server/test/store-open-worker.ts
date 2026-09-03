/**
 * One real process in the shared-store open storm. The parent holds eight of
 * these at a barrier, then releases all of them once per round.
 */

import type { DatabaseSync } from "node:sqlite";
import { MirrorStore } from "../src/store.js";

const databasePath = process.argv[2] as string;
const workspaceId = process.argv[3] as string;

function open(): void {
  const store = new MirrorStore(databasePath, workspaceId);
  try {
    // These are connection-local except for WAL. Reading the store's own
    // connection is the direct proof that the constructor left all three on.
    const db = (store as unknown as { db: DatabaseSync }).db;
    process.send?.({
      type: "opened",
      journalMode: (db.prepare("PRAGMA journal_mode").get() as { journal_mode: string })
        .journal_mode,
      busyTimeout: (db.prepare("PRAGMA busy_timeout").get() as { timeout: number }).timeout,
      foreignKeys: (db.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number })
        .foreign_keys,
    });
  } finally {
    store.close();
  }
}

process.on("message", (message: { type?: string }) => {
  if (message.type === "open") {
    try {
      open();
    } catch (error) {
      process.send?.({
        type: "failed",
        message: String(error),
        code: (error as { errcode?: number }).errcode ?? null,
      });
    }
  }
  if (message.type === "quit") process.exit(0);
});

process.on("disconnect", () => process.exit(0));
process.send?.({ type: "ready" });
