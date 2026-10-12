/**
 * Use the same session avatar in compact status and details: name initial
 * plus an agent badge, live caret colour, or full-strength muted ink and
 * dashed ring for departures.
 */

import type { ReactElement } from "react";
import type { RemotePresence } from "./doc-chrome.js";

/** The badge every agent session adds to the shared initial. */
const AGENT_GLYPH = "🤖";

/** What a human circle shows when its name begins with nothing at all. */
const NO_INITIAL = "?";

/**
 * Take the first trimmed Unicode code point and uppercase it; shared sidebar
 * initials must follow this same rule without splitting surrogate pairs.
 */
export function initialOf(name: string): string {
  const [first] = Array.from(name.trim());
  return first === undefined ? NO_INITIAL : first.toUpperCase();
}

/** The labelled control or row owns the session's accessible name. */
export function PeerAvatar({ session }: { session: RemotePresence }): ReactElement {
  return (
    <span
      className={`ub-avatar${session.departed ? " ub-avatar-departed" : ""}`}
      aria-hidden="true"
      // The awareness palette is `#rrggbb` literals rather than theme tokens
      // (see src/collab/identity.ts), so both are written inline. The letter
      // takes the colour as well as the ring; the robot brings its own.
      style={session.departed ? undefined : { borderColor: session.color, color: session.color }}
    >
      {initialOf(session.name)}
      {session.kind === "agent" && (
        <span className="ub-avatar-agent-badge" aria-hidden="true">
          {AGENT_GLYPH}
        </span>
      )}
    </span>
  );
}
