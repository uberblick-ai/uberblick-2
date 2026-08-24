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
 *   `/query` visible in the prose and undoable as text.
 *
 * - **The gutter is reserved, never inserted.** `.ub-column` carries a permanent
 *   left padding and the button is absolutely positioned inside it, so
 *   revealing it changes opacity and nothing else. A `+` that pushed the prose
 *   sideways on hover would make every block twitch as the pointer crossed it.
 *
 * Nothing here is collaborative: the menu is local UI, and the document does not
 * change until an entry is picked. A peer sees the resulting block and never the
 * menu.
 */

import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import type { ReactElement, RefObject } from "react";
import type { Editor } from "@tiptap/core";
import type { Transaction } from "@tiptap/pm/state";
import {
  convertBlockAtTrigger,
  filterBlockMenu,
  insertBlockBelow,
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

/** The block the pointer is over, and where its gutter button belongs. */
interface Hover {
  blockPos: number;
  top: number;
}

/** The gap between the caret and the menu, in pixels. */
const OFFSET = 6;

/** The gutter button's height, in pixels — kept in step with `.ub-gutter-add`. */
const BUTTON_SIZE = 22;

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
 * The top-level block position for a DOM node inside the editor, or `null` when
 * the node is not in one. Walks up to the child of the ProseMirror root, then
 * asks the view which position renders it — an index lookup would be wrong the
 * moment a widget decoration sat between two blocks.
 */
function blockPosAt(editor: Editor, target: EventTarget | null): number | null {
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

  let pos = 0;
  const { doc } = view.state;
  for (let index = 0; index < doc.childCount; index += 1) {
    if (view.nodeDOM(pos) === element) return pos;
    pos += doc.child(index).nodeSize;
  }
  return null;
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

  // The trigger is derived from editor state on every transaction: a remote
  // edit, an undo or a click that moves the caret closes the menu by itself.
  useEffect(() => {
    const read = (typed: boolean): void => {
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
        // Typing opens the menu; moving the caret only keeps an open one open.
        // Otherwise clicking at the end of a paragraph that happens to read
        // "/todo" would pop a menu nobody asked for.
        current === null && !typed
          ? null
          : { trigger, point: pointAtCaret(editor, host.current) },
      );
    };
    read(false);
    const onTransaction = ({ transaction }: { transaction: Transaction }): void =>
      read(transaction.docChanged);
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
      const blockPos = blockPosAt(editor, event.target);
      if (blockPos === null) return;
      const top = gutterTop(editor, blockPos, frame);
      setHover((previous) =>
        previous !== null && previous.blockPos === blockPos && previous.top === top
          ? previous
          : { blockPos, top },
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

  const choose = useCallback(
    (entry: BlockMenuEntry | undefined): void => {
      if (entry === undefined) return;
      if (gutter !== null) {
        insertBlockBelow(editor, gutter.blockPos, entry);
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
      if (!handleKey(event.key)) return;
      event.preventDefault();
      event.stopPropagation();
    };
    target.addEventListener("keydown", onKeyDown, true);
    return () => {
      target.removeEventListener("keydown", onKeyDown, true);
    };
  }, [editor, path, open, handleKey]);

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
                      entry before rather than a grouping pass. */}
                  {entries[position - 1]?.group !== entry.group && (
                    <p className="ub-blockmenu-group">{entry.group}</p>
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
