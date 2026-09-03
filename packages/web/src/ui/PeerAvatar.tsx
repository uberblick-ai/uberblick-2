/**
 * The circle a session is drawn as (#494).
 *
 * One avatar language in two places: the status line's collaborator controls
 * and the sync panel's present-now list.
 *
 * The name initial is primary for every session. An agent adds one small robot
 * badge, while the ring remains the session colour its caret uses in the prose.
 */

import type { ReactElement } from "react";
import type { RemotePresence } from "./doc-chrome.js";

/** The badge every agent session adds to the shared initial. */
const AGENT_GLYPH = "🤖";

/** What a human circle shows when its name begins with nothing at all. */
const NO_INITIAL = "?";

/**
 * The first *character* of a name, upper-cased — by code point, so a name
 * starting outside the BMP contributes one glyph rather than half a surrogate
 * pair. Trimmed first: a leading space is not an initial.
 *
 * Exported because the sidebar's identity tiles (#482) draw a first character
 * too. One rule, so a workspace tile and a session circle never disagree about
 * what the first character of the same string is.
 */
export function initialOf(name: string): string {
  const [first] = Array.from(name.trim());
  return first === undefined ? NO_INITIAL : first.toUpperCase();
}

/** The labelled control or row owns the session's accessible name. */
export function PeerAvatar({ session }: { session: RemotePresence }): ReactElement {
  return (
    <span
      className={`ub-avatar ub-avatar-${session.kind}`}
      aria-hidden="true"
      // The awareness palette is `#rrggbb` literals rather than theme tokens
      // (see src/collab/identity.ts), so both are written inline. The letter
      // takes the colour as well as the ring; the robot brings its own.
      style={{ borderColor: session.color, color: session.color }}
    >
      <span className="ub-avatar-initial">{initialOf(session.name)}</span>
      {session.kind === "agent" && (
        <span className="ub-avatar-agent-badge" aria-hidden="true">
          {AGENT_GLYPH}
        </span>
      )}
    </span>
  );
}
