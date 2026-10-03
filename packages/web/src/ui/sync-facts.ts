/** One derivation for the document status line and its details panel. */

import type { RoomStatus } from "../collab/rooms.js";
import type { NotSharedReason } from "../shell/document-search.js";
import type { SyncState } from "./calm.js";
import type { StatusReading } from "./status-reading.js";

export interface DocumentSyncFacts {
  /** The connection or local-durability reading. Null while it has not settled. */
  primary: string | null;
  primaryTone: SyncState | null;
  /** The upstream acknowledgement reading. Null means unknown, never false. */
  hub: string | null;
  hubTone: SyncState | null;
  /** The cause for a current not-shared reading, independent of local saving. */
  hubDetail: string | null;
  /** Whether this is the locally served two-fact presentation. */
  twoFact: boolean;
}

/**
 * Name the facts the two document-chrome surfaces render.
 *
 * `hubAcked` uses three states deliberately: undefined is a page connected
 * directly to its hub, null is a locally served page with no current usable
 * answer, and a boolean is the answer for this room. Refusals and an unwritable
 * room preserve the existing cause-first reading and suppress the upstream
 * fact; "not saved" must never sit beside a more optimistic secondary claim.
 */
export function documentSyncFacts(
  status: RoomStatus,
  state: SyncState | null,
  reading: StatusReading,
  hubAcked: boolean | null | undefined,
  notSharedReason: NotSharedReason | null = null,
): DocumentSyncFacts {
  const blank = state === null && reading.detail === null;
  const twoFact =
    hubAcked !== undefined && reading.detail === null && status.writable;
  if (!twoFact) {
    return {
      primary: blank ? null : reading.word,
      primaryTone: blank ? null : reading.detail === null ? state : reading.tone,
      hub: null,
      hubTone: null,
      hubDetail: null,
      twoFact: false,
    };
  }

  const primary =
    state === null
      ? null
      : state === "synced"
        ? "saved here"
        : state === "syncing"
          ? "saving here…"
          : reading.word;
  const localOnly = notSharedReason !== null && hubAcked !== null && state !== null;
  const hub =
    state === null || hubAcked === null
      ? null
      : localOnly
        ? "not shared with hub"
        : hubAcked
        ? "synced with hub"
        : "not synced with hub";
  return {
    primary,
    primaryTone: state,
    hub,
    hubTone: hubAcked === null ? null : localOnly || !hubAcked ? "offline" : "synced",
    hubDetail: localOnly ? "this machine has no credentials for its hub" : null,
    twoFact: true,
  };
}
