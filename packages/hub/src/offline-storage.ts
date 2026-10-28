import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { canonicalDocumentUuid, roomForDoc } from "@uberblick/schema";

/**
 * The caller must exclude a running hub. Open no hub runtime here: its startup
 * reconciliation can change directories and rooms beyond the supplied marks.
 */
export function purgeDetachedDocumentCopies(
  databasePath: string,
  workspaceId: string,
  deletedUuids: readonly string[],
): void {
  const rooms = deletedUuids.map(uuid => {
    const canonical = canonicalDocumentUuid(uuid);
    if (canonical === null) throw new Error("Only permanently deleted document UUIDs can be purged");
    return roomForDoc(workspaceId, canonical);
  });
  if (rooms.length === 0 || !existsSync(databasePath)) return;

  const database = new DatabaseSync(databasePath, { timeout: 5_000 });
  try {
    database.exec("BEGIN IMMEDIATE");
    try {
      const remove = database.prepare("DELETE FROM documents WHERE name = ?");
      const tableExists = database.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?");
      const revisions = [
        "document_revision_names", "document_revisions", "document_revision_heads", "document_revision_documents",
      ].filter(table => tableExists.get(table) !== undefined)
        .map(table => database.prepare(`DELETE FROM ${table} WHERE room = ?`));
      for (const room of rooms) {
        remove.run(room);
        for (const revision of revisions) revision.run(room);
      }
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  } finally {
    database.close();
  }
}
