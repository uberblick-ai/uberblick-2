/**
 * The document list, fed by the directory doc — never by locally-observed
 * creations. A fresh tab with empty local state learns the whole corpus by
 * joining one more room.
 */

import type { ReactElement } from "react";
import type { DirectoryEntry } from "@uberblick/schema";
import type { RoomConnection } from "../collab/rooms.js";
import { useRoomStatus } from "./hooks.js";

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
    </nav>
  );
}
