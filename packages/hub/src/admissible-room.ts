import { isCanonicalRoom, isRoomNameWithinBounds } from "@uberblick/schema";

/** Older clients still open this reserved room; no current client writes it. */
const LEGACY_ROOM_SUFFIX = "/_feedback";

/**
 * Only canonical rooms become stored rows: an uppercase alias of a deleted uuid
 * would escape its fence, and free-form names give members unbounded storage.
 */
export function isAdmissibleRoom(room: string): boolean {
  if (!isRoomNameWithinBounds(room)) return false;
  return isCanonicalRoom(room) || (room.endsWith(LEGACY_ROOM_SUFFIX) &&
    isCanonicalRoom(`${room.slice(0, -LEGACY_ROOM_SUFFIX.length)}/_directory`));
}
