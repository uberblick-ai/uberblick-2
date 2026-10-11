/**
 * Use one refusal precedence on every status surface. Refusal outranks calm
 * connected/synced state; tokenMissing outranks a retained authFailed because
 * no request was sent. Callers compute calm unconditionally before early
 * returns and pass it into this pure derivation.
 */

import { AUTH_REJECTED } from "@uberblick/hub/protocol";
import type { RoomStatus } from "../collab/rooms.js";
import type { SyncState } from "./calm.js";

/**
 * Missing-token recovery is local text, distinct from a hub refusal: no
 * request was sent and no remote prose may be echoed.
 */
export const TOKEN_MISSING =
  "this app was served without a hub token, so it cannot authenticate — the " +
  "deployment serving it is incomplete; this document is not saved";

export const STORE_REFUSED =
  "the server refused this edit; this document is not saved — reload to reconnect";

export interface StatusReading {
  /** The one word for the surface's status slot. */
  word: string;
  /**
   * Null detail marks ordinary state; consumers may keep their own ordinary
   * words or omit their refusal row.
   */
  detail: string | null;
  /** Which of the three tints to draw. Every refusal is drawn as `offline`. */
  tone: SyncState;
}

/**
 * The sidebar uses raw state and reads word only for a non-null refusal
 * detail; document surfaces pass their settled calm state.
 */
export function statusReading(status: RoomStatus, settled: SyncState): StatusReading {
  const mismatch = status.protocolMismatch;
  if (mismatch !== null) {
    // Protocol mismatch is terminal until updated, unlike ordinary offline
    // state. Both numbers are validated and the sentence is local, never hub
    // prose.
    return {
      word: "update required",
      detail:
        (mismatch.hub > mismatch.client
          ? "this app is older than the hub — update it and reload"
          : "the hub is older than this app — update the hub") +
        ` (app ${mismatch.client}, hub ${mismatch.hub}); this document is not saved`,
      tone: "offline",
    };
  }
  if (status.storeRefused) {
    return { word: "edit refused", detail: STORE_REFUSED, tone: "offline" };
  }
  if (status.tokenMissing) {
    // Unlike the reading above, not terminal: `collab/rooms.ts` re-reads the
    // served configuration before every connect attempt, and the flag clears
    // the moment a secret arrives.
    return { word: "no hub token", detail: TOKEN_MISSING, tone: "offline" };
  }
  if (status.authFailed) {
    // Composed locally, never the hub's words — see AUTH_REJECTED. Not
    // terminal either: the socket keeps retrying and an accepted token clears
    // the flag, so the reading goes back to the ordinary three on its own.
    return {
      word: "not authorized",
      detail: `${AUTH_REJECTED}; this document is not saved`,
      tone: "offline",
    };
  }
  return {
    word: settled === "syncing" ? "syncing…" : settled,
    detail: null,
    tone: settled,
  };
}
