/**
 * Workspace settings (#485): the sidebar's second mode, and the one page it has.
 *
 * The address is the mode. `/<workspace>/settings` is the whole of it — there is
 * no page segment, so General is not a route but simply what the mode shows, and
 * Back is a fixed address rather than a remembered document. That is the same
 * rule the rest of the app runs on (#68): the address bar is the selection, so
 * a pasted link, the footer's gear row and browser Back are one gesture.
 *
 * The page is *facts*, and every one of them is state this client already holds
 * — the workspace the address names, the directory it has joined, the endpoint
 * resolved at boot, the provider's status, the browser's own storage estimate.
 * No new persistence and no new RPC, for the reason the sync panel gives: a page
 * that had to ask the hub how it was doing would have nothing to show in exactly
 * the outage it exists for.
 *
 * Nothing here is writable. Rename and the further pages are deferred owner
 * decisions, and the tag catalog *Tagging system* names as this surface's
 * curation work is #632 — the mode is what this increment lands.
 */

import type { ReactElement } from "react";
import { directoryRoom, listDirectory } from "@uberblick/schema";
import { endpointSourceLabel } from "../config.js";
import type { HubEndpoint } from "../config.js";
import type { AwarenessUser } from "../collab/identity.js";
import type { RoomConnection } from "../collab/rooms.js";
import { rawSyncState, useCalmSyncState } from "./calm.js";
import { useRoomStatus } from "./hooks.js";
import { statusReading } from "./status-reading.js";
import { UserMenu, formatBytes, useLocalCacheSize } from "./UserMenu.js";
import type { Workspace } from "./route.js";

/** What a fact reads as before this client knows it — the sync panel's mark. */
const UNKNOWN = "—";

function Fact({ label, value }: { label: string; value: string }): ReactElement {
  return (
    <div className="ub-panel-fact">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

/**
 * The sidebar in settings mode: back out, where you are, and who this client is.
 *
 * The same column as the document sidebar (`.ub-list`), because it is the same
 * column — the mode swaps its contents, not the furniture. The user card at the
 * foot is unchanged and deliberately so: it is about this client, which is true
 * in either mode.
 */
export function SettingsNav({
  workspace,
  identity,
  agentSessions,
  onBack,
  onOpenGeneral,
}: {
  /** The workspace the address names — Back returns to it, spelled as typed. */
  workspace: Workspace;
  identity: AwarenessUser;
  agentSessions: number;
  onBack: () => void;
  /**
   * The settings address itself. General is the only page, so choosing it is a
   * navigation to where the reader already is — `navigate` drops that rather
   * than growing a history entry Back would bounce off.
   */
  onOpenGeneral: () => void;
}): ReactElement {
  return (
    <nav className="ub-list">
      {/* The switcher's shape, in the switcher's place: leaving settings is the
          header of the column it leaves. The tile carries a chevron rather than
          a letter, which is the one thing that says this row goes back. Its own
          class, not the switcher's, so that nothing selecting the sidebar header
          finds two of them for the length of a slide. */}
      {/* `data-swap-focus`: the row a mode swap hands focus to (App.tsx). */}
      <button type="button" className="ub-back-entry" data-swap-focus onClick={onBack}>
        <span className="ub-identity-tile ub-workspace-tile" aria-hidden="true">
          <BackChevron />
        </span>
        <span className="ub-workspace-identity">
          <span className="ub-workspace-count">Back to</span>
          {/* A segment can be a bare uuid, so the whole of it is on the hover. */}
          <span className="ub-workspace-name" title={workspace.segment}>
            {workspace.segment}
          </span>
        </span>
      </button>
      <section className="ub-nav">
        <p className="ub-nav-label">Workspace settings</p>
        <ul>
          <li>
            <button type="button" aria-current="page" onClick={onOpenGeneral}>
              <SettingsIcon />
              General
            </button>
          </li>
        </ul>
      </section>
      <div className="ub-list-foot">
        <UserMenu identity={identity} agentSessions={agentSessions} />
      </div>
    </nav>
  );
}

/**
 * The General page: what this client knows about the workspace it is in.
 *
 * Each fact keeps the unknown reading its own source already has. The
 * endpoint-shaped ones print `—` before the boot read settles, the way the sync
 * panel's do; the local-cache row is omitted outright where the browser
 * declines to estimate, the way the user panel's is. An omitted row says less
 * than an invented one, and a made-up `0` would be worse than either.
 */
export function WorkspaceSettings({
  workspace,
  connection,
  endpoint,
  agentSessions,
}: {
  workspace: Workspace;
  /**
   * The workspace's directory room: the connection fact reports on it, and the
   * document count is read out of it.
   */
  connection: RoomConnection | null;
  /** The endpoint the provider was constructed with, or null until resolved. */
  endpoint: HubEndpoint | null;
  /** MCP sessions in the workspace right now — see `useAgentSessions`. */
  agentSessions: number;
}): ReactElement {
  const status = useRoomStatus(connection);
  const settled = useCalmSyncState(rawSyncState(status));
  /**
   * The status line's own reading, not a second derivation of it (#448): a
   * refusal — a protocol mismatch, a missing token, a hub that said no — reads
   * here in the words it reads in everywhere else, and carries the sentence
   * saying what to do about it.
   */
  const reading = statusReading(status, settled);
  const cache = useLocalCacheSize(true);
  /**
   * How many documents this workspace holds — `null` until this replica has
   * answered about *this* workspace's directory.
   *
   * Read from the connection rather than from a count passed in, and from
   * `connection.status` rather than from the state above, because both of those
   * lag the address by one commit: on the render where the workspace changes,
   * a count derived elsewhere and a status read into state still belong to the
   * workspace just left, and the room the address names has not been read at
   * all. Printing `0` there is a definite claim about a corpus nobody has
   * looked in yet — the one thing a facts page must not do. The room is
   * compared as well as the flag, so this promise holds whatever a caller hands
   * it.
   *
   * Live without an observer of its own: the shell holds the directory's
   * listing and this page subscribes to the same room's status, so every change
   * that could move this number already re-renders the page, and the read is of
   * the document as it is at that moment.
   */
  const answered =
    connection !== null &&
    connection.room === directoryRoom(workspace.uuid) &&
    connection.status.localReplicaLoaded;
  const docs = answered ? listDirectory(connection.ydoc).length : null;

  return (
    <section className="ub-pane">
      <div className="ub-column">
        <h1 className="ub-settings-heading">General</h1>
        <dl className="ub-panel-facts ub-settings-facts">
          {/* The identity, then how this address spells it: the slug is display
              (route.ts), and only the uuid reaches a room key. */}
          <Fact label="Workspace" value={workspace.uuid} />
          <Fact label="Address" value={workspace.segment} />
          <Fact label="Documents" value={docs === null ? UNKNOWN : String(docs)} />
          <Fact label="Hub" value={endpoint?.url ?? UNKNOWN} />
          <Fact
            label="Source"
            value={endpoint === null ? UNKNOWN : endpointSourceLabel(endpoint.source)}
          />
          <Fact label="Connection" value={reading.word} />
          {/* Only under a refusal, like the sync panel's Reason row: there is no
              such sentence for the ordinary states. */}
          {reading.detail !== null && <Fact label="Reason" value={reading.detail} />}
          {/* The browser estimates per origin, not per workspace, and this page
              is about one workspace — so the label says whose figure it is
              rather than letting the row read as this corpus's. */}
          {cache !== null && (
            <Fact label="Local cache (all workspaces)" value={formatBytes(cache)} />
          )}
          <Fact label="MCP connections" value={String(agentSessions)} />
        </dl>
      </div>
    </section>
  );
}

/**
 * The back row's mark, and the settings row's — drawn rather than pulled from an
 * icon set, for the reason every other glyph here is (#110): two 16px marks are
 * not worth a dependency, and `currentColor` is what lets a row tint its own.
 */
function BackChevron(): ReactElement {
  return (
    <svg className="ub-back-caret" viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M9.5 3.5 L5 8 L9.5 12.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function SettingsIcon(): ReactElement {
  return (
    <svg className="ub-nav-icon" viewBox="0 0 16 16" aria-hidden="true">
      {/* Two settings sliders. A cogwheel at 16px is a ring of teeth that turns
          to mush at one device pixel; two tracks with a knob each stay legible
          and say the same thing. */}
      <path
        d="M2.5 5.5h3 M8.5 5.5h5 M2.5 10.5h5 M10.5 10.5h3"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
      <circle cx="7" cy="5.5" r="1.5" fill="none" stroke="currentColor" strokeWidth="1.2" />
      <circle cx="9" cy="10.5" r="1.5" fill="none" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}
