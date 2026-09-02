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

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ReactElement, ReactNode, RefObject } from "react";
import type * as Y from "yjs";
import {
  AnnotationRangeError,
  createAnnotation,
  isExternalHref,
  isProseBlockType,
} from "@uberblick/schema";
import type { Editor } from "@tiptap/core";
import { endUndoCapture } from "../editor/block-menu.js";
import { commentTargetOf } from "../editor/selection.js";
import type { CommentTarget } from "../editor/selection.js";
import { CommentForm } from "./CommentForm.js";
import { blockRefLabel } from "./threads.js";

type FlagMark = "bold" | "italic" | "strike" | "inlineCode";
type MarkState = "off" | "mixed" | "on";
type Mode = "toolbar" | "link" | "comment";

interface Point {
  top: number;
  left: number;
  placement: "above" | "below";
  visible: boolean;
}

interface MarkReading {
  state: MarkState;
  /** Present only when the complete selection carries one external URL. */
  href: string | null;
}

interface Draft extends Point {
  target: CommentTarget;
  marks: Record<FlagMark, MarkReading> & { link: MarkReading };
}

interface Rect {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/** The range a target names, as a value two reads can be compared by. */
function rangeOf(target: CommentTarget): string {
  return `${target.blockId}:${target.start}:${target.end}`;
}

const OFFSET = 6;

/** The visible part of the editor pane; the window is the test/fallback case. */
function availableRect(host: HTMLElement): Rect {
  const pane = host.closest(".ub-pane");
  const paneRect = pane?.getBoundingClientRect();
  const viewport: Rect = {
    top: 0,
    right: window.innerWidth,
    bottom: window.innerHeight,
    left: 0,
  };
  if (paneRect === undefined || paneRect.width === 0 || paneRect.height === 0) {
    return viewport;
  }
  return {
    top: Math.max(viewport.top, paneRect.top),
    right: Math.min(viewport.right, paneRect.right),
    bottom: Math.min(viewport.bottom, paneRect.bottom),
    left: Math.max(viewport.left, paneRect.left),
  };
}

/** Intersect a client rect with the visible pane, or drop an invisible one. */
function clipped(rect: Rect, available: Rect): Rect | null {
  const visible = {
    top: Math.max(rect.top, available.top),
    right: Math.min(rect.right, available.right),
    bottom: Math.min(rect.bottom, available.bottom),
    left: Math.max(rect.left, available.left),
  };
  return visible.right > visible.left && visible.bottom > visible.top
    ? visible
    : null;
}

/** The browser-painted selection, reduced to the part a reader can see. */
function visibleSelectionRect(editor: Editor, available: Rect): Rect | null {
  const { from, to } = editor.state.selection;
  try {
    const start = editor.view.domAtPos(from);
    const end = editor.view.domAtPos(to);
    const range = document.createRange();
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset);
    const rects = [...range.getClientRects()]
      .map((rect) => clipped(rect, available))
      .filter((rect): rect is Rect => rect !== null);
    if (rects.length > 0) {
      return {
        top: Math.min(...rects.map((rect) => rect.top)),
        right: Math.max(...rects.map((rect) => rect.right)),
        bottom: Math.max(...rects.map((rect) => rect.bottom)),
        left: Math.min(...rects.map((rect) => rect.left)),
      };
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Position a measured card inside the visible pane. Above is the ordinary
 * placement; when that does not fit, below wins instead of covering the text.
 */
function pointAt(
  editor: Editor,
  host: HTMLElement | null,
  floating: HTMLElement | null,
  mode: Mode,
): Point {
  if (host === null) {
    return { top: 0, left: 0, placement: "below", visible: true };
  }
  const hostRect = host.getBoundingClientRect();
  // jsdom has no layout; keeping the card at the origin lets component tests
  // exercise the behavior without pretending zero-sized geometry is offscreen.
  if (hostRect.width === 0 && hostRect.height === 0) {
    return { top: 0, left: 0, placement: "below", visible: true };
  }

  const available = availableRect(host);
  const selection = visibleSelectionRect(editor, available);
  if (selection === null) {
    return { top: 0, left: 0, placement: "below", visible: false };
  }

  const width = floating?.offsetWidth ?? (mode === "comment" ? 320 : 360);
  const height = floating?.offsetHeight ?? (mode === "comment" ? 180 : 34);
  const fitsAbove = selection.top - OFFSET - height >= available.top;
  const fitsBelow = selection.bottom + OFFSET + height <= available.bottom;
  let placement: Point["placement"];
  let viewportTop: number;
  if (fitsAbove) {
    placement = "above";
    viewportTop = selection.top - OFFSET - height;
  } else if (fitsBelow) {
    placement = "below";
    viewportTop = selection.bottom + OFFSET;
  } else {
    const roomAbove = selection.top - available.top;
    const roomBelow = available.bottom - selection.bottom;
    placement = roomBelow >= roomAbove ? "below" : "above";
    viewportTop = placement === "below" ? available.bottom - height : available.top;
  }

  const centre = (selection.left + selection.right) / 2;
  const viewportLeft = Math.max(
    available.left,
    Math.min(centre - width / 2, available.right - width),
  );
  return {
    top: viewportTop - hostRect.top,
    left: viewportLeft - hostRect.left,
    placement,
    visible: true,
  };
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
    <button
      type="button"
      className="ub-selection-tool"
      data-state={state}
      aria-label={label}
      aria-pressed={pressed(state)}
      onPointerDown={(event) => event.preventDefault()}
      onClick={onClick}
    >
      {children}
    </button>
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
    const hostDom = host.current;
    const read = (): void => {
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
        ...pointAt(editor, host.current, floating.current, modeNow.current),
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
    read();
    editor.on("transaction", read);
    editorDom.addEventListener("compositionstart", startComposition);
    editorDom.addEventListener("compositionend", endComposition);
    editorDom.addEventListener("keydown", dismiss, true);
    hostDom?.addEventListener("keydown", dismiss, true);
    window.addEventListener("resize", read);
    window.addEventListener("scroll", read, true);
    return () => {
      editor.off("transaction", read);
      editorDom.removeEventListener("compositionstart", startComposition);
      editorDom.removeEventListener("compositionend", endComposition);
      editorDom.removeEventListener("keydown", dismiss, true);
      hostDom?.removeEventListener("keydown", dismiss, true);
      window.removeEventListener("resize", read);
      window.removeEventListener("scroll", read, true);
    };
  }, [editor, ydoc, host]);

  // Opening a field changes the card's size; position the measured shape, not
  // the toolbar dimensions from the preceding render.
  useLayoutEffect(() => {
    setDraft((current) =>
      current === null
        ? null
        : {
            ...current,
            ...pointAt(editor, host.current, floating.current, mode),
          },
    );
  }, [editor, host, mode]);

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

  const className = [
    "ub-composer",
    mode === "comment" ? "" : "ub-selection-menu",
    mode === "toolbar" && !prose ? "ub-comment-only-menu" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div
      ref={floating}
      className={className}
      data-placement={draft.placement}
      style={{
        top: `${draft.top}px`,
        left: `${draft.left}px`,
        visibility: draft.visible ? "visible" : "hidden",
        pointerEvents: draft.visible ? "auto" : "none",
      }}
    >
      {mode === "comment" ? (
        <>
          <p className="ub-composer-head">
            <span className="ub-thread-ref">{blockRef}</span>
            {target.clamped && (
              <span className="ub-chip ub-chip-orphaned">first block only</span>
            )}
          </p>
          <p className="ub-thread-excerpt">{target.text}</p>
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
          className="ub-selection-link"
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
          <input
            // biome-ignore lint/a11y/noAutofocus: the field exists only after the writer asks for it.
            autoFocus
            className="ub-selection-link-input"
            aria-label="External link URL"
            aria-invalid={error === null ? undefined : true}
            placeholder="https://example.com"
            value={href}
            onChange={(event) => {
              setHref(event.target.value);
              setError(null);
            }}
          />
          <button
            type="button"
            className="ub-selection-tool"
            onPointerDown={(event) => event.preventDefault()}
            onClick={close}
          >
            Cancel
          </button>
          <button
            type="submit"
            className="ub-selection-tool ub-selection-apply"
            onPointerDown={(event) => event.preventDefault()}
          >
            Apply
          </button>
          {error !== null && <span className="ub-selection-error">{error}</span>}
        </form>
      ) : prose ? (
        <div
          className="ub-selection-toolbar"
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
          <button
            type="button"
            className="ub-selection-tool"
            aria-label="External link"
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => {
              setHref(draft.marks.link.href ?? "");
              setError(null);
              setMode("link");
            }}
          >
            Link
          </button>
          <span className="ub-selection-separator" aria-hidden="true" />
          <button
            type="button"
            className="ub-selection-tool ub-composer-open"
            aria-label="Comment"
            onPointerDown={(event) => event.preventDefault()}
            onClick={openComment}
          >
            Comment
          </button>
        </div>
      ) : (
        <button
          type="button"
          className="ub-tool ub-composer-open ub-comment-only"
          onPointerDown={(event) => event.preventDefault()}
          onClick={openComment}
        >
          Comment on {blockRef}
        </button>
      )}
    </div>
  );
}
