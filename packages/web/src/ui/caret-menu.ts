/**
 * What a menu that opens at the caret inside the prose needs, and what both of
 * them need identically: where the caret is on screen, and which keystrokes are
 * the menu's rather than an input method's.
 *
 * Two components open over the editor — the block menu (`/`, and the gutter `+`)
 * and the mention picker (`@`). Both float a card at the caret, and both take
 * ↑/↓/Enter/Esc away from ProseMirror while they are open, which is where the
 * input-method problem below comes from. A second copy of that reasoning is
 * exactly the thing that would rot: the guard is subtle, it is about one
 * browser's event ordering, and a copy fixed in one place and not the other is
 * an IME that works in one menu.
 */

import { useCallback, useEffect, useRef } from "react";
import type { RefObject } from "react";
import type { Editor } from "@tiptap/core";

/** A position in the frame's own coordinates, in pixels. */
export interface Point {
  top: number;
  left: number;
}

/** The gap between the caret and the menu, in pixels. */
export const CARET_MENU_OFFSET = 6;

/**
 * Where a menu goes for a caret session: just below the caret.
 *
 * ProseMirror measures through the live layout, which a headless DOM does not
 * have; every fallback here is that case, and the origin is fine there because
 * nothing is looking at it.
 */
export function pointAtCaret(editor: Editor, frame: HTMLElement | null): Point {
  if (frame === null) return { top: 0, left: 0 };
  try {
    const coords = editor.view.coordsAtPos(editor.state.selection.from);
    const rect = frame.getBoundingClientRect();
    const top = coords.bottom - rect.top + CARET_MENU_OFFSET;
    const left = coords.left - rect.left;
    if (!Number.isFinite(top) || !Number.isFinite(left)) return { top: 0, left: 0 };
    return { top, left: Math.max(0, left) };
  } catch {
    return { top: 0, left: 0 };
  }
}

/** Which typing surface a key or a composition came from. */
export type KeySource = "editor" | "search";

/**
 * Whether this keystroke belongs to an input method editor rather than to the
 * menu.
 *
 * Typing Japanese, Chinese or Korean runs Enter and the arrow keys through a
 * composition first — Enter commits the candidate, the arrows walk the candidate
 * list — and the browser reports that with `isComposing` (a `keyCode` of 229 on
 * the browsers that predate it). Taking those keys for a menu would make the
 * IME unusable while one is open. ProseMirror's own `composing` flag is checked
 * too: it stays true for a moment after `compositionend`, which is one of the
 * windows in which a stray Enter arrives.
 *
 * The other window is Safari's, and no flag on the event describes it — see
 * {@link COMPOSITION_TAIL_MS}.
 */
function composingKey(event: KeyboardEvent, editor: Editor): boolean {
  return event.isComposing || event.keyCode === 229 || editor.view.composing;
}

/**
 * How long after a `compositionend` its confirming keystroke may still arrive.
 *
 * Safari fires `compositionend` *before* the Enter keydown that committed the
 * candidate, and that keydown carries `isComposing: false` with ProseMirror's
 * own flag already cleared — so nothing on the event says "this Enter was the
 * IME's". Missing it means the menu acts while the reader was only accepting a
 * candidate: their text is gone and a heading, or a document reference, is there
 * instead.
 *
 * So the composition's tail is remembered rather than read: the first keydown
 * after a `compositionend` is left to the editor, and the memory is one-shot
 * (consumed by that keydown) and time-boxed (an Enter pressed deliberately a
 * moment later is the menu's again). Both bounds matter — one-shot alone would
 * swallow a deliberate Enter that came minutes later, and the window alone would
 * swallow every key in a fast composition-then-command sequence.
 *
 * Time-boxed is not narrow enough on its own, though: see {@link armsTail}.
 */
const COMPOSITION_TAIL_MS = 100;

/**
 * Safari, by the test ProseMirror itself uses (`browser.safari` is
 * `/Apple Computer/.test(navigator.vendor)`).
 *
 * A browser check rather than pure behaviour-sniffing, and deliberately so:
 * ProseMirror gates its own composition workarounds on exactly this, and the
 * ordering being worked around is one browser's. Read at call time so nothing is
 * baked in at module load.
 */
function isSafariLike(): boolean {
  return (
    typeof navigator !== "undefined" && /Apple Computer/.test(navigator.vendor ?? "")
  );
}

/**
 * Whether a `compositionend` should arm the tail at all.
 *
 * The tail exists for one ordering and must not fire outside it. Chrome and
 * Firefox deliver the committing Enter *before* `compositionend` — the guard
 * already declined it as composing, so nothing is owed, and arming there would
 * hand the reader's next deliberate Enter to ProseMirror and split the very
 * paragraph they were acting in. Three conditions, all necessary:
 *
 * - `confirmed`: the keydown immediately before this event was a composing
 *   Enter, i.e. the commit already came through. That is the Chrome/Firefox
 *   ordering, and it must NOT arm. (Arrows walking a candidate list are not a
 *   commit and do not count, which keeps Safari's ordering armed when the reader
 *   navigated candidates before committing.)
 * - Safari: the ordering being compensated for is Safari's.
 * - `source`: the composition ended in a control this menu is listening to. A
 *   composition finished in some other field inside the frame owes it nothing.
 */
function armsTail(confirmed: boolean, source: KeySource | null): boolean {
  return !confirmed && source !== null && isSafariLike();
}

/**
 * The input-method guard, as a hook: listens for compositions inside `host` and
 * answers, for one keydown, whether the menu may act on it.
 *
 * `sourceOf` is the caller's — the block menu has two typing surfaces (the prose
 * and its gutter search field), the mention picker has one — and it is what
 * scopes the tail to the surface a composition actually ended in.
 */
export function useCompositionGuard(
  editor: Editor,
  host: RefObject<HTMLElement | null>,
  sourceOf: (target: EventTarget | null) => KeySource | null,
): (event: KeyboardEvent, source: KeySource) => boolean {
  /** When the last composition ended — see {@link COMPOSITION_TAIL_MS}. */
  const composedAt = useRef(0);
  /** And where, so the tail only ever covers the surface it ended in. */
  const composedIn = useRef<KeySource | null>(null);
  /** Whether the keydown just before was a composing Enter — see {@link armsTail}. */
  const confirmed = useRef(false);

  useEffect(() => {
    const frame = host.current;
    if (frame === null) return;
    const ended = (event: Event): void => {
      const afterConfirm = confirmed.current;
      confirmed.current = false;
      const source = sourceOf(event.target);
      if (!armsTail(afterConfirm, source)) return;
      composedAt.current = Date.now();
      composedIn.current = source;
    };
    frame.addEventListener("compositionend", ended, true);
    return () => {
      frame.removeEventListener("compositionend", ended, true);
    };
  }, [host, sourceOf]);

  /**
   * Always consumes the composition-tail memory, so the tail covers exactly the
   * one keydown that followed its `compositionend` — and only when that keydown
   * came from the surface the composition ended in.
   */
  return useCallback(
    (event: KeyboardEvent, source: KeySource): boolean => {
      const composing = composingKey(event, editor);
      // A composing Enter is the commit key arriving *before* `compositionend`,
      // which is how Chrome's and Firefox's ordering is told from Safari's.
      confirmed.current = composing && event.key === "Enter";

      const tail = composedAt.current;
      const endedIn = composedIn.current;
      composedAt.current = 0;
      composedIn.current = null;

      if (composing) return false;
      return !(
        tail !== 0 &&
        endedIn === source &&
        Date.now() - tail <= COMPOSITION_TAIL_MS
      );
    },
    [editor],
  );
}
