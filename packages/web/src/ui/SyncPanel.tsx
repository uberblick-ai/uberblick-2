/**
 * The sync and presence detail panel (#72, design surface 1e's right column):
 * what this client knows about its connection, and who else is in the room.
 *
 * Every line is a *reading* of state the client already holds — the resolved
 * hub endpoint, the room key, the provider's status, the awareness map. When
 * `ub open` serves the page, the shell also supplies its latest local
 * `/api/status` answer. The panel never asks the remote hub directly and the
 * local durability reading never waits on that HTTP fact.
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
import type { NotSharedReason } from "../shell/document-search.js";
import { backlogLabel, rawSyncState, useCalmSyncState } from "./calm.js";
import { statusReading } from "./status-reading.js";
import { documentSyncFacts } from "./sync-facts.js";
import type { RemotePresence } from "./doc-chrome.js";
import { useRoomStatus } from "./hooks.js";
import { PeerAvatar } from "./PeerAvatar.js";
import { formatExactTimestamp } from "./timestamps.js";

/** What a fact reads as before this client knows it. */
const UNKNOWN = "—";

function Fact({
  label,
  value,
}: {
  label: string;
  value: string | ReactElement;
}): ReactElement {
  return (
    <div className="ub-sync-fact flex items-baseline gap-2 py-[0.15rem]">
      <dt className="w-[4.5rem] flex-none text-xs/[1.5] text-(--muted-foreground)">
        {label}
      </dt>
      {/* Identifiers and exact timestamps wrap inside the panel. */}
      <dd className="m-0 min-w-0 font-mono text-xs/[1.5] [overflow-wrap:anywhere]">
        {value}
      </dd>
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
 * The hub rows answer which hub an upstream fact is about (#362). One machine
 * legitimately runs several — the local serving process and the promoted
 * remote — so a panel that named the state without naming the remote would
 * overclaim during an outage. The address is `config.ts`'s stripped label: an
 * endpoint, never a credential.
 */
export function SyncPanel({
  connection,
  presence,
  endpoint,
  hubAcked,
  notSharedReason = null,
  lastUpdated,
  onClose,
}: {
  connection: RoomConnection | null;
  /** Every remote session in that room, read once by the shell. */
  presence: readonly RemotePresence[];
  /** The endpoint the provider was constructed with, or null until resolved. */
  endpoint: HubEndpoint | null;
  /** `ub open`'s upstream reading; undefined when this page talks to a hub. */
  hubAcked?: boolean | null | undefined;
  notSharedReason?: NotSharedReason | null;
  /** The stamp currently shown by the status line; absent while it omits it. */
  lastUpdated?: number | undefined;
  onClose: () => void;
}): ReactElement {
  const status = useRoomStatus(connection);
  const raw = rawSyncState(status);
  const state = useCalmSyncState(raw, connection);
  // The same settled word the pill this panel opens from shows. Calm is a
  // cadence, never a quieter version of the truth (see calm.ts) — and two
  // different words in one corner of the screen would be worse than either.
  const reading = statusReading(status, state ?? raw);
  const facts = documentSyncFacts(status, state, reading, hubAcked, notSharedReason);
  const reason = reading.detail ?? facts.hubDetail;
  const hasReading = connection !== null && facts.primary !== null;
  const namedEndpoint = hubAcked !== undefined && !facts.twoFact ? null : endpoint;
  const updated =
    lastUpdated === undefined ? null : formatExactTimestamp(lastUpdated);

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
        <Fact label="Hub" value={namedEndpoint?.url ?? UNKNOWN} />
        {/* Always drawn, "served config" included: a reader checking which hub
            they are on is asking in the same breath who decided it. */}
        <Fact
          label="Source"
          value={
            namedEndpoint === null
              ? UNKNOWN
              : endpointSourceLabel(namedEndpoint.source)
          }
        />
        <Fact label="Room" value={connection?.room ?? UNKNOWN} />
        <Fact
          label="State"
          value={hasReading ? (facts.primary ?? UNKNOWN) : UNKNOWN}
        />
        {facts.twoFact && (
          <Fact label="Hub state" value={facts.hub ?? UNKNOWN} />
        )}
        {/* Refusals and known not-shared causes explain their own reading.
            Ordinary states have no cause to name, so this row stays absent. */}
        {connection !== null && reason !== null && (
          <Fact label="Reason" value={reason} />
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
        {updated !== null && (
          <Fact
            label="Last updated"
            value={<time dateTime={updated.dateTime}>{updated.label}</time>}
          />
        )}
      </dl>
      <h2 className="ub-rail-head">Present now</h2>
      {presence.length === 0 ? (
        <p className="ub-muted">Nobody else is in this room.</p>
      ) : (
        <ul className="ub-presence">
          {presence.map((session) => (
            <li
              key={session.clientId}
              className="ub-presence-row flex min-w-0 items-baseline gap-[0.4rem]"
            >
              {/* The same avatar the peer strip draws, decorative here: this
                  is a list, so the name stays in words and is the row's
                  accessible name. A labelled avatar would announce every
                  session twice. */}
              <PeerAvatar session={session} />
              <span className="ub-presence-name min-w-0 [overflow-wrap:anywhere]">
                {session.name}
              </span>
              {/* Only where the caret resolves to a block a reader can see.
                  Silence beats a number the document disagrees with. */}
              {session.block !== null && (
                <span className="ub-muted shrink-0 whitespace-nowrap">
                  block {session.block}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
}
