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
  /** The serving run's last answered cause, independent of room acknowledgement. */
  hubDetail: string | null;
  /** Whether this is the locally served two-fact presentation. */
  twoFact: boolean;
}

/**
 * hubAcked distinguishes direct hub (undefined), unknown local upstream
 * (null) and this room's boolean answer. Refusals or unwritable rooms take
 * precedence and suppress optimistic upstream claims beside not saved.
 */
export function documentSyncFacts(
  status: RoomStatus,
  state: SyncState | null,
  reading: StatusReading,
  hubAcked: boolean | null | undefined,
  notSharedReason: NotSharedReason | null = null,
  localWorkspace = false,
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
  if (localWorkspace) {
    return { primary, primaryTone: state, hub: null, hubTone: null, hubDetail: null, twoFact: true };
  }
  const localOnly = notSharedReason !== null;
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
    hubDetail: notSharedReason === null ? null : NOT_SHARED_DETAIL[notSharedReason],
    twoFact: true,
  };
}

/** Locally composed actions: the remote hub supplies no prose to the page. */
const NOT_SHARED_DETAIL: Record<NotSharedReason, string> = {
  "no-hub-credentials": "this machine has no credentials for its hub",
  "sign-in-required": "sign-in required — run ub auth login for this hub on this machine",
  "no-workspace-access": "no access to this workspace — ask its administrator for membership; this machine will retry with its existing login",
  "credential-store": "this machine cannot read its login — run ub auth status and follow its credential-store recovery",
  "renewal-unavailable": "this hub cannot renew the login — ask its operator to configure sign-in",
};
