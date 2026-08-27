/**
 * Forgetting one workspace on this device (#198).
 *
 * Every room this browser has ever joined leaves an IndexedDB database behind,
 * named by the room key — `<workspaceId>/<docUuid>` — and `destroy()` only ever
 * closes one. Switching workspaces is navigating (see `ui/route.ts`), so a
 * browser accumulates the full text of every workspace a link ever took it to,
 * and the browser's own site-data control is all-or-nothing. This module is the
 * per-workspace control: enumerate our own databases, and delete the ones that
 * belong to one workspace.
 *
 * Three things it deliberately does not do.
 *
 * - **It never asks the hub anything.** Working offline is the point of the
 *   cache, so a screen that could only answer while connected would be blank in
 *   exactly the situation it exists for. Everything below is read from what this
 *   browser holds.
 * - **It never guesses.** `indexedDB.databases()` is not implemented everywhere,
 *   and where it is missing there is no honest way to list what is stored — so
 *   the answer is "cannot tell", never an empty list that reads as "nothing
 *   stored". The same rule governs the un-synced count: see
 *   {@link WorkspaceCache.certain}.
 * - **It touches nothing on the hub.** Forgetting is a cache eviction on one
 *   device. The workspace, its documents and every other replica are untouched,
 *   which is why reopening the workspace simply re-hydrates.
 *
 * A database is ours when its name parses as a room name. `parseRoom` is strict
 * — two segments, a bare workspace uuid, a non-empty document id — so an
 * unrelated database on the same origin cannot be mistaken for one of ours, and
 * neither can another workspace's room.
 */

import { parseRoom } from "@uberblick/schema";
import { openRoomBacklog } from "./rooms.js";

/** What this browser holds for one workspace. */
export interface WorkspaceCache {
  /** The bare workspace uuid, as the room names spell it. */
  workspaceId: string;
  /** Its room databases — the directory, the sidebar and one per document. */
  rooms: string[];
  /**
   * Documents this browser *knows* hold updates the hub has not acknowledged.
   *
   * A floor, never a total: see {@link certain}. Only a live provider carries a
   * backlog, and nothing persists an acknowledged watermark, so a cached room
   * with no open connection is unreadable rather than clean.
   */
  unsynced: number;
  /**
   * Whether {@link unsynced} is the whole answer — true only when every one of
   * these rooms is open in this tab and could therefore be read.
   *
   * False is what makes the confirmation say "unknown" instead of "none". The
   * two are not the same claim, and printing the safe-sounding one for the
   * unknown one is how a person deletes work they were never warned about.
   */
  certain: boolean;
}

/**
 * Whether this browser will let a page list its own databases.
 *
 * Exported because the answer decides whether there is anything to read at all:
 * a surface that cannot enumerate has nothing to offer and nothing to ask for.
 */
export function canListDatabases(): boolean {
  return (
    typeof indexedDB !== "undefined" && typeof indexedDB.databases === "function"
  );
}

/**
 * Every workspace this browser holds a room cache for, ordered by uuid.
 *
 * `null` means this browser cannot tell — `indexedDB.databases()` is missing
 * (Firefox before 126, some embedded webviews) or refused. That is a different
 * answer from an empty array, and the caller must render it as one.
 */
export async function cachedWorkspaces(): Promise<WorkspaceCache[] | null> {
  if (!canListDatabases()) return null;
  let listed: IDBDatabaseInfo[];
  try {
    listed = await indexedDB.databases();
  } catch {
    return null;
  }
  const backlog = openRoomBacklog();
  const byWorkspace = new Map<string, string[]>();
  for (const { name } of listed) {
    if (name === undefined) continue;
    let workspaceId: string;
    try {
      workspaceId = parseRoom(name).workspaceId;
    } catch {
      // Not a room name: somebody else's database on this origin. Ours to
      // leave alone, and the only reason this whole module can be per-workspace.
      continue;
    }
    const rooms = byWorkspace.get(workspaceId);
    if (rooms === undefined) byWorkspace.set(workspaceId, [name]);
    else rooms.push(name);
  }
  return [...byWorkspace.entries()]
    .map(([workspaceId, rooms]) => ({
      workspaceId,
      rooms: [...rooms].sort(),
      unsynced: rooms.filter((room) => (backlog.get(room) ?? 0) > 0).length,
      certain: rooms.every((room) => backlog.has(room)),
    }))
    .sort((a, b) => a.workspaceId.localeCompare(b.workspaceId));
}

/**
 * Roughly how many bytes this origin stores, or `null` where the browser does
 * not say.
 *
 * Origin-wide, because that is the only number `navigator.storage.estimate()`
 * offers — there is no per-database breakdown to have. The copy says so rather
 * than dividing it up: an apportioned guess would be a made-up fact on a screen
 * whose whole job is to state a cost accurately.
 */
export async function originUsage(): Promise<number | null> {
  const storage: StorageManager | undefined = navigator.storage;
  if (typeof storage?.estimate !== "function") return null;
  try {
    const { usage } = await storage.estimate();
    return typeof usage === "number" ? usage : null;
  } catch {
    return null;
  }
}

/** What a forget actually managed to remove. */
export interface ForgetResult {
  /** Databases that are gone afterwards. */
  deleted: number;
  /**
   * The workspace's databases still present after the attempt — a deletion
   * another tab is holding open, or one the browser refused. Read back rather
   * than inferred from the requests, because a blocked deletion completes later
   * and this page must not claim either outcome on its behalf.
   */
  remaining: string[];
}

/** Delete one database. Settles on every outcome; the re-read is the truth. */
function deleteDatabase(name: string): Promise<void> {
  return new Promise((resolve) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = () => resolve();
    request.onerror = () => resolve();
    // Another connection — another tab, usually — blocks the deletion. The
    // request stays pending and completes when that connection closes, but
    // nothing here may wait on a tab it cannot see, so this settles and the
    // re-read below reports the database as still there.
    request.onblocked = () => resolve();
  });
}

/**
 * Delete every database belonging to `workspaceId`, and nothing else.
 *
 * Scoped by the room grammar, not by a prefix match: a name only counts when
 * `parseRoom` reads it as a room *of this workspace*. Another workspace's rooms
 * and any unrelated database on the origin are never named, so they cannot be
 * deleted by a typo in a uuid.
 */
export async function forgetWorkspace(workspaceId: string): Promise<ForgetResult> {
  const before = await cachedWorkspaces();
  const rooms = before?.find((cache) => cache.workspaceId === workspaceId)?.rooms ?? [];
  await Promise.all(rooms.map(deleteDatabase));
  const after = await cachedWorkspaces();
  const remaining =
    after?.find((cache) => cache.workspaceId === workspaceId)?.rooms ?? [];
  return { deleted: rooms.length - remaining.length, remaining };
}
