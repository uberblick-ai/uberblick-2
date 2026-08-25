/**
 * The sync and presence detail panel (#72, design surface 1e's right column):
 * what this client knows about its connection, and who else is in the room.
 *
 * Every line is a *reading* of state the client already holds — the resolved
 * hub endpoint, the room key, the provider's status, the awareness map. There
 * is no new persistence, no new RPC, and nothing here asks the hub a question:
 * a panel that had to call out to say whether it was connected would have
 * nothing to show in exactly the outage it exists for.
 *
 * That rule is also why the mockup's local-update count is missing rather than
 * filled in: the web client keeps no local update log, so the number has no
 * source here. An omitted row says less than an invented one.
 */

import { useEffect } from "react";
import type { ReactElement } from "react";
import type { RoomConnection } from "../collab/rooms.js";
import { backlogLabel, rawSyncState, useCalmSyncState } from "./calm.js";
import type { RemotePresence } from "./doc-chrome.js";
import { useRoomStatus } from "./hooks.js";

/** What a fact reads as before this client knows it. */
const UNKNOWN = "—";

function Fact({ label, value }: { label: string; value: string }): ReactElement {
  return (
    <div className="ub-sync-fact">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

/**
 * The panel. Rendered only while open — an overlay nobody asked for should not
 * be in the tree keeping observers on the document.
 *
 * `connection` is the room the topbar's pill reports on: the open document's,
 * or the directory's when no document is open. The socket is shared, so either
 * is the same truth about the same hub.
 *
 * `endpoint` is passed rather than read here, because the address is resolved
 * once per session by an async read the shell already waits on (`hubUrl` throws
 * before it settles). Null is that in-between moment, and it says so.
 */
export function SyncPanel({
  connection,
  presence,
  endpoint,
  onClose,
}: {
  connection: RoomConnection | null;
  /** Every remote session in that room, read once by the shell — see `DocChrome`. */
  presence: readonly RemotePresence[];
  /** The endpoint the provider was constructed with, or null until resolved. */
  endpoint: string | null;
  onClose: () => void;
}): ReactElement {
  const status = useRoomStatus(connection);
  // The same settled word the pill this panel opens from shows. Calm is a
  // cadence, never a quieter version of the truth (see calm.ts) — and two
  // different words in one corner of the screen would be worse than either.
  const state = useCalmSyncState(rawSyncState(status));

  /**
   * Escape closes the panel, and the panel alone.
   *
   * Registered in the *capture* phase on `window`, which runs before every
   * bubble-phase listener there — the threads drawer's (#101) is one — and the
   * event is then consumed. This panel is the topmost layer while it is open,
   * so one keypress must dismiss one thing: without this, an Escape with both
   * open reached both listeners and closed both. `preventDefault` is what the
   * drawer's own rule reads; stopping propagation as well is what keeps a
   * control *underneath* the panel from acting on a key aimed at the panel.
   *
   * An Escape somebody else already handled is left alone, for the same reason
   * the drawer leaves one alone: two gestures, and the reader made one.
   */
  useEffect(() => {
    const close = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      onClose();
    };
    window.addEventListener("keydown", close, true);
    return () => window.removeEventListener("keydown", close, true);
  }, [onClose]);

  return (
    <aside
      id="ub-sync-panel"
      className="ub-sync-panel"
      aria-label="Sync and presence"
    >
      <div className="ub-sync-head">
        <h2 className="ub-rail-head">Sync</h2>
        <button
          type="button"
          className="ub-tool"
          aria-label="Close sync details"
          onClick={onClose}
        >
          ×
        </button>
      </div>
      <dl className="ub-sync-facts">
        <Fact label="Hub" value={endpoint ?? UNKNOWN} />
        <Fact label="Room" value={connection?.room ?? UNKNOWN} />
        <Fact label="State" value={state === "syncing" ? "syncing…" : state} />
        {/* Always drawn, zero included: this is the panel someone opens to ask
            what the backlog is, and a row that vanished at zero would leave
            them unable to tell "nothing waiting" from "not reported". */}
        <Fact label="Backlog" value={backlogLabel(status.unsyncedChanges)} />
      </dl>
      <h2 className="ub-rail-head">Present now</h2>
      {presence.length === 0 ? (
        <p className="ub-muted">Nobody else is in this room.</p>
      ) : (
        <ul className="ub-presence">
          {presence.map((session) => (
            <li key={session.clientId} className="ub-presence-row">
              {/* The session's own awareness colour, the one its cursor carries
                  in the prose. Written inline for the reason identity.ts gives:
                  the palette is `#rrggbb` literals, not tokens. */}
              <span
                className="ub-presence-dot"
                style={{ background: session.color }}
                aria-hidden="true"
              />
              <span className="ub-presence-name">{session.name}</span>
              {/* Only where the caret resolves to a block a reader can see.
                  Silence beats a number the document disagrees with. */}
              {session.block !== null && (
                <span className="ub-muted">block {session.block}</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
}
