/**
 * Room names.
 *
 * A room name is `<workspaceId>/<docUuid>`. A workspace's well-known docs take
 * reserved document-id slots: the directory at `<workspaceId>/_directory`, the
 * sidebar at `<workspaceId>/_sidebar`, and settings (including the tag catalog)
 * at `<workspaceId>/_settings`. Tenancy sits in the room key from day one so a
 * hosted hub never needs a room migration.
 *
 * The workspace segment is always the **bare uuid** (see `workspace.ts`): a
 * decorated `<slug>-<uuid>` is parsed here and only its uuid reaches the name,
 * so two spellings of one workspace name one room. There is no default
 * workspace — a room name says which workspace it belongs to, or it is not a
 * room name.
 */

import { InvalidRoomError, InvalidWorkspaceIdError } from "./errors.js";
import { parseWorkspaceId } from "./workspace.js";

/** The document-id slot the directory doc occupies inside a workspace. */
export const DIRECTORY_SUFFIX = "_directory";

/** The document-id slot the sidebar doc occupies inside a workspace. */
export const SIDEBAR_SUFFIX = "_sidebar";

/** The document-id slot for synced workspace settings such as the tag catalog. */
export const SETTINGS_SUFFIX = "_settings";

const SEPARATOR = "/";

function assertSegment(room: string, label: string, value: string): void {
  if (value === "") {
    throw new InvalidRoomError(room, `${label} is empty`);
  }
  if (value.includes(SEPARATOR)) {
    throw new InvalidRoomError(room, `${label} must not contain "${SEPARATOR}"`);
  }
}

/**
 * The room name of one document.
 *
 * The workspace may be given decorated: the slug is parsed off here, which is
 * what keeps it out of every room name in the system.
 *
 * @throws InvalidWorkspaceIdError when `workspaceId` is not a workspace id.
 */
export function roomForDoc(workspaceId: string, uuid: string): string {
  const workspace = parseWorkspaceId(workspaceId, "workspaceId").uuid;
  const room = `${workspace}${SEPARATOR}${uuid}`;
  assertSegment(room, "document uuid", uuid);
  return room;
}

/** The room name of a workspace's directory doc. */
export function directoryRoom(workspaceId: string): string {
  return roomForDoc(workspaceId, DIRECTORY_SUFFIX);
}

/** The room name of a workspace's sidebar doc. */
export function sidebarRoom(workspaceId: string): string {
  return roomForDoc(workspaceId, SIDEBAR_SUFFIX);
}

/** The room name of a workspace's settings doc. */
export function settingsRoom(workspaceId: string): string {
  return roomForDoc(workspaceId, SETTINGS_SUFFIX);
}

export interface ParsedRoom {
  /** The workspace's uuid, never a decorated spelling of it. */
  workspaceId: string;
  /** The document uuid or one of the workspace's well-known document ids. */
  uuid: string;
  isDirectory: boolean;
}

/**
 * Split a room name into its workspace and document parts.
 *
 * Exactly two segments. A bare name carries no workspace, and there is no
 * default to read it into, so it is not a room name.
 *
 * Read strictly where {@link roomForDoc} builds leniently: a *decorated*
 * workspace segment is refused rather than parsed down to its uuid. Accepting
 * one would make `<slug>-<uuid>/<doc>` and `<uuid>/<doc>` two spellings of one
 * document that the hub stores, and the token check compares, as two — a
 * silently forked document. Only the canonical name is a room name.
 *
 * @throws InvalidRoomError when the name has empty, missing or extra segments,
 * or a workspace segment that is not the bare uuid.
 * @throws InvalidWorkspaceIdError when the first segment is not a workspace id.
 */
export function parseRoom(room: string): ParsedRoom {
  const separatorIndex = room.indexOf(SEPARATOR);
  if (separatorIndex === -1) {
    throw new InvalidRoomError(room, "it names no workspace");
  }
  const segment = room.slice(0, separatorIndex);
  const workspace = parseWorkspaceId(segment, "workspaceId");
  if (workspace.slug !== null) {
    throw new InvalidRoomError(
      room,
      "the workspace segment carries a display slug; a room name uses the " +
        "bare uuid",
    );
  }
  const uuid = room.slice(separatorIndex + 1);
  assertSegment(room, "document uuid", uuid);
  return { workspaceId: workspace.uuid, uuid, isDirectory: uuid === DIRECTORY_SUFFIX };
}

/**
 * The document ids a canonical room may name besides a uuid.
 *
 * `_directory`, `_sidebar`, and `_settings` are real: their room helpers build
 * them, while application runtimes decide when to attach and hydrate them.
 */
const CANONICAL_DOCUMENT_IDS: ReadonlySet<string> = new Set([
  DIRECTORY_SUFFIX,
  SIDEBAR_SUFFIX,
  SETTINGS_SUFFIX,
]);

/**
 * A document uuid: lowercase 8-4-4-4-12 hex.
 *
 * One case rule for both segments of a room name. The workspace segment has
 * always been lowercase-only (see `workspace.ts`), and #196 pinned the
 * document segment to the same rule — an upper-cased link is canonicalized
 * down rather than opening a second room — because room names are
 * case-sensitive keys and `A…`/`a…` would otherwise be two rooms holding one
 * document. The version and variant nibbles are left unconstrained, exactly as
 * they are for a workspace id, so an id minted somewhere other than
 * `crypto.randomUUID` still passes.
 */
const DOCUMENT_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * `value` as a document uuid, lowercased — or null when it is not one.
 *
 * The one door for "is this a document identity?", so the `docLink` mark
 * (`marks.ts`) refuses exactly what a room name refuses and accepts exactly
 * what one accepts: an id minted somewhere other than `crypto.randomUUID`
 * passes, and an upper-cased spelling is canonicalized down rather than
 * becoming a second identity for one document.
 *
 * The reserved document ids above are not uuids, so they are refused here for
 * free: `_directory` and its siblings are rooms this workspace opens, never
 * documents a reader can be sent to.
 */
export function canonicalDocumentUuid(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const lowered = value.toLowerCase();
  return DOCUMENT_UUID.test(lowered) ? lowered : null;
}

/**
 * Assert that a room name is *canonical*: structurally a room name, and its
 * document segment either a uuid or one of the reserved names above.
 *
 * This is deliberately **not** part of {@link parseRoom}, which stays purely
 * structural. The hub calls `parseRoom` on every authentication, so tightening
 * it would not be a grammar tidy-up — it would silently become the enforcement
 * change, refusing existing rooms on whatever deploy happened to pick it up,
 * with no flag and no operator present. Keeping the closed grammar in a
 * separate function is what lets the enforcement step turn it on deliberately,
 * behind its own flag, and still claim that the flag off is behaviour-
 * identical.
 *
 * Nothing in this repository calls it yet; #222 is the first and only caller.
 *
 * @throws InvalidRoomError when the name is not structurally a room name, or
 * when its document segment is neither a lowercase uuid nor a reserved name.
 * @throws InvalidWorkspaceIdError when the first segment is not a workspace id.
 */
export function assertCanonicalRoom(room: string): void {
  const { uuid } = parseRoom(room);
  if (!DOCUMENT_UUID.test(uuid) && !CANONICAL_DOCUMENT_IDS.has(uuid)) {
    throw new InvalidRoomError(
      room,
      `the document segment ${JSON.stringify(uuid)} is neither a lowercase ` +
        "uuid nor a reserved name",
    );
  }
}

/** Whether {@link assertCanonicalRoom} accepts `room`. */
export function isCanonicalRoom(room: string): boolean {
  try {
    assertCanonicalRoom(room);
    return true;
  } catch (error) {
    if (
      error instanceof InvalidRoomError ||
      error instanceof InvalidWorkspaceIdError
    ) {
      return false;
    }
    throw error;
  }
}
