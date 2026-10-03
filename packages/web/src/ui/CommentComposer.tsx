/**
 * Selection chrome for the prose: inline formatting, external links and the
 * existing comment composer.
 *
 * A selection wholly inside one prose block gets the compact toolbar. Source
 * blocks and cross-block ranges keep the older Comment-only affordance because
 * the annotation API can clamp them honestly while inline marks cannot. The
 * component is mounted only beside a live editable editor; archived and
 * foreign-content panes never mount it.
 */

import { useEffect, useRef, useState } from "react";
import type { ReactElement, ReactNode, RefObject } from "react";
import { createPortal } from "react-dom";
import { autoUpdate, computePosition, flip, hide, inline, offset, shift, size } from "@floating-ui/dom";
import type * as Y from "yjs";
import {
  AnnotationRangeError,
  createAnnotation,
  isExternalHref,
  isProseBlockType,
} from "@uberblick/schema";
import type { Editor } from "@tiptap/core";
import type { Transaction } from "@tiptap/pm/state";
import { endUndoCapture } from "../editor/block-menu.js";
import { commentTargetOf } from "../editor/selection.js";
import type { CommentTarget } from "../editor/selection.js";
import { CommentForm } from "./CommentForm.js";
import { blockRefLabel } from "./threads.js";
import { Button } from "./shadcn/button.js";
import { Input } from "./shadcn/input.js";

type FlagMark = "bold" | "italic" | "strike" | "inlineCode";
type MarkState = "off" | "mixed" | "on";
type Mode = "toolbar" | "link" | "comment";

interface MarkReading {
  state: MarkState;
  /** Present only when the complete selection carries one external URL. */
  href: string | null;
}

interface Draft {
  target: CommentTarget;
  marks: Record<FlagMark, MarkReading> & { link: MarkReading };
}

/** The range a target names, as a value two reads can be compared by. */
function rangeOf(target: CommentTarget): string {
  return `${target.blockId}:${target.start}:${target.end}`;
}

/** Read the editor's stored range even while a link or comment field has focus. */
function selectionRange(editor: Editor): Range | null {
  const { from, to } = editor.state.selection;
  try {
    const start = editor.view.domAtPos(from);
    const end = editor.view.domAtPos(to);
    const range = editor.view.dom.ownerDocument.createRange();
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset);
    return range;
  } catch {
    return null;
  }
}

/** How much of the current selection carries `name`, plus its one URL if any. */
function markReading(
  editor: Editor,
  name: FlagMark | "docLink" | "link",
): MarkReading {
  const { doc, selection } = editor.state;
  let selected = 0;
  let marked = 0;
  let href: string | null = null;
  let oneHref = true;

  doc.nodesBetween(selection.from, selection.to, (node, pos) => {
    if (!node.isText) return;
    const start = Math.max(selection.from, pos);
    const end = Math.min(selection.to, pos + node.nodeSize);
    if (end <= start) return;
    const length = end - start;
    selected += length;
    const mark = node.marks.find((candidate) => candidate.type.name === name);
    if (mark === undefined) return;
    marked += length;
    if (name === "link") {
      const next = typeof mark.attrs.href === "string" ? mark.attrs.href : null;
      if (href !== null && href !== next) oneHref = false;
      href = next;
    }
  });

  const state: MarkState =
    marked === 0 || selected === 0
      ? "off"
      : marked === selected
        ? "on"
        : "mixed";
  return { state, href: state === "on" && oneHref ? href : null };
}

/** A toolbar write is one bounded Yjs undo item, never part of nearby typing. */
function boundedWrite(editor: Editor, write: () => void): void {
  endUndoCapture(editor.state);
  write();
  endUndoCapture(editor.state);
}

function selectedProseTarget(editor: Editor, ydoc: Y.Doc): CommentTarget | null {
  const target = commentTargetOf(editor, ydoc);
  return target !== null && !target.clamped && isProseBlockType(target.blockType)
    ? target
    : null;
}

function toggleFlag(editor: Editor, ydoc: Y.Doc, name: FlagMark): void {
  if (selectedProseTarget(editor, ydoc) === null) return;
  const { from, to } = editor.state.selection;
  const type = editor.state.schema.marks[name];
  if (type === undefined) return;
  const remove = markReading(editor, name).state === "on";
  boundedWrite(editor, () => {
    const transaction = editor.state.tr;
    if (remove) transaction.removeMark(from, to, type);
    else transaction.addMark(from, to, type.create());
    editor.view.dispatch(transaction);
  });
}

type LinkRefusal = "document-link" | "invalid-url";

function setExternalLink(
  editor: Editor,
  ydoc: Y.Doc,
  href: string,
): LinkRefusal | null {
  if (selectedProseTarget(editor, ydoc) === null || !isExternalHref(href)) {
    return "invalid-url";
  }
  if (markReading(editor, "docLink").state !== "off") return "document-link";
  const { from, to } = editor.state.selection;
  const type = editor.state.schema.marks.link;
  if (type === undefined) return "invalid-url";
  boundedWrite(editor, () => {
    editor.view.dispatch(editor.state.tr.addMark(from, to, type.create({ href })));
  });
  return null;
}

/** What went wrong, in the reader's terms rather than the API's. */
function refusal(error: unknown): string {
  if (error instanceof AnnotationRangeError) {
    return error.reason === "overlap"
      ? "That range is already part of another thread. Comments cannot overlap — pick a range beside it."
      : "Select some text to comment on.";
  }
  return "Could not start the thread. Re-select the range and try again.";
}

function pressed(state: MarkState): boolean | "mixed" {
  return state === "mixed" ? "mixed" : state === "on";
}

function FormatButton({
  label,
  state,
  children,
  onClick,
}: {
  label: string;
  state: MarkState;
  children: ReactNode;
  onClick: () => void;
}): ReactElement {
  return (
    <Button
      type="button"
      variant="selection"
      size="selection"
      data-selection-tool
      data-state={state}
      aria-label={label}
      aria-pressed={pressed(state)}
      onPointerDown={(event) => event.preventDefault()}
      onClick={onClick}
    >
      {children}
    </Button>
  );
}

export function CommentComposer({
  editor,
  ydoc,
  author,
  mentions,
  host,
  onCreated,
}: {
  editor: Editor;
  ydoc: Y.Doc;
  /** The awareness name this client publishes — the comment's author. */
  author: string;
  /** Peer names offered as `@name` chips. */
  mentions: string[];
  /** The positioned element the selection chrome is placed inside. */
  host: RefObject<HTMLElement | null>;
  /** The new thread, so the rail can focus its card. */
  onCreated: (threadId: string) => void;
}): ReactElement | null {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [mode, setMode] = useState<Mode>("toolbar");
  const [href, setHref] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [touch, setTouch] = useState(false);
  const selectionInput = useRef(false);
  const range = useRef<string | null>(null);
  const dismissed = useRef<string | null>(null);
  const composing = useRef(false);
  const floating = useRef<HTMLDivElement | null>(null);
  const draftNow = useRef<Draft | null>(null);
  const modeNow = useRef(mode);
  draftNow.current = draft;
  modeNow.current = mode;

  useEffect(() => {
    // Capture once: the editor can destroy its view before React runs this
    // component's passive cleanup during a route or fallback transition.
    const editorDom = editor.view.dom;
    const ownerDocument = editorDom.ownerDocument;
    const read = (event?: { transaction: Transaction }): void => {
      if (composing.current) return;
      const target = commentTargetOf(editor, ydoc);
      if (target === null) {
        setDraft(null);
        setMode("toolbar");
        setError(null);
        range.current = null;
        dismissed.current = null;
        return;
      }

      const key = rangeOf(target);
      if (dismissed.current !== null) {
        if (dismissed.current === key) {
          setDraft(null);
          return;
        }
        dismissed.current = null;
      }
      if (range.current !== key) {
        // Only a selection adjustment adopts the pending input. Touching the
        // prose to scroll, or a peer edit remapping the range, preserves the
        // input that actually selected it.
        if (!event?.transaction.docChanged) setTouch(selectionInput.current);
        range.current = key;
        setError(null);
      }
      if (
        modeNow.current === "link" &&
        (target.clamped || !isProseBlockType(target.blockType))
      ) {
        setMode("toolbar");
        setHref("");
      }
      setDraft({
        target,
        marks: {
          bold: markReading(editor, "bold"),
          italic: markReading(editor, "italic"),
          strike: markReading(editor, "strike"),
          inlineCode: markReading(editor, "inlineCode"),
          link: markReading(editor, "link"),
        },
      });
    };
    const dismiss = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || draftNow.current === null) return;
      const path = event.composedPath();
      if (!path.includes(editorDom) && !(floating.current && path.includes(floating.current))) return;
      // This listener runs before the fields. A composing Escape belongs to
      // the input method, so leave the active form and draft intact.
      if (event.isComposing || event.keyCode === 229) return;
      event.preventDefault();
      event.stopPropagation();
      if (modeNow.current !== "toolbar") {
        setMode("toolbar");
        setHref("");
        setError(null);
        return;
      }
      dismissed.current = rangeOf(draftNow.current.target);
      setDraft(null);
      setMode("toolbar");
      setHref("");
      setError(null);
    };
    const startComposition = (): void => {
      composing.current = true;
      setDraft(null);
    };
    const endComposition = (): void => {
      composing.current = false;
      read();
    };
    const pointer = (event: PointerEvent): void => {
      selectionInput.current = event.pointerType === "touch";
    };
    const keyboard = (event: KeyboardEvent): void => {
      if (/^(Arrow|Home|End|Page)/.test(event.key) ||
          (event.key.toLowerCase() === "a" && (event.metaKey || event.ctrlKey))) {
        selectionInput.current = false;
      }
    };
    read();
    editor.on("transaction", read);
    editorDom.addEventListener("compositionstart", startComposition);
    editorDom.addEventListener("compositionend", endComposition);
    editorDom.addEventListener("pointerdown", pointer);
    editorDom.addEventListener("keydown", keyboard);
    ownerDocument.addEventListener("keydown", dismiss, true);
    return () => {
      editor.off("transaction", read);
      editorDom.removeEventListener("compositionstart", startComposition);
      editorDom.removeEventListener("compositionend", endComposition);
      editorDom.removeEventListener("pointerdown", pointer);
      editorDom.removeEventListener("keydown", keyboard);
      ownerDocument.removeEventListener("keydown", dismiss, true);
    };
  }, [editor, ydoc]);

  const open = draft !== null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: mode changes the mounted card's shape; measure it again immediately when a field opens or closes.
  useEffect(() => {
    const element = floating.current;
    if (!open || !element) return;
    const boundary = host.current?.closest<HTMLElement>(".ub-pane") ?? undefined;
    const reference = {
      contextElement: editor.view.dom,
      getBoundingClientRect: (): DOMRect =>
        selectionRange(editor)?.getBoundingClientRect?.() ?? new DOMRect(),
      getClientRects: (): DOMRect[] =>
        Array.from(selectionRange(editor)?.getClientRects?.() ?? []),
    };
    const collision = { boundary, padding: 6 };
    let disposed = false;
    const update = async (): Promise<void> => {
      const position = await computePosition(reference, element, {
        strategy: "fixed",
        placement: touch ? "bottom" : "top",
        middleware: [
          inline(), offset(touch ? 12 : 6),
          // A short final line needs a sideways shift, not a side change.
          flip({ ...collision, crossAxis: false }),
          shift({ ...collision, crossAxis: true }),
          size({
            ...collision,
            apply: ({ availableWidth, availableHeight }) => {
              if (disposed) return;
              Object.assign(element.style, {
                maxWidth: `${Math.max(0, availableWidth)}px`,
                maxHeight: `${Math.max(0, availableHeight)}px`,
              });
            },
          }),
          hide({ boundary }),
        ],
      });
      if (disposed) return;
      const focused = element.contains(element.ownerDocument.activeElement);
      // A focused field stays reachable even if Safari scrolls its selection
      // out of view as the keyboard opens. Floating UI clips to visualViewport.
      const visible = focused || !position.middlewareData.hide?.referenceHidden;
      Object.assign(element.style, {
        left: `${position.x}px`, top: `${position.y}px`,
        visibility: visible ? "visible" : "hidden",
        pointerEvents: visible ? "auto" : "none",
      });
      element.dataset.placement = position.placement === "top" ? "above" : "below";
      const field = element.ownerDocument.activeElement;
      if (focused && field instanceof HTMLElement) {
        const bounds = element.getBoundingClientRect();
        const control = field.getBoundingClientRect();
        if (control.top < bounds.top || control.bottom > bounds.bottom) {
          // Let the browser reveal the focused field in the card's own scroll
          // area when a keyboard resize leaves less room for the comment.
          field.scrollIntoView({ block: "nearest", inline: "nearest" });
        }
      }
    };
    // Transactions move the range within the editor even without resizing it.
    // autoUpdate owns layout, pane and visual viewport scroll/resize.
    editor.on("transaction", update);
    const stop = autoUpdate(reference, element, update);
    return () => { disposed = true; editor.off("transaction", update); stop(); };
  }, [editor, host, open, mode, touch]);

  if (draft === null) return null;
  const { target } = draft;
  const prose = !target.clamped && isProseBlockType(target.blockType);
  const blockRef = blockRefLabel(target.blockType, target.blockIndex);

  const close = (): void => {
    setMode("toolbar");
    setHref("");
    setError(null);
  };

  const create = (text: string): boolean => {
    try {
      const thread = createAnnotation(
        ydoc,
        target.blockId,
        target.start,
        target.end,
        author,
        text,
      );
      close();
      onCreated(thread.id);
      editor.commands.focus(target.contentStart + target.end);
      return true;
    } catch (failure) {
      setError(refusal(failure));
      return false;
    }
  };

  const openComment = (): void => {
    setError(null);
    setMode("comment");
  };

  return createPortal(
    <div
      ref={floating}
      data-slot="selection-composer"
      data-input={touch ? "touch" : "fine"}
      className={`ub-composer fixed top-0 left-0 z-5 flex overflow-auto text-card-foreground shadow-(--shadow-float) ${mode === "comment" ? "w-80 flex-col [&>*]:shrink-0 gap-[0.4rem] rounded-(--radius-sm) border border-(--border) border-l-2 border-l-brand bg-card px-[0.6rem] py-2 text-[0.85rem]" : mode === "toolbar" && !prose ? "w-max bg-transparent shadow-none" : "w-max items-center rounded-[calc(var(--radius-sm)+2px)] border border-(--border) bg-[color-mix(in_srgb,var(--card)_95%,transparent)] p-1 backdrop-blur-[8px]"}`}
    >
      {mode === "comment" ? (
        <>
          <p className="m-0 flex items-center gap-[0.35rem]">
            <span className="mr-auto font-(family-name:--font-mono) text-[0.7rem] tracking-[0.02em] text-(--muted-foreground)">{blockRef}</span>
            {target.clamped && (
              <span data-slot="selection-clamp" className="rounded-(--radius-sm) bg-(--status-warning-subtle) px-[0.3rem] text-[0.65rem] tracking-[0.04em] text-foreground uppercase">first block only</span>
            )}
          </p>
          <p data-slot="selection-excerpt" className="border-l-2 border-(--border) pl-[0.4rem] text-[0.8rem] text-foreground italic before:content-['“'] after:content-['”']">{target.text}</p>
          <CommentForm
            placeholder={`Comment as ${author}…`}
            submitLabel="Comment"
            mentions={mentions}
            error={error}
            onSubmit={create}
            onCancel={close}
          />
        </>
      ) : mode === "link" && prose ? (
        <form
          className="flex min-w-0 flex-wrap items-center gap-[0.15rem]"
          aria-label="External link"
          onSubmit={(event) => {
            event.preventDefault();
            const refusal = setExternalLink(editor, ydoc, href);
            if (refusal !== null) {
              setError(
                refusal === "document-link"
                  ? "Remove the document link before adding an external URL."
                  : "Enter a complete http or https URL.",
              );
              return;
            }
            close();
          }}
        >
          <Input
            autoFocus
            className="flex-1 basis-32"
            aria-label="External link URL"
            aria-invalid={error === null ? undefined : true}
            placeholder="https://example.com"
            value={href}
            onChange={(event) => {
              setHref(event.target.value);
              setError(null);
            }}
          />
          <Button
            type="button"
            variant="selection"
            size="selection"
            data-selection-tool
            onPointerDown={(event) => event.preventDefault()}
            onClick={close}
          >
            Cancel
          </Button>
          <Button
            type="submit"
            variant="selection"
            size="selection"
            data-selection-tool
            data-emphasis
            onPointerDown={(event) => event.preventDefault()}
          >
            Apply
          </Button>
          {error !== null && <span role="alert" className="max-w-44 text-[0.68rem] leading-[1.2] text-destructive">{error}</span>}
        </form>
      ) : prose ? (
        <div
          className="flex flex-wrap items-center gap-[0.15rem]"
          role="toolbar"
          aria-label="Text formatting and comment"
        >
          <FormatButton
            label="Bold"
            state={draft.marks.bold.state}
            onClick={() => toggleFlag(editor, ydoc, "bold")}
          >
            <strong aria-hidden="true">B</strong>
          </FormatButton>
          <FormatButton
            label="Italic"
            state={draft.marks.italic.state}
            onClick={() => toggleFlag(editor, ydoc, "italic")}
          >
            <em aria-hidden="true">I</em>
          </FormatButton>
          <FormatButton
            label="Strikethrough"
            state={draft.marks.strike.state}
            onClick={() => toggleFlag(editor, ydoc, "strike")}
          >
            <s aria-hidden="true">S</s>
          </FormatButton>
          <FormatButton
            label="Inline code"
            state={draft.marks.inlineCode.state}
            onClick={() => toggleFlag(editor, ydoc, "inlineCode")}
          >
            <code aria-hidden="true">&lt;/&gt;</code>
          </FormatButton>
          <Button
            type="button"
            variant="selection"
            size="selection"
            data-selection-tool
            aria-label="External link"
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => {
              setHref(draft.marks.link.href ?? "");
              setError(null);
              setMode("link");
            }}
          >
            Link
          </Button>
          <span className="mx-[0.2rem] h-4 w-px bg-(--border)" aria-hidden="true" />
          <Button
            type="button"
            variant="selection"
            size="selection"
            data-selection-tool
            aria-label="Comment"
            onPointerDown={(event) => event.preventDefault()}
            onClick={openComment}
          >
            Comment
          </Button>
        </div>
      ) : (
        <Button
          type="button"
          variant="secondary"
          size="selection"
          data-selection-tool
          onPointerDown={(event) => event.preventDefault()}
          onClick={openComment}
        >
          Comment on {blockRef}
        </Button>
      )}
    </div>,
    editor.view.dom.ownerDocument.body,
  );
}
