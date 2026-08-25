/**
 * Room names.
 *
 * A room name is `<workspaceId>/<docUuid>`. A workspace's two well-known docs
 * take reserved document-id slots: the directory at `<workspaceId>/_directory`
 * and the sidebar at `<workspaceId>/_sidebar`. Tenancy sits in the room key
 * from day one so a hosted hub never needs a room migration.
 *
 * The workspace segment is always the **bare uuid** (see `workspace.ts`): a
 * decorated `<slug>-<uuid>` is parsed here and only its uuid reaches the name,
 * so two spellings of one workspace name one room. There is no default
 * workspace — a room name says which workspace it belongs to, or it is not a
 * room name.
 */

import { InvalidRoomError } from "./errors.js";
import { parseWorkspaceId } from "./workspace.js";

/** The document-id slot the directory doc occupies inside a workspace. */
export const DIRECTORY_SUFFIX = "_directory";

/** The document-id slot the sidebar doc occupies inside a workspace. */
export const SIDEBAR_SUFFIX = "_sidebar";

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

export interface ParsedRoom {
  /** The workspace's uuid, never a decorated spelling of it. */
  workspaceId: string;
  /** The document uuid, or `"_directory"` for a workspace's directory doc. */
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
