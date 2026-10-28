/**
 * Derive the rail from annotations and surviving marks across every block.
 * Splits can move a range out of its recorded block; schema resolves the
 * surviving anchor for every read surface.
 */

import type * as Y from "yjs";
import {
  CARD_PARTS,
  getAnnotationsMap,
  getAnnotationCommentIds,
  getBlocks,
  getBlocksFragment,
  listAnnotations,
  resolveAnnotationAnchors,
} from "@uberblick/schema";
import type {
  AnnotationComment,
  AnnotationAnchor,
  Block,
  BlockType,
} from "@uberblick/schema";
import { formatTimestamp } from "../timestamps.js";
import { revealFoldedTarget } from "../../editor/toggle-headings.js";

/** Longest quoted excerpt a card shows before it is cut short. */
const EXCERPT_MAX = 160;

/** How long a clicked highlight stays flashed, in milliseconds. */
const FLASH_MS = 1200;

const FLASH_CLASS = "ub-comment-flash";

/**
 * Allow only bounded UUID-compatible characters in stylesheet selectors.
 * Arbitrarily long safe-looking IDs would generate oversized CSS on every
 * rail render.
 */
const SAFE_THREAD_ID = /^[0-9A-Za-z-]{1,64}$/;

const BLOCK_LABELS: Record<BlockType, string> = {
  paragraph: "Paragraph",
  heading: "Heading",
  code: "Code block",
  "list-item": "List item",
  quote: "Quote",
  divider: "Divider",
  callout: "Callout",
  table: "Table",
  terminal: "Terminal demo",
  chart: "Line chart",
  card: "Card",
  figma: "Figma",
};

/** Use one-based kind and position labels in both composer and cards. */
export function blockRefLabel(type: BlockType, index: number, source = ""): string {
  let label = BLOCK_LABELS[type];
  if (type === "chart") {
    try {
      const mapping: unknown = JSON.parse(source);
      if (mapping !== null && typeof mapping === "object" && "type" in mapping) {
        if (mapping.type === "table") label = "Data table";
        else if (mapping.type === "scatter") label = "Scatter plot";
      }
    } catch { /* Incomplete source keeps the chart label. */ }
  }
  return `${label} ${index + 1}`;
}

/** Stable row identity remains the same when text is edited. */
export interface ThreadComment extends AnnotationComment {
  key: string;
}

/** One thread's card. */
export interface ThreadView {
  id: string;
  /** The block the thread names — where the range was made. */
  blockId: string;
  /** The block whose text carries the mark now; null when orphaned. */
  anchorBlockId: string | null;
  /** Human-readable reference to the block the range lives (or lived) in. */
  blockRef: string;
  /** The marked text, verbatim, cut at {@link EXCERPT_MAX}. Empty when orphaned. */
  excerpt: string;
  /** No surviving `comment` mark anywhere in the document. */
  orphaned: boolean;
  resolved: boolean;
  comments: ThreadComment[];
  /** Comments after the first one. */
  replyCount: number;
}

/**
 * Increment click even for the same thread so repeated activation scrolls a
 * displaced card back into view.
 */
export interface ThreadFocus {
  id: string;
  click: number;
  /**
   * Keyboard activation moves DOM focus to the card; pointer activation
   * preserves the prose caret.
   */
  viaKeyboard: boolean;
}

/**
 * How a thread was selected. The defaults describe a card click: pointer-led,
 * with the card retaining its own expand/collapse gesture.
 */
export interface ThreadSelection {
  viaKeyboard?: boolean;
}

/** Select a thread, carrying only the behavior its activation requested. */
export type SelectThread = (
  threadId: string | null,
  selection?: ThreadSelection,
) => void;

/** The focus after selecting `threadId`, given the focus before it. */
export function focusThread(
  previous: ThreadFocus | null,
  threadId: string,
  selection: ThreadSelection = {},
): ThreadFocus {
  return {
    id: threadId,
    click: (previous?.click ?? 0) + 1,
    viaKeyboard: selection.viaKeyboard === true,
  };
}

function excerptOf(anchor: AnnotationAnchor | null): string {
  if (anchor === null) return "";
  const quoted = anchor.text;
  return quoted.length > EXCERPT_MAX
    ? `${quoted.slice(0, EXCERPT_MAX)}…`
    : quoted;
}

/** Name deleted ranges by readable block position rather than UUID. */
function blockRefFor(
  byId: Map<string, Block>,
  order: Map<string, number>,
  blockId: string,
): string {
  const block = byId.get(blockId);
  const index = order.get(blockId);
  if (block === undefined || index === undefined) return "deleted block";
  return blockRefLabel(block.type, index, block.text);
}

/**
 * Sort by anchor block and offset. Orphans retain their recorded block and
 * sort at its head; completely missing blocks sort last. Check for no threads
 * before walking blocks on every keystroke.
 */
export function threadsFromDoc(ydoc: Y.Doc): ThreadView[] {
  if (getAnnotationsMap(ydoc).size === 0) return [];

  const blocks = getBlocks(ydoc);
  const byId = new Map(blocks.map((block) => [block.id, block] as const));
  const order = new Map(blocks.map((block, index) => [block.id, index] as const));
  const anchors = resolveAnnotationAnchors(ydoc);

  const views: ThreadView[] = listAnnotations(ydoc).map((annotation) => {
    const anchor = anchors.get(annotation.id) ?? null;
    const commentIds = getAnnotationCommentIds(ydoc, annotation.id);
    return {
      id: annotation.id,
      blockId: annotation.blockId,
      anchorBlockId: anchor?.blockId ?? null,
      blockRef: blockRefFor(byId, order, anchor?.blockId ?? annotation.blockId),
      excerpt: excerptOf(anchor),
      orphaned: anchor === null,
      resolved: annotation.resolved === true,
      comments: annotation.comments.map((comment, index) => ({
        ...comment,
        key: commentIds[index] ?? `${annotation.id}:${index}`,
      })),
      replyCount: Math.max(0, annotation.comments.length - 1),
    };
  });

  const position = (view: ThreadView): [number, number, number, number] => {
    const anchor = anchors.get(view.id);
    const range = anchor?.range;
    // A thread whose block is gone entirely sorts last, not first.
    const index = order.get(anchor?.blockId ?? view.blockId) ?? Number.MAX_SAFE_INTEGER;
    // Use -1 for orphan offsets so UUID order cannot tie them with a live
    // anchor at offset zero.
    const partOrder = range?.part === undefined ? range?.row ?? -1
      : range.part === "caption" ? 0 : CARD_PARTS.indexOf(range.part);
    return [index, partOrder, range?.column ?? -1, range?.start ?? -1];
  };
  return views.sort((a, b) => {
    const [blockA, rowA, columnA, startA] = position(a);
    const [blockB, rowB, columnB, startB] = position(b);
    if (blockA !== blockB) return blockA - blockB;
    if (rowA !== rowB) return rowA - rowB;
    if (columnA !== columnB) return columnA - columnB;
    if (startA !== startB) return startA - startB;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/**
 * Observe annotations and blocks deeply: replies modify nested arrays and
 * deleted marks modify nested text. Coalesce shared transactions into one
 * microtask; seed synchronously so mounting never flashes empty.
 */
export function observeThreads(
  ydoc: Y.Doc,
  onChange: (threads: ThreadView[]) => void,
): () => void {
  const fragment = getBlocksFragment(ydoc);
  const annotations = getAnnotationsMap(ydoc);
  let queued = false;
  let live = true;
  const schedule = (): void => {
    if (queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      // The unsubscribe can land between the queue and the flush.
      if (live) onChange(threadsFromDoc(ydoc));
    });
  };
  onChange(threadsFromDoc(ydoc));
  fragment.observeDeep(schedule);
  annotations.observeDeep(schedule);
  return () => {
    live = false;
    fragment.unobserveDeep(schedule);
    annotations.unobserveDeep(schedule);
  };
}

/** The DOM id of a thread's card, which is how a highlight click reaches it. */
export function threadCardId(threadId: string): string {
  return `ub-thread-${threadId}`;
}

/**
 * Resolve delegated highlight clicks through the nearest data-comment-thread
 * ancestor.
 */
export function threadIdFromTarget(target: EventTarget | null): string | null {
  if (!(target instanceof Element)) return null;
  const anchor = target.closest(".ub-comment[data-comment-thread]");
  const threadId = anchor?.getAttribute("data-comment-thread") ?? "";
  return threadId === "" ? null : threadId;
}

/**
 * Enter/Space activates only a focused highlight. Caret typing targets
 * contenteditable, outside highlight ancestry, and must remain untouched.
 */
export function threadIdFromActivation(event: KeyboardEvent): string | null {
  if (event.key !== "Enter" && event.key !== " ") return null;
  return threadIdFromTarget(event.target);
}

/**
 * Key flash timers weakly by span; repeated clicks cancel the old timer,
 * while ProseMirror may replace the element at any redraw.
 */
const flashTimers = new WeakMap<Element, ReturnType<typeof setTimeout>>();

/**
 * Orphans have no highlight to scroll to. Restart each live flash by removing
 * the class and forcing layout before reapplying it.
 */
export function flashThreadHighlight(threadId: string): void {
  const selector = `.ub-comment[data-comment-thread="${CSS.escape(threadId)}"]`;
  const target = document.querySelector<HTMLElement>(selector);
  if (target !== null) revealFoldedTarget(target);
  const spans = document.querySelectorAll<HTMLElement>(
    selector,
  );
  const first = spans[0];
  if (first === undefined) return;
  first.scrollIntoView({ behavior: "smooth", block: "center" });
  for (const span of spans) {
    const pending = flashTimers.get(span);
    if (pending !== undefined) clearTimeout(pending);
    span.classList.remove(FLASH_CLASS);
    void span.offsetWidth;
    span.classList.add(FLASH_CLASS);
    flashTimers.set(
      span,
      setTimeout(() => {
        span.classList.remove(FLASH_CLASS);
        flashTimers.delete(span);
      }, FLASH_MS),
    );
  }
}

/** Selected highlights are the only amber comment ranges in the document. */
export function selectedHighlightCss(threadId: string | null): string {
  if (threadId === null || !SAFE_THREAD_ID.test(threadId)) return "";
  return `.ub-comment[data-comment-thread="${threadId}"]{background:var(--brand-subtle);}`;
}

/** Scroll a thread's card into view inside the rail. */
export function scrollThreadCardIntoView(threadId: string): void {
  document
    .getElementById(threadCardId(threadId))
    ?.scrollIntoView({ block: "nearest" });
}

/**
 * Focus the card's native selection button before its quiet actions.
 */
export function focusThreadCard(threadId: string): void {
  document.getElementById(threadCardId(threadId))
    ?.querySelector<HTMLElement>(".ub-thread-select")?.focus();
}

/** Escape from a card returns to its live highlight, or the document text. */
export function returnFocusToComment(threadId: string): void {
  const highlight = document.querySelector<HTMLElement>(
    `.ub-comment[data-comment-thread="${CSS.escape(threadId)}"]`,
  );
  if (highlight !== null) {
    highlight.focus();
    return;
  }
  const text = document.querySelector<HTMLElement>(".ub-editor .tiptap")
    ?? document.querySelector<HTMLElement>(".ub-document-pane");
  if (text === null) return;
  if (!text.hasAttribute("tabindex")) text.tabIndex = -1;
  text.focus();
}

/**
 * A comment's timestamp for the card's byline. The shared formatter owns the
 * visible time policy; this surface owns its honest invalid-value fallback.
 */
export interface CommentTimestamp {
  label: string;
  /** Absent when `createdAt` is not a date — an invalid `dateTime` is worse than none. */
  dateTime?: string;
  title?: string;
}

export function commentTimestamp(
  createdAt: string,
  now: number = Date.now(),
): CommentTimestamp {
  return formatTimestamp(createdAt, now) ?? { label: createdAt };
}
