import { statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

export function workspaceDetachGeneration(db: DatabaseSync): string | null {
  return db.prepare("SELECT value FROM meta WHERE key = 'workspace_detach_generation'").get()?.value as string | undefined ?? null;
}

/** Capture before a lazy cache connection or worker can outlive a detach. */
export function captureWorkspaceDetachGeneration(path: string): string | null {
  if (path === ":memory:" || statSync(path, { throwIfNoEntry: false })?.isFile() !== true) return null;
  const db = new DatabaseSync(path, { readOnly: true, timeout: 5_000 });
  try {
    if (!db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'meta'").get()) return null;
    return workspaceDetachGeneration(db);
  } finally { db.close(); }
}

export class WorkspaceDetachedError extends Error {
  constructor() {
    super("The workspace was detached from its hub on this computer. Restart the MCP server to use its current workspace selection.");
    this.name = "WorkspaceDetachedError";
  }
}
