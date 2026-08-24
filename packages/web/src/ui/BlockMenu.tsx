/**
 * The block-insertion menu — one component, two ways in.
 *
 * Typing `/` in an empty paragraph opens it at the caret and converts that
 * block; hovering a block reveals a `+` in the left gutter which opens the same
 * list and inserts a new block below. The entries, the filtering and the two
 * transactions live in `editor/block-menu.ts`; what this file owns is pixels,
 * focus and keys.
 *
 * Three decisions worth knowing:
 *
 * - **No Tiptap suggestion plugin.** `@tiptap/suggestion` is a package of its
 *   own and is not in the lockfile, so using it would mean a new runtime
 *   dependency — an architectural decision this issue does not carry. The
 *   trigger is instead read off the editor state every transaction
 *   (`slashTriggerAt`), which is less machinery than the plugin would be: no
 *   decoration, no plugin state, nothing to keep in step with an undo.
 *
 * - **Keys are taken in the capture phase, on the editor host.** While the slash
 *   menu is open, ↑/↓/Enter/Esc belong to the menu, not to ProseMirror. A
 *   capture listener on `.ub-editor` — an ancestor of the contenteditable — sees
 *   them first and stops them there, so ProseMirror never splits a block under
 *   an Enter that meant "insert this one". Everything else falls through and
 *   filters the list by editing the document, which is what keeps the typed
 *   `/query` visible in the prose and undoable as text. A composing keystroke is
 *   never the menu's, whatever it says — see {@link composing}.
 *
 * - **The gutter is reserved, never inserted.** `.ub-column` carries a permanent
 *   left padding and the button is absolutely positioned inside it, so
 *   revealing it changes opacity and nothing else. A `+` that pushed the prose
 *   sideways on hover would make every block twitch as the pointer crossed it.
 *
 * The menu is local UI, and the document does not change until an entry is
 * picked — but the document underneath it is not. A peer can delete or move the
 * block a session or a gutter button is aimed at, so both hold a block **id**
 * rather than a position, both re-resolve it on every transaction, and both
 * close rather than act on a block that has gone.
 */

import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import type { ReactElement, RefObject } from "react";
import type { Editor } from "@tiptap/core";
import type { Transaction } from "@tiptap/pm/state";
import {
  convertBlockAtTrigger,
  filterBlockMenu,
  findBlockById,
  insertBlockBelow,
  opensSlashSession,
  slashTriggerAt,
} from "../editor/block-menu.js";
import type { BlockMenuEntry, SlashTrigger } from "../editor/block-menu.js";

/** A position in the frame's own coordinates, in pixels. */
interface Point {
  top: number;
  left: number;
}

interface SlashSession {
  trigger: SlashTrigger;
  point: Point;
}

/**
 * The block the pointer is over, and where its gutter button belongs. Named by
 * id: the block it points at has to be findable again after the document has
 * moved under it.
 */
interface Hover {
  blockId: string;
  top: number;
}

/** The gap between the caret and the menu, in pixels. */
const OFFSET = 6;

/** The gutter button's height, in pixels — kept in step with `.ub-gutter-add`. */
const BUTTON_SIZE = 22;

/**
 * Whether this keystroke belongs to an input method editor rather than to the
 * menu.
 *
 * Typing Japanese, Chinese or Korean runs Enter and the arrow keys through a
 * composition first — Enter commits the candidate, the arrows walk the candidate
 * list — and the browser reports that with `isComposing` (a `keyCode` of 229 on
 * the browsers that predate it). Taking those keys for the menu would make the
 * IME unusable inside a slash session. ProseMirror's own `composing` flag is
 * checked too: it stays true for a moment after `compositionend`, which is one
 * of the windows in which a stray Enter arrives.
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
 * IME's". Missing it means the menu converts a block while the reader was only
 * accepting a candidate: their text is gone and a heading is there instead.
 *
 * So the composition's tail is remembered rather than read: the first keydown
 * after a `compositionend` is left to the editor, and the memory is one-shot
 * (consumed by that keydown) and time-boxed (an Enter pressed deliberately a
 * moment later is the menu's again). Both bounds matter — one-shot alone would
 * swallow a deliberate Enter that came minutes later, and the window alone
 * would swallow every key in a fast composition-then-command sequence.
 *
 * Time-boxed is not narrow enough on its own, though: see {@link armsTail}.
 */
const COMPOSITION_TAIL_MS = 100;

/** Which of the menu's two typing surfaces a key or a composition came from. */
type KeySource = "editor" | "search";

/**
 * Safari, by the test ProseMirror itself uses (`browser.safari` is
 * `/Apple Computer/.test(navigator.vendor)`).
 *
 * A browser check rather than pure behaviour-sniffing, and deliberately so:
 * ProseMirror gates its own composition workarounds on exactly this, and the
 * ordering being worked around is one browser's. Read at call time so nothing
 * is baked in at module load.
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
 * paragraph they were converting. Three conditions, all necessary:
 *
 * - `confirmed`: the keydown immediately before this event was a composing
 *   Enter, i.e. the commit already came through. That is the Chrome/Firefox
 *   ordering, and it must NOT arm. (Arrows walking a candidate list are not a
 *   commit and do not count, which keeps Safari's ordering armed when the
 *   reader navigated candidates before committing.)
 * - Safari: the ordering being compensated for is Safari's.
 * - `source`: the composition ended in the control this menu is listening to.
 *   A composition finished in some other field inside the frame owes the menu
 *   nothing.
 */
function armsTail(confirmed: boolean, source: KeySource | null): boolean {
  return !confirmed && source !== null && isSafariLike();
}

/**
 * Where the menu goes for a slash session: just below the caret.
 *
 * ProseMirror measures through the live layout, which a headless DOM does not
 * have; every fallback here is that case, and the origin is fine there because
 * nothing is looking at it.
 */
function pointAtCaret(editor: Editor, frame: HTMLElement | null): Point {
  if (frame === null) return { top: 0, left: 0 };
  try {
    const coords = editor.view.coordsAtPos(editor.state.selection.from);
    const rect = frame.getBoundingClientRect();
    const top = coords.bottom - rect.top + OFFSET;
    const left = coords.left - rect.left;
    if (!Number.isFinite(top) || !Number.isFinite(left)) return { top: 0, left: 0 };
    return { top, left: Math.max(0, left) };
  } catch {
    return { top: 0, left: 0 };
  }
}

/**
 * The top-level block a DOM node inside the editor belongs to — its id and its
 * position — or `null` when the node is not in one.
 *
 * Two steps, both cheap, because this runs on every `mousemove` over the prose:
 * walk up the ancestors to the ProseMirror root's own child (bounded by nesting
 * depth, which this schema caps at a block plus its inline spans), then let the
 * view map that element to a document position in one call. Scanning the
 * document instead — `nodeDOM` per top-level node until one matches — was a walk
 * of the whole document per pointer move, and it grew with the document.
 */
function blockAt(
  editor: Editor,
  target: EventTarget | null,
): { blockId: string; pos: number } | null {
  const { view } = editor;
  let element =
    target instanceof HTMLElement
      ? target
      : target instanceof Node
        ? target.parentElement
        : null;
  while (element !== null && element.parentElement !== view.dom) {
    element = element.parentElement;
  }
  if (element === null) return null;

  try {
    // Offset 0 is inside the block, so resolving it gives the block itself at
    // depth 1 — `before(1)` is where it starts.
    const $inside = view.state.doc.resolve(view.posAtDOM(element, 0));
    if ($inside.depth < 1) return null;
    const node = $inside.node(1);
    return typeof node.attrs.id === "string" && node.attrs.id !== ""
      ? { blockId: node.attrs.id, pos: $inside.before(1) }
      : null;
  } catch {
    // `posAtDOM` throws for a node the view no longer describes — a block the
    // pointer was over while a peer's edit was being applied.
    return null;
  }
}

/**
 * Where the gutter button sits for the block at `pos`: centred on its first
 * line, so the `+` beside a heading lines up with the heading rather than
 * floating above it.
 */
function gutterTop(editor: Editor, pos: number, frame: HTMLElement | null): number {
  const dom = editor.view.nodeDOM(pos);
  if (frame === null || !(dom instanceof HTMLElement)) return 0;
  const rect = dom.getBoundingClientRect();
  const base = frame.getBoundingClientRect();
  const lineHeight = Number.parseFloat(window.getComputedStyle(dom).lineHeight);
  const firstLine = Number.isFinite(lineHeight) ? lineHeight : rect.height;
  const top = rect.top - base.top + Math.max(0, (firstLine - BUTTON_SIZE) / 2);
  return Number.isFinite(top) ? top : 0;
}

export function BlockMenu({
  editor,
  host,
}: {
  editor: Editor;
  /** The positioned element the menu and the gutter button are placed inside. */
  host: RefObject<HTMLElement | null>;
}): ReactElement {
  const [slash, setSlash] = useState<SlashSession | null>(null);
  const [hover, setHover] = useState<Hover | null>(null);
  /** The open gutter menu: which block it will insert below, and where it sits. */
  const [gutter, setGutter] = useState<Hover | null>(null);
  const [gutterQuery, setGutterQuery] = useState("");
  /** The highlighted entry, and the list it was highlighted in. */
  const [highlight, setHighlight] = useState<{ list: string; index: number }>({
    list: "",
    index: 0,
  });
  /**
   * Esc, remembered for as long as the session it dismissed. Cleared the moment
   * the block stops looking like a slash session — so deleting the `/` and
   * typing it again opens the menu, while typing on after Esc leaves the text
   * alone, which is what Esc meant.
   */
  const dismissed = useRef(false);
  const card = useRef<HTMLDivElement | null>(null);
  /** The gutter menu's search field, when one is open — a composition surface. */
  const search = useRef<HTMLInputElement | null>(null);
  /** When the last composition ended — see {@link COMPOSITION_TAIL_MS}. */
  const composedAt = useRef(0);
  /** And where, so the tail only ever covers the surface it ended in. */
  const composedIn = useRef<KeySource | null>(null);
  /** Whether the keydown just before was a composing Enter — see {@link armsTail}. */
  const confirmed = useRef(false);

  /** Which of the menu's typing surfaces holds `target`, if either does. */
  const sourceOf = useCallback(
    (target: EventTarget | null): KeySource | null => {
      if (!(target instanceof Node)) return null;
      if (editor.view.dom.contains(target)) return "editor";
      const field = search.current;
      if (field !== null && (field === target || field.contains(target))) {
        return "search";
      }
      return null;
    },
    [editor],
  );

  // One listener for both key paths: the prose and the gutter's search field
  // are both inside the frame, and both are typed into with an IME.
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
   * Whether the menu may act on this keystroke.
   *
   * Always consumes the composition-tail memory, so the tail covers exactly the
   * one keydown that followed its `compositionend` — and only when that keydown
   * came from the surface the composition ended in.
   */
  const menuOwnsKey = useCallback(
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

  // Two questions with two different answers.
  //
  // Whether a session *stays* open is asked of the state, on every transaction:
  // `slashTriggerAt` is recomputed, and the session lives exactly as long as it
  // keeps validating. So anything that moves the caret out of the block, or
  // stops its text looking like a query, closes the menu — a peer deleting the
  // block, an undo, a click elsewhere — while a peer editing some *other* block
  // leaves it alone, because none of that is what the menu is watching.
  //
  // Whether a session *opens* is asked of the transaction instead:
  // `opensSlashSession` refuses everything that is not this reader typing into
  // an empty paragraph, so none of those events can open one either.
  useEffect(() => {
    const read = (transaction: Transaction | null): void => {
      const trigger = slashTriggerAt(editor);
      if (trigger === null) {
        dismissed.current = false;
        setSlash(null);
        return;
      }
      if (dismissed.current) {
        setSlash(null);
        return;
      }
      setSlash((current) =>
        current === null &&
        (transaction === null || !opensSlashSession(transaction, trigger))
          ? null
          : { trigger, point: pointAtCaret(editor, host.current) },
      );
    };
    read(null);
    const onTransaction = ({ transaction }: { transaction: Transaction }): void =>
      read(transaction);
    editor.on("transaction", onTransaction);
    return () => {
      editor.off("transaction", onTransaction);
    };
  }, [editor, host]);

  // Hover, for the gutter button. Tracked on the ProseMirror root so the button
  // itself — which is outside it — never counts as leaving the block.
  useEffect(() => {
    const dom = editor.view.dom;
    const frame = host.current;
    const track = (event: MouseEvent): void => {
      const block = blockAt(editor, event.target);
      if (block === null) return;
      const top = gutterTop(editor, block.pos, frame);
      setHover((previous) =>
        previous !== null && previous.blockId === block.blockId && previous.top === top
          ? previous
          : { blockId: block.blockId, top },
      );
    };
    const leave = (): void => setHover(null);
    dom.addEventListener("mousemove", track);
    frame?.addEventListener("mouseleave", leave);
    return () => {
      dom.removeEventListener("mousemove", track);
      frame?.removeEventListener("mouseleave", leave);
    };
  }, [editor, host]);

  const query = gutter !== null ? gutterQuery : (slash?.trigger.query ?? null);
  const path = gutter !== null ? "gutter" : slash !== null ? "slash" : null;
  const entries = query === null ? [] : filterBlockMenu(query);
  // A slash query nothing matches is a reader writing prose, not choosing a
  // block: the menu gets out of the way and gives Enter back to the editor.
  const open = path === "gutter" || (path === "slash" && entries.length > 0);
  // The highlight belongs to one list. Editing the query makes a different
  // list, so the remembered position no longer means anything and the first
  // entry is highlighted again — no effect needed to reset it.
  const list = `${path}:${query}`;
  const chosen = highlight.list === list ? highlight.index : 0;
  const active = entries.length === 0 ? -1 : Math.min(chosen, entries.length - 1);

  const highlightAt = useCallback(
    (index: number): void => setHighlight({ list, index }),
    [list],
  );

  const closeGutter = useCallback((): void => {
    setGutter(null);
    setGutterQuery("");
  }, []);

  /**
   * An *open* gutter menu follows its block on every transaction: gone means
   * closed, moved means re-measured. It is the only anchor worth measuring —
   * it is the one that can act, and there is at most one of them open.
   *
   * A merely hovered button gets the cheap treatment below instead. Following it
   * too meant a `findBlockById` plus a `getBoundingClientRect` plus a
   * `getComputedStyle` on **every transaction** — that is per keystroke, local
   * or remote, for as long as the pointer rests anywhere over the prose, to keep
   * a hint in the right place.
   */
  const menuAnchorId = gutter?.blockId ?? null;
  useEffect(() => {
    if (menuAnchorId === null) return;
    const follow = (): void => {
      const found = findBlockById(editor.state.doc, menuAnchorId);
      if (found === null) {
        closeGutter();
        return;
      }
      const top = gutterTop(editor, found.pos, host.current);
      setGutter((previous) =>
        previous === null || previous.top === top ? previous : { ...previous, top },
      );
    };
    editor.on("transaction", follow);
    return () => {
      editor.off("transaction", follow);
    };
  }, [editor, host, menuAnchorId, closeGutter]);

  // The hovered button is a hint, and a hint whose block may have just moved is
  // simply not shown: an edit hides it, and the next pointer move — which is the
  // only gesture that can reach it anyway — puts it back where it belongs. Both
  // commands re-resolve their block by id when they run, so nothing here is
  // load-bearing for correctness.
  useEffect(() => {
    const drop = ({ transaction }: { transaction: Transaction }): void => {
      if (transaction.docChanged) setHover(null);
    };
    editor.on("transaction", drop);
    return () => {
      editor.off("transaction", drop);
    };
  }, [editor]);

  const choose = useCallback(
    (entry: BlockMenuEntry | undefined): void => {
      if (entry === undefined) return;
      if (gutter !== null) {
        // A refusal means the block is gone; either way the menu has had its
        // answer and closes.
        insertBlockBelow(editor, gutter.blockId, entry);
        closeGutter();
        setHover(null);
        return;
      }
      if (slash !== null) {
        convertBlockAtTrigger(editor, slash.trigger, entry);
        setSlash(null);
      }
    },
    [editor, gutter, slash, closeGutter],
  );

  const step = useCallback(
    (delta: number): void => {
      if (entries.length === 0) return;
      highlightAt((active + delta + entries.length) % entries.length);
    },
    [entries.length, active, highlightAt],
  );

  /** The keys the menu owns while it is open. Returns false for the rest. */
  const handleKey = useCallback(
    (key: string): boolean => {
      if (key === "ArrowDown") {
        step(1);
        return true;
      }
      if (key === "ArrowUp") {
        step(-1);
        return true;
      }
      if (key === "Enter") {
        choose(entries[active]);
        return true;
      }
      if (key === "Escape") {
        if (gutter !== null) {
          closeGutter();
          editor.view.focus();
        } else {
          dismissed.current = true;
          setSlash(null);
        }
        return true;
      }
      return false;
    },
    [step, choose, entries, active, gutter, closeGutter, editor],
  );

  // Slash mode types into the document, so the keys the menu owns have to be
  // taken before ProseMirror sees them — see the module comment.
  useEffect(() => {
    if (path !== "slash" || !open) return;
    const target = editor.view.dom.parentElement ?? editor.view.dom;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!menuOwnsKey(event, "editor")) return;
      if (!handleKey(event.key)) return;
      event.preventDefault();
      event.stopPropagation();
    };
    target.addEventListener("keydown", onKeyDown, true);
    return () => {
      target.removeEventListener("keydown", onKeyDown, true);
    };
  }, [editor, path, open, handleKey, menuOwnsKey]);

  // A click anywhere else dismisses the gutter menu, the way every menu does.
  useEffect(() => {
    if (gutter === null) return;
    const onMouseDown = (event: MouseEvent): void => {
      const target = event.target;
      if (target instanceof Node && card.current?.contains(target) === true) return;
      closeGutter();
    };
    document.addEventListener("mousedown", onMouseDown);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
    };
  }, [gutter, closeGutter]);

  const anchor = gutter ?? hover;
  const visible = anchor !== null;
  const point: Point =
    gutter !== null
      ? { top: gutter.top + BUTTON_SIZE + OFFSET, left: 0 }
      : (slash?.point ?? { top: 0, left: 0 });

  return (
    <>
      {/* Always mounted, so revealing it is a change of opacity and nothing
          else. Out of the tab order while invisible: the keyboard route to this
          menu is the slash, not a button nobody can see. */}
      <button
        type="button"
        className={visible ? "ub-gutter-add ub-gutter-add-on" : "ub-gutter-add"}
        style={{ top: `${anchor?.top ?? 0}px` }}
        aria-label="Insert block below"
        title="Insert block below"
        aria-hidden={!visible}
        tabIndex={-1}
        // The caret stays where it is until an entry is picked.
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => {
          if (hover === null) return;
          setGutterQuery("");
          setGutter(hover);
        }}
      >
        +
      </button>
      {open && (
        <div
          className="ub-blockmenu"
          ref={card}
          style={{ top: `${point.top}px`, left: `${point.left}px` }}
        >
          {path === "gutter" && (
            <input
              ref={search}
              className="ub-blockmenu-search"
              placeholder="Search blocks…"
              aria-label="Search blocks"
              value={gutterQuery}
              // The menu was opened by a deliberate click and filtering is what
              // it is for, so the field takes focus rather than asking for a
              // second gesture. Esc gives focus back to the prose.
              // biome-ignore lint/a11y/noAutofocus: see above.
              autoFocus
              onChange={(event) => setGutterQuery(event.target.value)}
              onKeyDown={(event) => {
                // The field takes typed text, so it has an IME to stay out of
                // the way of just as much as the prose does.
                if (!menuOwnsKey(event.nativeEvent, "search")) return;
                if (!handleKey(event.key)) return;
                event.preventDefault();
                event.stopPropagation();
              }}
            />
          )}
          {entries.length === 0 ? (
            <p className="ub-blockmenu-empty ub-muted">No blocks match.</p>
          ) : (
            // A listbox of buttons rather than a list of them: an `option` has
            // to be a child of its `listbox`, so a <ul>/<li> scaffold between
            // the two would break the role it is there to carry.
            <div className="ub-blockmenu-list" role="listbox" aria-label="Block types">
              {entries.map((entry, position) => (
                <Fragment key={entry.id}>
                  {/* A heading before the first entry of each group. The
                      registry is in display order, so this is a look at the
                      entry before rather than a grouping pass.

                      Presentational, because a `listbox` owns options and
                      nothing else: a heading announced as a child of one is a
                      broken list, not extra context. Nothing is lost by hiding
                      it — "Heading 2" and "Mermaid" say what they are without
                      "Text" and "Source" over them, and the grouping is there
                      for the eye scanning the column. */}
                  {entries[position - 1]?.group !== entry.group && (
                    <p className="ub-blockmenu-group" role="presentation">
                      {entry.group}
                    </p>
                  )}
                  <button
                    type="button"
                    role="option"
                    aria-selected={position === active}
                    className={
                      position === active
                        ? "ub-blockmenu-entry ub-blockmenu-on"
                        : "ub-blockmenu-entry"
                    }
                    // Same reason as the gutter button: picking an entry must
                    // not move the caret out of the block being converted.
                    onMouseDown={(event) => event.preventDefault()}
                    onMouseEnter={() => highlightAt(position)}
                    onClick={() => choose(entry)}
                  >
                    <span className="ub-blockmenu-label">{entry.label}</span>
                    {entry.hint !== null && (
                      <span className="ub-blockmenu-hint">{entry.hint}</span>
                    )}
                  </button>
                </Fragment>
              ))}
            </div>
          )}
        </div>
      )}
    </>
  );
}
