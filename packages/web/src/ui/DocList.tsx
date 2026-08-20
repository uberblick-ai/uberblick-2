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
        <span className="ub-group-caret" aria-hidden="true">
          {collapsed ? "›" : "⌄"}
        </span>
        <span className="ub-group-label">{label}</span>
        <span className="ub-group-count">{entries.length}</span>
      </button>
      {!collapsed && (
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
      )}
    </section>
  );
}
