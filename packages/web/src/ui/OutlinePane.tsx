/**
 * "On this page": the open document's headings, in document order.
 *
 * A derived view, never a stored one — see outline.ts. Two hide rules: no
 * headings hides it here, a narrow viewport hides the whole right rail in CSS
 * (`.ub-rail`), which this is the top section of.
 *
 * The entries also carry the changed-block dots (#120), which is the half of
 * that feature that works out of viewport: the gutter line only exists where
 * the block is, and the rail is where a reader looks for what they cannot see.
 * The dot's slot is always rendered so switching it on moves no text — see
 * `.ub-outline-dot`.
 */

import type { ReactElement } from "react";
import type { RoomConnection } from "../collab/rooms.js";
import { useChangedBlocks, useOutline } from "./hooks.js";
import { outlineDots, scrollBlockIntoView } from "./outline.js";

/** What a dot means, in words. Exported so the test asserts the same string. */
export const CHANGED_SECTION_LABEL = "changed since you last looked";

export function OutlinePane({
  connection,
}: {
  connection: RoomConnection | null;
}): ReactElement | null {
  const entries = useOutline(connection);
  const changed = useChangedBlocks(connection);
  const dots =
    connection === null ? new Set<string>() : outlineDots(connection.ydoc, changed);
  if (entries.length === 0) return null;
  return (
    <section className="ub-outline" aria-label="On this page">
      <p className="ub-rail-head">On this page</p>
      <ul>
        {entries.map((entry) => (
          <li key={entry.id} className={`ub-outline-l${entry.level}`}>
            <button
              type="button"
              onClick={() => scrollBlockIntoView(entry.id)}
              {...(dots.has(entry.id)
                ? { title: CHANGED_SECTION_LABEL }
                : {})}
            >
              <span
                className={
                  dots.has(entry.id) ? "ub-outline-dot ub-outline-dot-on" : "ub-outline-dot"
                }
                aria-hidden="true"
              />
              {entry.text.trim() === "" ? <em>Untitled heading</em> : entry.text}
              {/* The dot is a colour, and a colour has no accessible name. The
                  words are in the entry's own text rather than an `aria-label`,
                  which would replace the heading with them; `title` alone would
                  be a tooltip most screen readers are configured not to
                  announce. */}
              {dots.has(entry.id) && (
                <span className="ub-sr-only"> — {CHANGED_SECTION_LABEL}</span>
              )}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
