/**
 * One disclosure row: a quiet header over a body the caller fills (#563).
 *
 * The decision-document sketches want this same row three times — "Options
 * considered", "Context and rationale", "Reconsider when" — and other document
 * and side-panel surfaces will want it after them. So it is a shared primitive
 * rather than markup belonging to whichever surface arrives first, and it knows
 * nothing about what it discloses: label, secondary value and body are all the
 * caller's, and there is no vocabulary of any consumer in this file.
 *
 * Three choices worth stating, because each is the reason a simpler-looking
 * alternative was not taken:
 *
 * - **The header is a `<button>`, not a `<summary>`.** Native `<details>` gives
 *   the semantics and the full-summary target for free, but the browser also
 *   *owns* the open state: a controlled caller has to let the toggle happen and
 *   then push back against it. A button carrying `aria-expanded` is the ARIA
 *   disclosure pattern, it is what `Sidebar.tsx` already uses, and it leaves the
 *   state where this component's contract says it lives.
 * - **The button is the whole header.** Not a row containing a button: the
 *   activation target is every pixel of the header, for a finger as much as for
 *   a pointer, and there is nothing else inside it to compete for the click or
 *   for the tab stop. `styles.css` gives it the 44px minimum.
 * - **A closed body is hidden, never unmounted.** `hidden` takes it off screen
 *   and out of the accessibility tree while React keeps the subtree mounted, so
 *   a child holding state — a draft in a field, a scroll position — is still
 *   holding it when the row reopens. Unmounting would silently discard it.
 */

import { useId, useState } from "react";
import type { ReactElement, ReactNode } from "react";

export interface DisclosureProps {
  /** The row's primary label. May wrap; nothing else in the header moves. */
  label: ReactNode;
  /** An optional short value beside the mark — "2 options", "read when needed". */
  secondary?: ReactNode;
  /** What the row discloses. Mounted whether the row is open or closed. */
  children: ReactNode;
  /** Uncontrolled: the state the row opens in. Ignored when `open` is given. */
  defaultOpen?: boolean;
  /**
   * Controlled: the caller's state, rendered as given. Supplying it hands the
   * component's own state cell over — the row then only reports activations
   * through `onOpenChange` and never holds a second answer that could drift.
   */
  open?: boolean;
  /** Every activation, in both modes, with the state the row is moving to. */
  onOpenChange?: (open: boolean) => void;
}

export function Disclosure({
  label,
  secondary,
  children,
  defaultOpen = false,
  open,
  onOpenChange,
}: DisclosureProps): ReactElement {
  const controlled = open !== undefined;
  const [ownOpen, setOwnOpen] = useState(defaultOpen);
  const isOpen = controlled ? open : ownOpen;
  const bodyId = useId();

  return (
    <div className="ub-disclosure">
      <button
        type="button"
        className="ub-disclosure-head"
        aria-expanded={isOpen}
        aria-controls={bodyId}
        onClick={() => {
          if (!controlled) setOwnOpen(!isOpen);
          onOpenChange?.(!isOpen);
        }}
      >
        <span className="ub-disclosure-label">{label}</span>
        {secondary !== undefined && (
          <span className="ub-disclosure-secondary">{secondary}</span>
        )}
        <DisclosureMark />
      </button>
      <div id={bodyId} className="ub-disclosure-body" hidden={!isOpen}>
        {children}
      </div>
    </div>
  );
}

/**
 * The mark: one shape, rotated.
 *
 * Drawn on a square viewBox rather than typed, for the reason `Sidebar.tsx`'s
 * chevron is (#110) — a glyph sits at its own height in its em box, so it never
 * quite lines up and moves when it is swapped. Drawn *here* rather than shared
 * with that one because the sidebar's caret is 11px small-caps furniture with
 * its own size and colour; a primitive that borrowed it would inherit those.
 */
function DisclosureMark(): ReactElement {
  return (
    <svg className="ub-disclosure-mark" viewBox="0 0 8 8" aria-hidden="true">
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
