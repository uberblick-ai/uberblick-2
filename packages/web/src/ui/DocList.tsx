/**
 * The document list, fed by the directory doc — never by locally-observed
 * creations. A fresh tab with empty local state learns the whole corpus by
 * joining one more room.
 *
 * Documents sit under collapsible group headers derived from their tags (see
 * groups.ts). The grouping is a derivation, so a retag arriving over sync moves
 * a document between groups live; only the collapse preference is stored.
 */

import type { ReactElement } from "react";
import type { DirectoryEntry } from "@uberblick/schema";
import type { RoomConnection } from "../collab/rooms.js";
import { useRoomStatus, useStoredFlag } from "./hooks.js";
import { groupEntries } from "./groups.js";
import type { GroupKey } from "./groups.js";

/** Per-group collapse preference, persisted per browser like the sidebar's own. */
function groupCollapsedKey(key: GroupKey): string {
  return `uberblick.sidebar.group.${key}.collapsed`;
}

export function DocList({
  connection,
  entries,
  selected,
  onSelect,
  onCreate,
}: {
  connection: RoomConnection | null;
  entries: DirectoryEntry[];
  selected: string | null;
  onSelect: (uuid: string) => void;
  onCreate: () => void;
}): ReactElement {
  const status = useRoomStatus(connection);
  return (
    <nav className="ub-list">
      <div className="ub-list-head">
        <button type="button" onClick={onCreate} disabled={connection === null}>
          + new doc
        </button>
        <span className="ub-muted">
          {status.connected ? (status.synced ? "directory synced" : "syncing…") : "offline"}
        </span>
      </div>
      {entries.length === 0 ? (
        <p className="ub-muted ub-empty">No documents yet.</p>
      ) : (
        groupEntries(entries).map((group) => (
          <DocGroupSection
            key={group.key}
            groupKey={group.key}
            label={group.label}
            entries={group.entries}
            selected={selected}
            onSelect={onSelect}
          />
        ))
      )}
    </nav>
  );
}

/**
 * The group header's disclosure mark: one shape, rotated.
 *
 * Drawn rather than typed. The bug this fixes (#110) was that the two glyphs
 * `›` and `⌄` sit at different heights in their em boxes, so the mark neither
 * lined up with the label nor stayed put when the group toggled — swapping one
 * badly-centred glyph for another badly-centred glyph is the failure mode, not
 * the fix. A path on a square viewBox is centred by construction and rotates
 * about its own middle, which leaves CSS one job: `transform`.
 */
function Chevron(): ReactElement {
  return (
    <svg className="ub-group-caret" viewBox="0 0 8 8" aria-hidden="true">
      <path
        d="M3 1.6 L5.4 4 L3 6.4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * One group. A component rather than inline markup so each group owns its own
 * `useStoredFlag` — the hook count stays fixed however many groups the
 * directory produces.
 */
function DocGroupSection({
  groupKey,
  label,
  entries,
  selected,
  onSelect,
}: {
  groupKey: GroupKey;
  label: string;
  entries: DirectoryEntry[];
  selected: string | null;
  onSelect: (uuid: string) => void;
}): ReactElement {
  const [collapsed, setCollapsed] = useStoredFlag(groupCollapsedKey(groupKey), false);
  return (
    <section className="ub-group">
      <button
        type="button"
        className="ub-group-head"
        aria-expanded={!collapsed}
        onClick={() => setCollapsed(!collapsed)}
      >
        <Chevron />
        <span className="ub-group-label">{label}</span>
        <span className="ub-group-count">{entries.length}</span>
      </button>
      {/*
        Always rendered, never conditionally: the open/closed transition is a
        `grid-template-rows` animation (see styles.css), and CSS cannot animate
        an element that is not there. `inert` is what keeps that honest — a
        collapsed group is out of the tab order and out of the accessibility
        tree, exactly as it was when React removed it from the DOM.
      */}
      <div className="ub-group-body" data-collapsed={collapsed} inert={collapsed}>
        <ul>
          {entries.map((entry) => (
            <li key={entry.uuid}>
              <button
                type="button"
                className={entry.uuid === selected ? "ub-selected" : ""}
                onClick={() => onSelect(entry.uuid)}
                title={entry.uuid}
              >
                {entry.title === "" ? <em>Untitled</em> : entry.title}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
