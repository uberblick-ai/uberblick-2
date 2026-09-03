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
import { endpointSourceLabel } from "../config.js";
import type { HubEndpoint } from "../config.js";
import type { RoomConnection } from "../collab/rooms.js";
import {
  backlogLabel,
  localCopyState,
  rawSyncState,
  useCalmSyncState,
} from "./calm.js";
import { statusReading } from "./status-reading.js";
import type { RemotePresence } from "./doc-chrome.js";
import { useRoomStatus } from "./hooks.js";
import { PeerAvatar } from "./PeerAvatar.js";

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
 * `connection` is the room the open document's status line reports on. Routes
 * without an open document have no sync-details surface.
 *
 * `endpoint` is passed rather than read here, because the address is resolved
 * once per session by an async read the shell already waits on (`hubUrl` throws
 * before it settles). Null is that in-between moment, and it says so.
 *
 * Its two rows are one answer to one question (#362): *which* hub is this
 * "synced" about. One machine legitimately runs several — the dev island and
 * the promoted remote — so a panel that named the state without naming the hub
 * let two tabs of one workspace both read "synced" while attached to different
 * worlds. The source is beside the address because falling back to compiled
 * values is exactly how a tab lands on the wrong one, and the address itself is
 * `config.ts`'s stripped label: an endpoint, never a credential.
 */
export function SyncPanel({
  connection,
  presence,
  endpoint,
  docPresent,
  onClose,
}: {
  connection: RoomConnection | null;
  /** Every remote session in that room, read once by the shell. */
  presence: readonly RemotePresence[];
  /** The endpoint the provider was constructed with, or null until resolved. */
  endpoint: HubEndpoint | null;
  /**
   * Whether the document this room is about has reached this replica — false
   * only while the address names one that has not. See {@link localCopyState}:
   * the local-copy fact is unknown rather than `available` there.
   */
  docPresent: boolean;
  onClose: () => void;
}): ReactElement {
  const status = useRoomStatus(connection);
  const raw = rawSyncState(status);
  const state = useCalmSyncState(raw, connection);
  // The same settled word the pill this panel opens from shows. Calm is a
  // cadence, never a quieter version of the truth (see calm.ts) — and two
  // different words in one corner of the screen would be worse than either.
  const reading = statusReading(status, state ?? raw);
  const localCopy = localCopyState(status, docPresent);
  const hasReading =
    connection !== null && (state !== null || reading.detail !== null);

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
        <Fact label="Hub" value={endpoint?.url ?? UNKNOWN} />
        {/* Always drawn, "served config" included: a reader checking which hub
            they are on is asking in the same breath who decided it. */}
        <Fact
          label="Source"
          value={endpoint === null ? UNKNOWN : endpointSourceLabel(endpoint.source)}
        />
        <Fact label="Room" value={connection?.room ?? UNKNOWN} />
        <Fact label="State" value={hasReading ? reading.word : UNKNOWN} />
        {/* Drawn only under a refusal (#448). This is the panel the pill opens,
            and the pill has room for the word alone — so the sentence saying
            what to do about it belongs here, and nowhere else. There is no such
            sentence for the ordinary states, so the row is absent rather than
            empty: a Reason row that read "—" three states out of four would be
            noise in the place a reader looks during an outage. */}
        {connection !== null && reading.detail !== null && (
          <Fact label="Reason" value={reading.detail} />
        )}
        {/* Always drawn, zero included: this is the panel someone opens to ask
            what the backlog is, and a row that vanished at zero would leave
            them unable to tell "nothing waiting" from "not reported". */}
        <Fact
          label="Backlog"
          value={
            connection === null ? UNKNOWN : backlogLabel(status.unsyncedChanges)
          }
        />
        {/* Same rule, and the reason the status line above no longer says this
            while everything is healthy (#535): the promise that this browser
            holds a durable copy belongs where somebody went looking for it.
            Drawn in every state, `—` until the local read settles — before then
            "unavailable" would be this panel guessing at a read still running. */}
        <Fact
          label="Local copy"
          value={
            connection === null || localCopy === null
              ? UNKNOWN
              : localCopy
                ? "available"
                : "unavailable"
          }
        />
      </dl>
      <h2 className="ub-rail-head">Present now</h2>
      {presence.length === 0 ? (
        <p className="ub-muted">Nobody else is in this room.</p>
      ) : (
        <ul className="ub-presence">
          {presence.map((session) => (
            <li key={session.clientId} className="ub-presence-row">
              {/* The same avatar the peer strip draws, decorative here: this
                  is a list, so the name stays in words and is the row's
                  accessible name. A labelled avatar would announce every
                  session twice. */}
              <PeerAvatar session={session} />
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
