/** Workspace settings written by CLI onboarding. */

import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import {
  getWorkspaceMainRepository,
  githubRepository,
  parseWorkspaceId,
  setWorkspaceMainRepository,
  setWorkspaceName,
  settingsRoom,
  validateWorkspaceName,
  type UpdateOriginMetadata,
} from "@uberblick/schema";
import * as Y from "yjs";
import type { McpConfig } from "./config.js";
import { resolveStorage } from "./storage.js";
import { openWorkspaceReplicas } from "./workspace-replicas.js";

/**
 * The caller owns the UUID claim. Persist independently of starter seeding or
 * hub availability; the observer logs synchronously and marks settings pending.
 */
export function storeWorkspaceName(config: McpConfig, name: string): void {
  const validated = validateWorkspaceName(name);
  const workspace = openWorkspaceReplicas(config, {
    hubFree: true,
    publishOwnPresence: false,
  });
  const { replicas } = workspace;
  replicas.setWriteSurface({ kind: "cli", name: "ub workspace" });
  try {
    setWorkspaceName(replicas.settings().doc, validated);
    replicas.assertHealthy();
  } finally {
    workspace.close();
  }
}

/** Optional onboarding fill: never create, migrate or repair a local replica. */
export function fillWorkspaceMainRepository(
  workspaceId: string,
  repository: string,
  databasePath?: string,
  origin?: UpdateOriginMetadata,
): void {
  const normalized = githubRepository(repository);
  if (normalized === null) return;
  const doc = new Y.Doc();
  try {
    const uuid = parseWorkspaceId(workspaceId).uuid;
    // SQLite's URI mode makes an absent file fail at open, without an exists/open race.
    const address = pathToFileURL(databasePath ?? join(resolveStorage().workspaceDir, `${uuid}.sqlite`));
    address.searchParams.set("mode", "rw");
    const db = new DatabaseSync(address.href);
    try {
      fillExistingSettings(db, doc, uuid, normalized, origin);
    } finally {
      try {
        if (db.isTransaction) db.exec("ROLLBACK");
      } finally {
        db.close();
      }
    }
  } catch {
    // A missing/unreadable replica or a refused append must not fail create/use.
  } finally {
    doc.destroy();
  }
}

function fillExistingSettings(db: DatabaseSync, doc: Y.Doc, workspaceId: string, repository: string, origin?: UpdateOriginMetadata): void {
  // Serialize the unset check and append with peers, and give a busy writer no wait.
  db.exec("BEGIN IMMEDIATE");
  const recorded = db.prepare("SELECT value FROM meta WHERE key = 'workspace'").get();
  if (recorded?.value !== workspaceId) return;
  const room = settingsRoom(workspaceId);
  const snapshot = db.prepare(
    "SELECT state, through_seq FROM snapshots WHERE room = ?",
  ).get(room);
  if (snapshot !== undefined) Y.applyUpdate(doc, snapshot.state as Uint8Array);
  const updates = db.prepare(
    "SELECT payload FROM updates WHERE room = ? AND seq > ? ORDER BY seq",
  ).all(room, snapshot?.through_seq ?? 0);
  for (const update of updates) Y.applyUpdate(doc, update.payload as Uint8Array);
  if (getWorkspaceMainRepository(doc) !== null) return;
  const vector = Y.encodeStateVector(doc);
  setWorkspaceMainRepository(doc, repository);
  const result = db.prepare(
    "INSERT INTO updates (room, payload, origin, logged_at) VALUES (?, ?, 'local', ?)",
  ).run(room, Y.encodeStateAsUpdate(doc, vector), Date.now());
  if (origin !== undefined && db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'update_origins'").get() !== undefined) {
    db.prepare("INSERT INTO update_origins (seq, metadata) VALUES (?, ?)").run(result.lastInsertRowid, JSON.stringify(origin));
  }
  db.prepare(
    "INSERT INTO pending_rooms (room, seq) VALUES (?, ?) " +
    "ON CONFLICT (room) DO UPDATE SET seq = MAX(pending_rooms.seq, excluded.seq)",
  ).run(room, result.lastInsertRowid);
  db.exec("COMMIT");
}
