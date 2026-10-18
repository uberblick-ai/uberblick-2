/**
 * Room keys are <bare-workspace-uuid>/<document-id>, with reserved directory,
 * sidebar and settings ids. Cosmetic slugs never enter tenancy or room identity.
 */

import { InvalidRoomError, InvalidWorkspaceIdError } from "./errors.js";
import { parseWorkspaceId } from "./workspace.js";

export const DIRECTORY_SUFFIX = "_directory";

export const SIDEBAR_SUFFIX = "_sidebar";

export const SETTINGS_SUFFIX = "_settings";

const SEPARATOR = "/";

/** Transport admission bound, independent of the structural and canonical grammars. */
export const MAX_ROOM_NAME_LENGTH = 128;

/** Keep room names bounded and free of log delimiters, including legacy rooms. */
export function isRoomNameWithinBounds(room: string): boolean {
  return room.length > 0 && room.length <= MAX_ROOM_NAME_LENGTH &&
    /^[A-Za-z0-9_/-]+$/.test(room);
}

function assertSegment(room: string, label: string, value: string): void {
  if (value === "") {
    throw new InvalidRoomError(room, `${label} is empty`);
  }
  if (value.includes(SEPARATOR)) {
    throw new InvalidRoomError(room, `${label} must not contain "${SEPARATOR}"`);
  }
}

/**
 * Accept decorated workspace input but emit one bare identity; invalid ids
 * refuse, with no default workspace.
 */
export function roomForDoc(workspaceId: string, uuid: string): string {
  const workspace = parseWorkspaceId(workspaceId, "workspaceId").uuid;
  const room = `${workspace}${SEPARATOR}${uuid}`;
  assertSegment(room, "document uuid", uuid);
  return room;
}

export function directoryRoom(workspaceId: string): string {
  return roomForDoc(workspaceId, DIRECTORY_SUFFIX);
}

export function sidebarRoom(workspaceId: string): string {
  return roomForDoc(workspaceId, SIDEBAR_SUFFIX);
}

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
 * Require exactly two nonempty segments and a bare workspace UUID. Accepting
 * a slug here would fork room storage and token comparisons for one identity.
 * Document grammar remains structural; assertCanonicalRoom closes it separately.
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
 * Reserved roots are rooms, not document links; runtimes decide hydration.
 */
const CANONICAL_DOCUMENT_IDS: ReadonlySet<string> = new Set([
  DIRECTORY_SUFFIX,
  SIDEBAR_SUFFIX,
  SETTINGS_SUFFIX,
]);

/**
 * Lowercase avoids distinct case-sensitive rooms for one UUID. Version and
 * variant nibbles stay unconstrained, allowing ids from other UUID generators.
 */
const DOCUMENT_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Links and decision edges share this UUID parser: lowercase mixed-case input
 * without creating a second identity, and refuse reserved workspace roots.
 */
export function canonicalDocumentUuid(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const lowered = value.toLowerCase();
  return DOCUMENT_UUID.test(lowered) ? lowered : null;
}

/**
 * Closed document grammar stays separate from structural parseRoom so callers
 * can opt into UUID/reserved-root enforcement without tightening all room reads.
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
