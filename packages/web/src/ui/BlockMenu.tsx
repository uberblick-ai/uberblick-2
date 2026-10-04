/**
 * The block-insertion menu — one component, two ways in.
 *
 * Typing `/` in an empty paragraph opens it at the caret and converts that
 * block; hovering a block or placing a caret by touch reveals a `+` in the left
 * gutter which opens the same list and inserts a new block below. The entries,
 * filtering and transactions live in `editor/block-menu.ts`; what this file
 * owns is pixels, focus and keys.
 *
 * ProseMirror owns composition and menu keys; the shared CaretMenu uses
 * Floating UI placement and native-click dismissal. Trigger state and picks
 * remain the model's.
 * The gutter is reserved rather than inserted, so hover never moves prose.
 *
 * The menu is local UI, and the document does not change until an entry is
 * picked — but the document underneath it is not. A peer can delete or move the
 * block a session or a gutter button is aimed at, so both hold a block **id**
 * rather than a position, both re-resolve it on every transaction, and both
 * close rather than act on a block that has gone.
 */

import { useCallback, useEffect, useRef, useState } from "react";
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
import { useCaretMenuKeys } from "./caret-menu.js";
import { CaretMenu, useCaretMenuIds } from "./CaretMenu.js";

interface SlashSession {
  trigger: SlashTrigger;
}

/**
 * The block the gutter button belongs to, by hover or touch caret. Named by id:
 * its block has to be findable again after the document has moved under it.
 */
interface GutterTarget {
  blockId: string;
  top: number;
  touch: boolean;
}

/** Kept in step with the button's size utilities. */
const FINE_BUTTON_SIZE = 24;
const TOUCH_BUTTON_SIZE = 44;

/**
 * The top-level block a DOM node inside the editor belongs to — its id and its
 * position — or `null` when the node is not in one.
 *
 * Two steps, both cheap, because this runs on every fine-pointer move over the
 * prose: walk up the ancestors to the ProseMirror root's own child (bounded by nesting
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
function gutterTop(
  editor: Editor,
  pos: number,
  frame: HTMLElement | null,
  touch: boolean,
): number {
  const dom = editor.view.nodeDOM(pos);
  if (frame === null || !(dom instanceof HTMLElement)) return 0;
  const rect = dom.getBoundingClientRect();
  const base = frame.getBoundingClientRect();
  const lineHeight = Number.parseFloat(dom.ownerDocument.defaultView?.getComputedStyle(dom).lineHeight ?? "");
  const firstLine = Number.isFinite(lineHeight) ? lineHeight : rect.height;
  const size = touch ? TOUCH_BUTTON_SIZE : FINE_BUTTON_SIZE;
  const top = rect.top - base.top + Math.max(0, (firstLine - size) / 2);
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
  const [hover, setHover] = useState<GutterTarget | null>(null);
  /** The open gutter menu: which block it will insert below, and where it sits. */
  const [gutter, setGutter] = useState<GutterTarget | null>(null);
  const [gutterQuery, setGutterQuery] = useState("");
  /** The highlighted entry, and the list it was highlighted in. */
  const [highlight, setHighlight] = useState<{ list: string; index: number; keyboard: boolean }>({
    list: "",
    index: 0,
    keyboard: false,
  });
  /**
   * Esc, remembered for as long as the session it dismissed. Cleared the moment
   * the block stops looking like a slash session — so deleting the `/` and
   * typing it again opens the menu, while typing on after Esc leaves the text
   * alone, which is what Esc meant.
   */
  const dismissed = useRef(false);
  const gutterButton = useRef<HTMLButtonElement | null>(null);
  // A newly opened document may acquire its caret before the first pointer
  // event. Use the primary pointer only as that initial fallback; real events
  // below override it so an iPad's trackpad still uses hover.
  const touchInput = useRef(
    editor.view.dom.ownerDocument.defaultView?.matchMedia?.("(pointer: coarse)").matches ?? false,
  );
  // iOS may blur the editor between a gutter press and its click. The target
  // must survive that interval so the same native click can open the menu.
  const gutterPressed = useRef(false);
  /** The gutter menu's search field, when one is open — a composition surface. */
  const search = useRef<HTMLInputElement | null>(null);
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
          : { trigger },
      );
    };
    read(null);
    const onTransaction = ({ transaction }: { transaction: Transaction }): void =>
      read(transaction);
    editor.on("transaction", onTransaction);
    return () => {
      editor.off("transaction", onTransaction);
    };
  }, [editor]);

  // Fine-pointer hover is tracked on the ProseMirror root so the button
  // itself — which is outside it — never counts as leaving the block, and
  // cleared when the pointer leaves the frame. The gutter strip the button
  // overhangs into is the frame's too (`.ub-editor-frame::before`), so the
  // route from the prose to the button is one unbroken piece of it: the button
  // cannot hide in the gap on the way.
  useEffect(() => {
    const dom = editor.view.dom;
    const frame = host.current;
    const ownerDocument = dom.ownerDocument;
    const ownerWindow = ownerDocument.defaultView;
    const show = (blockId: string, pos: number, touch: boolean): void => {
      const top = gutterTop(editor, pos, frame, touch);
      setHover((previous) =>
        previous !== null && previous.blockId === blockId && previous.top === top && previous.touch === touch
          ? previous
          : { blockId, top, touch },
      );
    };
    const readCaret = (): void => {
      if (!touchInput.current) return;
      const { selection } = editor.state;
      const { $head } = selection;
      if (!editor.isEditable || (!editor.isFocused && !gutterPressed.current) ||
          !selection.empty || $head.depth < 1 || !$head.parent.isTextblock) {
        setHover(null);
        return;
      }
      const id: unknown = $head.node(1).attrs.id;
      if (typeof id !== "string" || id === "") {
        setHover(null);
        return;
      }
      show(id, $head.before(1), true);
    };
    const track = (event: PointerEvent): void => {
      // Pointer events distinguish a trackpad on an iPad from its touchscreen.
      // Listening to mousemove would also reveal the button for iOS's
      // compatibility mouse events after a tap or touch range selection.
      if (event.pointerType === "touch") return;
      touchInput.current = false;
      const block = blockAt(editor, event.target);
      if (block === null) return;
      show(block.blockId, block.pos, false);
    };
    const press = (event: PointerEvent): void => {
      touchInput.current = event.pointerType === "touch";
      if (touchInput.current) readCaret();
      else track(event);
    };
    const leave = (): void => {
      if (!touchInput.current) setHover(null);
    };
    const blur = (): void => {
      if (touchInput.current && !gutterPressed.current) setHover(null);
    };
    const changed = ({ transaction }: { transaction: Transaction }): void => {
      if (touchInput.current) readCaret();
      else if (transaction.docChanged) setHover(null);
    };
    const release = (): void => {
      if (!gutterPressed.current) return;
      gutterPressed.current = false;
      readCaret();
    };
    const outsidePress = (event: PointerEvent): void => {
      if (event.target !== gutterButton.current) release();
    };
    dom.addEventListener("pointermove", track);
    dom.addEventListener("pointerdown", press);
    frame?.addEventListener("pointerleave", leave);
    // A touch click may follow pointerup in a later task. Release only when
    // its native click has bubbled through React, or the gesture is cancelled
    // or replaced by another press; no delay estimates its arrival.
    ownerDocument.addEventListener("click", release);
    ownerDocument.addEventListener("pointercancel", release);
    ownerDocument.addEventListener("pointerdown", outsidePress, true);
    ownerWindow?.addEventListener("resize", readCaret);
    editor.on("transaction", changed);
    editor.on("focus", readCaret);
    editor.on("blur", blur);
    readCaret();
    return () => {
      dom.removeEventListener("pointermove", track);
      dom.removeEventListener("pointerdown", press);
      frame?.removeEventListener("pointerleave", leave);
      ownerDocument.removeEventListener("click", release);
      ownerDocument.removeEventListener("pointercancel", release);
      ownerDocument.removeEventListener("pointerdown", outsidePress, true);
      ownerWindow?.removeEventListener("resize", readCaret);
      editor.off("transaction", changed);
      editor.off("focus", readCaret);
      editor.off("blur", blur);
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
    (index: number, keyboard = false): void =>
      setHighlight((current) =>
        current.list === list && current.index === index && current.keyboard === keyboard
          ? current
          : { list, index, keyboard },
      ),
    [list],
  );

  // A closed menu keeps no highlight, so the next one opens on its first entry
  // — which is the entry a list scrolled back to the top is showing. Remembering
  // an index instead would reopen the menu highlighting something off screen.
  useEffect(() => {
    if (!open) setHighlight({ list: "", index: 0, keyboard: false });
  }, [open]);

  const closeGutter = useCallback((): void => {
    setGutter(null);
    setGutterQuery("");
  }, []);

  /**
   * An *open* gutter menu follows its block on every transaction: gone means
   * closed, moved means re-measured. Its target stays fixed even while focus
   * belongs to the menu's search field rather than the editor.
   *
   * A merely hovered button gets the cheap treatment above instead. Following it
   * too meant a `findBlockById` plus a `getBoundingClientRect` plus a
   * `getComputedStyle` on **every transaction** — that is per keystroke, local
   * or remote, for as long as the pointer rests anywhere over the prose, to keep
   * a hint in the right place.
   */
  const menuAnchorId = gutter?.blockId ?? null;
  const menuTouch = gutter?.touch ?? false;
  useEffect(() => {
    if (menuAnchorId === null) return;
    const follow = (): void => {
      const found = findBlockById(editor.state.doc, menuAnchorId);
      if (found === null) {
        closeGutter();
        return;
      }
      const top = gutterTop(editor, found.pos, host.current, menuTouch);
      setGutter((previous) =>
        previous === null || previous.top === top ? previous : { ...previous, top },
      );
    };
    editor.on("transaction", follow);
    return () => {
      editor.off("transaction", follow);
    };
  }, [editor, host, menuAnchorId, menuTouch, closeGutter]);

  const choose = useCallback(
    (entry: BlockMenuEntry | undefined): void => {
      if (entry === undefined) return;
      if (gutter !== null) {
        // A refusal means the block is gone; either way the menu has had its
        // answer and closes.
        insertBlockBelow(editor, gutter.blockId, entry);
        closeGutter();
        if (!gutter.touch) setHover(null);
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
      highlightAt(next, true);
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

  const { listId, activeId } = useCaretMenuIds(active);
  useCaretMenuKeys(editor, path === "slash" && open ? handleKey : null, listId, activeId);
  const dismiss = (): void => {
    if (gutter !== null) closeGutter();
    else {
      dismissed.current = true;
      setSlash(null);
    }
  };

  const anchor = gutter ?? hover;
  const visible = anchor !== null;
  return (
    <>
      {/* Always mounted, so revealing it is a change of opacity and nothing
          else. Out of the tab order while invisible: the keyboard route to this
          menu is the slash, not a button nobody can see. */}
      <button
        type="button"
        ref={gutterButton}
        className={`absolute z-[1] flex items-center justify-center rounded-(--radius-sm) border border-transparent bg-transparent p-0 text-base leading-none text-(--muted-foreground) [font-family:inherit] transition-opacity duration-[120ms] ease-out motion-reduce:transition-none ${
          anchor?.touch ? "left-[-44px] size-11" : "left-[calc(-1*var(--block-gutter))] size-6"
        } ${visible ? "pointer-events-auto cursor-pointer opacity-100 hover:bg-secondary hover:border-(--border) hover:text-foreground" : "pointer-events-none opacity-0"}`}
        style={{ top: `${anchor?.top ?? 0}px` }}
        aria-label="Insert block below"
        title="Insert block below"
        aria-hidden={!visible}
        tabIndex={-1}
        // Keep the touch target through blur without cancelling its native
        // click. Mouse-down cancellation keeps the caret until a pick.
        onPointerDown={() => {
          gutterPressed.current = true;
        }}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => {
          if (hover === null) return;
          setGutterQuery("");
          setGutter(hover);
        }}
      >
        +
      </button>
      <CaretMenu
        editor={editor}
        host={host}
        anchor={path === "gutter" ? gutterButton : undefined}
        open={open}
        onDismiss={dismiss}
        listKey={list}
        listId={listId}
        label="Block types"
        options={entries.map((entry) => ({
          id: entry.id, label: entry.label, group: entry.group,
          hint: entry.trigger === null ? undefined : triggerHint(entry),
        }))}
        active={active}
        reveal={highlight.list === list && highlight.keyboard}
        highlightAt={highlightAt}
        choose={(index) => choose(entries[index])}
        empty="No blocks match."
      >
        {path === "gutter" && (
          <input
            ref={search}
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={open}
            aria-controls={entries.length > 0 ? listId : undefined}
            aria-activedescendant={activeId}
            className="mb-[0.3rem] w-full shrink-0 rounded-(--radius-sm) border border-input bg-background px-[0.4rem] py-[0.3rem] text-[0.85rem] text-foreground [font-family:inherit] [@media(pointer:coarse)]:text-base"
            placeholder="Search blocks…"
            aria-label="Search blocks"
            value={gutterQuery}
            // Deliberately opening the gutter menu starts its search.
            // biome-ignore lint/a11y/noAutofocus: this field is the opened menu's control.
            autoFocus
            onChange={(event) => setGutterQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
              if (!handleKey(event.key)) return;
              event.preventDefault();
              event.stopPropagation();
            }}
          />
        )}
      </CaretMenu>
    </>
  );
}
