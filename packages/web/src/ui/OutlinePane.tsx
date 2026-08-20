/**
 * "On this page": the open document's headings, in document order.
 *
 * A derived view, never a stored one — see outline.ts. Two hide rules: no
 * headings hides it here, a narrow viewport hides it in CSS (`.ub-outline`).
 */

import type { ReactElement } from "react";
import type { RoomConnection } from "../collab/rooms.js";
import { useOutline } from "./hooks.js";
import { scrollBlockIntoView } from "./outline.js";

export function OutlinePane({
  connection,
}: {
  connection: RoomConnection | null;
}): ReactElement | null {
  const entries = useOutline(connection);
  if (entries.length === 0) return null;
  return (
    <aside className="ub-outline" aria-label="On this page">
      <p className="ub-outline-head">On this page</p>
      <ul>
        {entries.map((entry) => (
          <li key={entry.id} className={`ub-outline-l${entry.level}`}>
            <button type="button" onClick={() => scrollBlockIntoView(entry.id)}>
              {entry.text.trim() === "" ? <em>Untitled heading</em> : entry.text}
            </button>
          </li>
        ))}
      </ul>
    </aside>
  );
}
