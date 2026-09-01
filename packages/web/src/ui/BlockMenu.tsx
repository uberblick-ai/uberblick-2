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
 *   never the menu's, whatever it says — `useCompositionGuard` in
 *   `ui/caret-menu.ts` owns that, shared with the `@` picker.
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
  triggerHint,
} from "../editor/block-menu.js";
import type { BlockMenuEntry, SlashTrigger } from "../editor/block-menu.js";
import { CARET_MENU_OFFSET, pointAtCaret, useCompositionGuard } from "./caret-menu.js";
import type { KeySource, Point } from "./caret-menu.js";

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

/** The gutter button's height, in pixels — kept in step with `.ub-gutter-add`. */
const BUTTON_SIZE = 22;

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
  /** The entries' scroll container: the palette is taller than its viewport. */
  const listBox = useRef<HTMLDivElement | null>(null);

  /**
   * Which of the menu's two typing surfaces holds `target`, if either does. The
   * prose and the gutter's search field are both inside the frame, and both are
   * typed into with an input method.
   */
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

  /** Whether the menu may act on this keystroke — see `ui/caret-menu.ts`. */
  const menuOwnsKey = useCompositionGuard(editor, host, sourceOf);

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
  // itself — which is outside it — never counts as leaving the block, and
  // cleared when the pointer leaves the frame. The gutter strip the button
  // overhangs into is the frame's too (`.ub-editor-frame::before`), so the
  // route from the prose to the button is one unbroken piece of it: the button
  // cannot hide in the gap on the way.
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

  // Idempotent, because the pointer calls it on every `mousemove` over the
  // entry it is already on: returning the same state is how React is told there
  // is nothing to render.
  const highlightAt = useCallback(
    (index: number): void =>
      setHighlight((current) =>
        current.list === list && current.index === index ? current : { list, index },
      ),
    [list],
  );

  /**
   * Bring the entry at `index` fully into the list's viewport, moving the list
   * by the least it takes and moving nothing else.
   *
   * The arrow keys are the only caller. A pointer needs no help — the entry it
   * highlights is the one it is already on — and scrolling under a resting hand
   * would slide a different entry beneath it.
   *
   * Read straight off the DOM rather than from measured entry heights: the
   * entries are separated by group headings, so their offsets are not a
   * multiple of anything. Called before React re-renders, which is soon enough
   * — the highlight is a background and a border colour, so nothing about to be
   * painted moves the box being measured.
   */
  const reveal = useCallback((index: number): void => {
    const box = listBox.current;
    if (box === null) return;
    const entry = box.querySelectorAll<HTMLElement>('[role="option"]')[index];
    if (entry === undefined) return;
    const view = box.getBoundingClientRect();
    const rect = entry.getBoundingClientRect();
    if (rect.top < view.top) box.scrollTop -= view.top - rect.top;
    else if (rect.bottom > view.bottom) box.scrollTop += rect.bottom - view.bottom;
  }, []);

  // A closed menu keeps no highlight, so the next one opens on its first entry
  // — which is the entry a list scrolled back to the top is showing. Remembering
  // an index instead would reopen the menu highlighting something off screen.
  useEffect(() => {
    if (!open) setHighlight({ list: "", index: 0 });
  }, [open]);

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
      const next = (active + delta + entries.length) % entries.length;
      highlightAt(next);
      reveal(next);
    },
    [entries.length, active, highlightAt, reveal],
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
      ? { top: gutter.top + BUTTON_SIZE + CARET_MENU_OFFSET, left: 0 }
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
            //
            // Keyed by the list it is showing, so a different query gets a
            // different element: the highlight goes back to the first entry and
            // a scroll offset that described the entries before it goes with
            // it, rather than surviving into a list they are not in.
            <div
              key={list}
              className="ub-blockmenu-list"
              role="listbox"
              aria-label="Block types"
              ref={listBox}
            >
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
                    // `mousemove`, not `mouseenter`: an entry the keyboard
                    // scrolled under a resting hand is entered too, and taking
                    // that for a choice would undo the keystroke that caused
                    // it. Only a hand that moves is choosing.
                    onMouseMove={() => highlightAt(position)}
                    onClick={() => choose(entry)}
                  >
                    <span className="ub-blockmenu-label">{entry.label}</span>
                    {entry.trigger !== null && (
                      <span className="ub-blockmenu-hint">
                        {triggerHint(entry)}
                      </span>
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
