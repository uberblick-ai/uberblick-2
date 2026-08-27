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
 *   stored". The same rule governs the un-synced count ({@link
 *   WorkspaceCache.certain}) and the re-read after a deletion ({@link
 *   ForgetResult.remaining}), which can fail the same way.
 * - **It touches nothing on the hub.** Forgetting is a cache eviction on one
 *   device. The workspace, its documents and every other replica are untouched,
 *   which is why reopening the workspace simply re-hydrates.
 *
 * # What counts as ours
 *
 * Two gates, and the pair is the whole scoping guarantee.
 *
 * A *name* is ours only when it is a room name *and* its document segment is a
 * lowercase uuid or one of the reserved ids the room grammar owns. `parseRoom`
 * alone is not enough — it is a deliberately structural splitter, so it reads a
 * foreign `<uuid>/anything` as that workspace's room and would hand it to the
 * deleter. The closed rule is applied here rather than through the schema
 * package's own validator on purpose: that validator sits on the hub's
 * authentication path and #222 is its first and only sanctioned caller, so
 * calling it from here would be the enforcement change arriving by accident.
 *
 * A *group* is ours only when it holds its own `<uuid>/_directory` database.
 * Every workspace this client has actually opened has one, because the
 * directory room is joined before anything else; a lone database that merely
 * looks like a room name does not. So a name collision cannot invent a
 * workspace to forget.
 *
 * The cost of that strictness is that an odd-shaped database from some older
 * layout would be invisible here rather than forgettable. That is the right way
 * round: this module deletes, and a deleter that guesses is the failure mode
 * worth designing against.
 */

import {
  DIRECTORY_SUFFIX,
  FEEDBACK_SUFFIX,
  SIDEBAR_SUFFIX,
  parseRoom,
} from "@uberblick/schema";
import { openRoomBacklog } from "./rooms.js";

/** A document uuid — the segment shape that makes a room a *document* room. */
const DOCUMENT_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * The document ids a room may name besides a uuid — the same closed set the
 * room grammar owns. `_settings` is a reservation with no code behind it yet;
 * it is listed so that a workspace which one day caches one is forgotten whole.
 */
const RESERVED_DOCUMENT_IDS: ReadonlySet<string> = new Set([
  DIRECTORY_SUFFIX,
  SIDEBAR_SUFFIX,
  FEEDBACK_SUFFIX,
  "_settings",
]);

/** The workspace a database name belongs to, or null when it is not ours. */
function roomWorkspace(name: string): string | null {
  let workspaceId: string;
  let uuid: string;
  try {
    ({ workspaceId, uuid } = parseRoom(name));
  } catch {
    return null;
  }
  return DOCUMENT_UUID.test(uuid) || RESERVED_DOCUMENT_IDS.has(uuid)
    ? workspaceId
    : null;
}

/** What this browser holds for one workspace. */
export interface WorkspaceCache {
  /** The bare workspace uuid, as the room names spell it. */
  workspaceId: string;
  /**
   * Every one of its room databases — the documents, plus the small directory,
   * sidebar and feedback caches. This is exactly what a forget removes.
   */
  rooms: string[];
  /**
   * How many of those rooms are *documents*: a uuid document segment, never a
   * reserved id. The reserved rooms cache the workspace's own chrome, so
   * counting them would tell a reader that a workspace holds two documents when
   * it holds none.
   */
  documents: number;
  /**
   * Rooms this browser *knows* hold updates the hub has not acknowledged.
   *
   * A floor, never a total: see {@link certain}. Only a live provider carries a
   * backlog, and nothing persists an acknowledged watermark, so a cached room
   * with no open connection is unreadable rather than clean.
   *
   * Counted over every room rather than over documents alone, because the
   * question it answers is what a forget would throw away — and a pin or a
   * sidebar group that never reached the hub is thrown away just as finally as
   * a paragraph.
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

/** Whether this browser will let a page list its own databases. */
export function canListDatabases(): boolean {
  return (
    typeof indexedDB !== "undefined" && typeof indexedDB.databases === "function"
  );
}

/**
 * Every database on this origin whose name is a canonical room name, grouped by
 * workspace. Null when the browser will not say what it stores.
 *
 * The first gate only — see {@link roomWorkspace}. {@link ourWorkspaces}
 * adds the second.
 */
async function canonicalRooms(): Promise<Map<string, string[]> | null> {
  if (!canListDatabases()) return null;
  let listed: IDBDatabaseInfo[];
  try {
    listed = await indexedDB.databases();
  } catch {
    return null;
  }
  const byWorkspace = new Map<string, string[]>();
  for (const { name } of listed) {
    if (name === undefined) continue;
    const workspaceId = roomWorkspace(name);
    if (workspaceId === null) continue;
    const rooms = byWorkspace.get(workspaceId);
    if (rooms === undefined) byWorkspace.set(workspaceId, [name]);
    else rooms.push(name);
  }
  return byWorkspace;
}

/** Both gates: canonical names, in a group that owns its directory database. */
async function ourWorkspaces(): Promise<Map<string, string[]> | null> {
  const grouped = await canonicalRooms();
  if (grouped === null) return null;
  for (const [workspaceId, rooms] of grouped) {
    if (!rooms.includes(`${workspaceId}/${DIRECTORY_SUFFIX}`)) {
      grouped.delete(workspaceId);
    }
  }
  return grouped;
}

/**
 * Every workspace this browser holds a room cache for, ordered by uuid.
 *
 * `null` means this browser cannot tell — `indexedDB.databases()` is missing
 * (Firefox before 126, some embedded webviews) or refused. That is a different
 * answer from an empty array, and the caller must render it as one.
 */
export async function cachedWorkspaces(): Promise<WorkspaceCache[] | null> {
  const grouped = await ourWorkspaces();
  if (grouped === null) return null;
  const backlog = openRoomBacklog();
  return [...grouped.entries()]
    .map(([workspaceId, rooms]) => ({
      workspaceId,
      rooms: [...rooms].sort(),
      documents: rooms.filter((room) => DOCUMENT_UUID.test(parseRoom(room).uuid))
        .length,
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

/** What a forget actually did, one database at a time. */
export interface ForgetResult {
  /** How many databases the forget named. */
  attempted: number;
  /** Deletions the browser reported as complete. */
  removed: number;
  /**
   * Deletions a live connection queued rather than refused — another tab still
   * has the database open. The request stays pending and the browser completes
   * it as soon as that connection closes, so nothing here retries and nothing
   * coordinates between tabs.
   *
   * Counted from the request's own `blocked` event, never from what is listed
   * afterwards: a browser may already omit a database whose deletion is pending,
   * and reading the listing as the answer would report a queued deletion as a
   * finished one.
   */
  scheduled: number;
  /** Deletions the browser refused outright. Failed, and not queued. */
  failed: number;
  /**
   * The workspace's databases still present afterwards, or `null` when the
   * re-read could not run at all.
   *
   * Evidence, not the verdict: the three counts above come from the deletion
   * requests themselves, and this only says whether anything could be checked
   * afterwards. `null` is not an empty list — a browser that has stopped
   * answering `databases()` has told us nothing, and reporting that as a clean
   * sweep would be the one claim this screen must never make on no evidence.
   */
  remaining: string[] | null;
}

/** One deletion's outcome. `blocked` means queued, never refused. */
type Outcome = "done" | "blocked" | "error";

function deleteDatabase(name: string): Promise<Outcome> {
  return new Promise((resolve) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = () => resolve("done");
    request.onerror = () => resolve("error");
    // Another connection — another tab, usually — is holding the database open.
    // The deletion is *queued*, not rejected: the browser runs it the moment
    // that connection closes. Nothing here may wait on a tab it cannot see, so
    // this settles, and the caller reports a scheduled deletion as scheduled.
    request.onblocked = () => resolve("blocked");
  });
}

/**
 * Delete every database belonging to `workspaceId`, and nothing else.
 *
 * Scoped by the two gates at the top of this file, so another workspace's
 * rooms, a foreign database whose name merely resembles one, and anything else
 * on the origin are never named — and therefore cannot be deleted by a typo in
 * a uuid.
 *
 * The re-read that produces `remaining` uses the first gate alone, because a
 * half-finished forget has already lost the directory database the second gate
 * looks for — and a blocked document database left behind by such a forget is
 * exactly what the caller has to be told about.
 */
export async function forgetWorkspace(workspaceId: string): Promise<ForgetResult> {
  const rooms = (await ourWorkspaces())?.get(workspaceId) ?? [];
  const outcomes = await Promise.all(rooms.map(deleteDatabase));
  const after = await canonicalRooms();
  const count = (outcome: Outcome): number =>
    outcomes.filter((seen) => seen === outcome).length;
  return {
    attempted: rooms.length,
    removed: count("done"),
    scheduled: count("blocked"),
    failed: count("error"),
    remaining: after === null ? null : (after.get(workspaceId) ?? []),
  };
}
