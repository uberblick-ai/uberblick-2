/**
 * What a room's status reads as, in one place (#448).
 *
 * Three surfaces report connection state — the sync panel, the sidebar's
 * directory line and the document status line — and before this each
 * re-derived its own reading. Only the status line read the failure flags, so a
 * page served without a secret, or one whose token the hub refused, said
 * `syncing…` elsewhere and sent the reader off to restart things at random.
 *
 * The precedence below is the status line's, unchanged, and the words are the
 * ones it already shipped. Two properties of it are load-bearing:
 *
 * - **A refusal is read before `connected`/`synced`, not after.** A protocol
 *   mismatch halts the socket, which settles `connected` to false, so a reading
 *   that consulted the calm state first would call a page that will never sync
 *   again merely `offline` — true about the socket, misleading about the fix.
 * - **`tokenMissing` outranks `authFailed`**, because `authFailed` can still be
 *   carrying a refusal from before the secret went missing, and "the hub
 *   refused us" would then name the wrong half: nothing was sent this time.
 *
 * Calm belongs to the caller. `useCalmSyncState` must be called unconditionally
 * — before any early return — so the settled state is passed in rather than
 * computed here, and this stays a pure function of what the caller already has.
 */

import { AUTH_REJECTED } from "@uberblick/hub/protocol";
import type { RoomStatus } from "../collab/rooms.js";
import type { SyncState } from "./calm.js";

/**
 * What a reader is told when no token could be minted at all (#426).
 *
 * Composed here rather than shared with `AUTH_REJECTED`: nothing was sent, so
 * the hub has said nothing, and this names the one thing that can be acted on —
 * the app was served without the secret it needs. Local text by construction:
 * the missing value is the whole subject, so there is nothing remote to echo.
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
   * Why, in a sentence, under a refusal — and `null` when nothing is refused.
   *
   * Null is the discriminator every surface reads: it is what says "this is the
   * ordinary reading", so a surface with its own non-refused wording (the
   * sidebar) knows when to use it, and one with a detail row (the sync panel)
   * knows when to draw it.
   */
  detail: string | null;
  /** Which of the three tints to draw. Every refusal is drawn as `offline`. */
  tone: SyncState;
}

/**
 * The reading for `status`, given the settled calm state the caller computed.
 *
 * A caller that keeps its own words for the non-refused case — the sidebar says
 * `directory synced`, not `synced` — passes the raw state and uses only `word`
 * under a non-null `detail`.
 */
export function statusReading(status: RoomStatus, settled: SyncState): StatusReading {
  const mismatch = status.protocolMismatch;
  if (mismatch !== null) {
    // A reading of its own, not a fourth sync state: the three below describe a
    // connection that is working or coming back, and this one describes a page
    // that will not sync again until somebody updates something. Nothing here
    // is the hub's text — both numbers were validated before they arrived.
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
