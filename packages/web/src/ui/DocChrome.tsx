/**
 * The doc view's chrome (#69, design surface 1a): what the topbar says about
 * the open document, and the identity line above its prose.
 *
 * Everything here is a reading of state the system already keeps — the
 * document's tags, its uuid and rev, the awareness of whoever else is in the
 * room, the provider's connection status. None of it is new state, and nothing
 * here writes.
 *
 * The two pills are drawn on the same rules as the rest of the chrome (#76):
 * fixed slots and no growth, so a peer arriving or the hub going away swaps
 * words in place rather than moving the header around them.
 */

import type { ReactElement } from "react";
import type { DocMeta } from "@uberblick/schema";
import type { RoomConnection } from "../collab/rooms.js";
import { rawSyncState, useCalmSyncState } from "./calm.js";
import { groupKeyForTags, groupLabel } from "./groups.js";
import { useDocRev, useRemoteActivity, useRoomStatus, useThreads } from "./hooks.js";

/** What an untitled document is called wherever its name is shown. */
const UNTITLED = "Untitled";

function titleOf(meta: DocMeta): string {
  return meta.title === "" ? UNTITLED : meta.title;
}

/** The document's group: the first canonical tag it carries (#39's rule). */
function groupOf(meta: DocMeta): string {
  return groupLabel(groupKeyForTags(meta.tags));
}

/**
 * `<group> / <title>` for the open document.
 *
 * The group comes from the document's own `meta.tags`, which is what makes a
 * retag land here immediately — and it is the same derivation the sidebar
 * groups by, so the breadcrumb and the list agree on where a document lives.
 */
function Breadcrumb({ meta }: { meta: DocMeta }): ReactElement {
  return (
    <nav className="ub-crumb" aria-label="Breadcrumb">
      <span className="ub-crumb-group">{groupOf(meta)}</span>
      <span className="ub-crumb-sep" aria-hidden="true">
        /
      </span>
      <span className="ub-crumb-title">{titleOf(meta)}</span>
    </nav>
  );
}

/**
 * The doc chrome in the topbar: the breadcrumb, and the two pills on the right.
 *
 * `connection` is the room whose status the connection pill reports and whose
 * awareness the activity pill reads. The app hands it the open document's room,
 * falling back to the directory room when no document is open: the socket is
 * shared, so the directory's status is the same truth about the same hub — and
 * a document list that reads "offline" while it is plainly listing documents
 * would be the one thing #37 exists to prevent.
 */
export function DocChrome({
  connection,
  meta,
  threadsOpen,
  onToggleThreads,
}: {
  connection: RoomConnection | null;
  /** The open document's metadata, or null when none is open or read yet. */
  meta: DocMeta | null;
  /** Whether the threads rail is open as a drawer — see `.ub-rail-open`. */
  threadsOpen: boolean;
  onToggleThreads: () => void;
}): ReactElement {
  const activity = useRemoteActivity(connection);
  // The rail's own count, read the same way the rail reads it: open threads, not
  // every conversation the document has ever had.
  const openThreads = useThreads(connection).filter((thread) => !thread.resolved);
  const state = useCalmSyncState(rawSyncState(useRoomStatus(connection)));
  const label = state === "syncing" ? "syncing…" : state;
  // `meta.uuid === ""` is a room that answered with nothing in it — see
  // `useDocMeta`. There is no document to name, so the breadcrumb says nothing.
  const named = meta !== null && meta.uuid !== "";
  return (
    <>
      {named && <Breadcrumb meta={meta} />}
      <span className="ub-chrome-pills">
        {/* The drawer's handle (#101). Below 1100px there is no room for the
            rail beside the prose, so it is hidden and this opens it as an
            overlay instead; above that width the rail is already on screen and
            the stylesheet drops this button. A document with nothing to say has
            no handle either. */}
        {openThreads.length > 0 && (
          <button
            type="button"
            className="ub-threads-toggle"
            aria-expanded={threadsOpen}
            aria-controls="ub-rail"
            onClick={onToggleThreads}
          >
            Threads <span className="ub-muted">{openThreads.length}</span>
          </button>
        )}
        {activity !== null && (
          <span
            className="ub-pill ub-pill-agent"
            // The session's presence colour, the same one its cursor carries in
            // the prose — the pill and the caret are one identity in two places.
            style={{ borderColor: activity.color, color: activity.color }}
          >
            {activity.name} editing block {activity.block}
          </span>
        )}
        <span className={`ub-pill ub-pill-${state}`}>
          <span className="ub-status-mark" aria-hidden="true">
            {state === "syncing" ? (
              <span className="ub-spinner" />
            ) : (
              <span
                className={`ub-dot ${state === "synced" ? "ub-dot-live" : "ub-dot-off"}`}
              />
            )}
          </span>
          {/* The same fixed-width slot the status line uses: "syncing…" is the
              longest of the three words, so the pill never changes size and
              nothing beside it moves. */}
          <span className="ub-status-word">{label}</span>
        </span>
      </span>
    </>
  );
}

/**
 * The document's identity, above its prose: what kind of document this is, and
 * the two machine facts that identify the thing on screen.
 *
 * The uuid is shortened because identity is the uuid but *recognition* is its
 * first few characters — the full one is a click away on the room key below the
 * title. The rev is the whole document's, folded from its block revs
 * (`docRev`), so it moves on every edit; it sits in a fixed-width monospace slot
 * for that reason, since a rev that changed the width of this line would drag
 * the line around while somebody types.
 */
export function DocMetaLine({
  connection,
  meta,
}: {
  connection: RoomConnection;
  meta: DocMeta | null;
}): ReactElement | null {
  const rev = useDocRev(connection);
  if (meta === null || meta.uuid === "") return null;
  return (
    <p className="ub-doc-meta">
      <span className="ub-badge">{groupOf(meta)}</span>
      <span className="ub-doc-ids">
        uuid {meta.uuid.slice(0, 8)} · rev {rev ?? "········"}
      </span>
    </p>
  );
}
