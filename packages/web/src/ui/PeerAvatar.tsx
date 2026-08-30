/**
 * The circle a session is drawn as (#494).
 *
 * One avatar language in two places: the status line's peer strip, where the
 * circle is all there is and carries the whole reading on hover, and the sync
 * panel's present-now list, where it is a glyph in front of a name that already
 * says who this is.
 *
 * An agent is a robot, a person is their initial, and the ring is the session's
 * own presence colour — the same colour its cursor carries in the prose, so the
 * circle in the chrome and the caret in the text are recognisably one session.
 * One robot for every agent, by owner decision: nothing distinguishes Claude
 * from Codex here.
 */

import type { ReactElement } from "react";
import { presenceLabel } from "./doc-chrome.js";
import type { RemotePresence } from "./doc-chrome.js";

/** The robot every agent session is drawn as. */
const AGENT_GLYPH = "🤖";

/** What a human circle shows when its name begins with nothing at all. */
const NO_INITIAL = "?";

/**
 * The first *character* of a name, upper-cased — by code point, so a name
 * starting outside the BMP contributes one glyph rather than half a surrogate
 * pair. Trimmed first: a leading space is not an initial.
 */
function initialOf(name: string): string {
  const [first] = Array.from(name.trim());
  return first === undefined ? NO_INITIAL : first.toUpperCase();
}

/**
 * `decorative` is the difference between the two surfaces, and it is an
 * accessibility rule rather than a style. On its own the avatar *is* the
 * session, so it is an image with a label. Beside a visible name it is a
 * repetition, so it is hidden and the name is the row's accessible name — a
 * screen reader announces each session once, not twice.
 */
export function PeerAvatar({
  session,
  decorative = false,
}: {
  session: RemotePresence;
  decorative?: boolean;
}): ReactElement {
  const label = presenceLabel(session);
  return (
    <span
      className={`ub-avatar ub-avatar-${session.kind}`}
      // The awareness palette is `#rrggbb` literals rather than theme tokens
      // (see src/collab/identity.ts), so both are written inline. The letter
      // takes the colour as well as the ring; the robot brings its own.
      style={{ borderColor: session.color, color: session.color }}
      {...(decorative
        ? { "aria-hidden": true }
        : { role: "img", "aria-label": label, title: label })}
    >
      {session.kind === "agent" ? AGENT_GLYPH : initialOf(session.name)}
    </span>
  );
}
