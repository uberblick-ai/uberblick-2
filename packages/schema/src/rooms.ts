/**
 * Room names.
 *
 * A room name is `<workspaceId>/<docUuid>`, and the directory doc of a
 * workspace lives at `<workspaceId>/_directory`. Tenancy sits in the room key
 * from day one so a hosted hub never needs a room migration; the spike runs one
 * configured workspace (`WORKSPACE_ID`, default `main`).
 */

import { InvalidRoomError } from "./errors.js";

/** The single workspace the spike runs in. */
export const DEFAULT_WORKSPACE = "main";

/** The document-id slot the directory doc occupies inside a workspace. */
export const DIRECTORY_SUFFIX = "_directory";

const SEPARATOR = "/";

function assertSegment(room: string, label: string, value: string): void {
  if (value === "") {
    throw new InvalidRoomError(room, `${label} is empty`);
  }
  if (value.includes(SEPARATOR)) {
    throw new InvalidRoomError(room, `${label} must not contain "${SEPARATOR}"`);
  }
}

/** The room name of one document. */
export function roomForDoc(workspaceId: string, uuid: string): string {
  const room = `${workspaceId}${SEPARATOR}${uuid}`;
  assertSegment(room, "workspaceId", workspaceId);
  assertSegment(room, "document uuid", uuid);
  return room;
}

/** The room name of a workspace's directory doc. */
export function directoryRoom(workspaceId: string = DEFAULT_WORKSPACE): string {
  return roomForDoc(workspaceId, DIRECTORY_SUFFIX);
}

export interface ParsedRoom {
  workspaceId: string;
  /** The document uuid, or `"_directory"` for a workspace's directory doc. */
  uuid: string;
  isDirectory: boolean;
}

/**
 * Split a room name into its workspace and document parts.
 *
 * A bare name with no separator is read as a document in {@link
 * DEFAULT_WORKSPACE}, so pre-tenancy room names still parse.
 *
 * @throws InvalidRoomError when the name has empty or extra segments.
 */
export function parseRoom(room: string): ParsedRoom {
  const separatorIndex = room.indexOf(SEPARATOR);
  if (separatorIndex === -1) {
    assertSegment(room, "document uuid", room);
    return {
      workspaceId: DEFAULT_WORKSPACE,
      uuid: room,
      isDirectory: room === DIRECTORY_SUFFIX,
    };
  }
  const workspaceId = room.slice(0, separatorIndex);
  const uuid = room.slice(separatorIndex + 1);
  assertSegment(room, "workspaceId", workspaceId);
  assertSegment(room, "document uuid", uuid);
  return { workspaceId, uuid, isDirectory: uuid === DIRECTORY_SUFFIX };
}
