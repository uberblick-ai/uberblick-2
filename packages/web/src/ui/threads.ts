/**
 * The Threads rail: comment threads as the reader sees them, derived from the
 * open document.
 *
 * Nothing is stored for the rail. A thread is a Y.Map in the `annotations`
 * Y.Map, holding its conversation, and its range is a `comment` mark on some
 * block's Y.XmlText, so the rail is those two reads joined — which is why a
 * thread another client creates needs no extra plumbing to appear.
 *
 * The join is what makes the orphaned state detectable. A thread is orphaned
 * when its id appears in no block's marks: every annotated character was
 * deleted, so the conversation has no anchor left. The schema package never
 * cascade-deletes the thread (see annotations.ts), and neither does this — an
 * orphaned thread is rendered dimmed, with its text intact, and is the one card
 * that has nothing to scroll to.
 *
 * Marks are looked for in *every* block, not just the one the thread itself
 * names, because a block split moves half a marked range into a new block. The
 * first anchor in document order is the one the card quotes.
 */

import * as Y from "yjs";
import {
  COMMENT_MARK,
  getAnnotationsMap,
  getBlocks,
  getBlocksFragment,
  listAnnotations,
  readsAsMark,
} from "@uberblick/schema";
import type {
  AnnotationComment,
  Block,
  BlockType,
  CommentMark,
} from "@uberblick/schema";

/** Longest quoted excerpt a card shows before it is cut short. */
const EXCERPT_MAX = 160;

/** How long a clicked highlight stays flashed, in milliseconds. */
const FLASH_MS = 1200;

const FLASH_CLASS = "ub-comment-flash";

/**
 * Thread ids that may be written into a stylesheet verbatim. The schema package
 * generates uuids — 36 characters — so this fits every id the system itself
 * makes with room to spare; anything else came from a client that made one up.
 *
 * Bounded, because "harmless characters" is only half the question: an id that
 * is a megabyte of hyphens injects a megabyte of selector per resolved thread,
 * on every render of the rail. The shape a uuid cannot exceed is the shape this
 * rule accepts.
 */
const SAFE_THREAD_ID = /^[0-9A-Za-z-]{1,64}$/;

const BLOCK_LABELS: Record<BlockType, string> = {
  paragraph: "Paragraph",
  heading: "Heading",
  code: "Code block",
  mermaid: "Mermaid block",
  "list-item": "List item",
  quote: "Quote",
  table: "Table",
};

/**
 * How a block is named to a reader: by its kind and its place in the document,
 * counted from one. The composer names the block it is about to annotate the
 * same way a card names the block it is anchored in, because they are the same
 * sentence at two moments.
 */
export function blockRefLabel(type: BlockType, index: number): string {
  return `${BLOCK_LABELS[type]} ${index + 1}`;
}

/**
 * A comment plus the key the rail renders it under. A stored comment carries no
 * id — a row is an author, text and a timestamp — so a comment's identity is
 * its position in the thread's converged order, and the key is derived here
 * rather than in the view.
 */
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
 * The thread the reader is looking at, as the app shell holds it.
 *
 * `click` is a counter, not decoration. Selecting a thread scrolls its card into
 * view, and a reader who clicks the same highlight twice — because the rail has
 * scrolled away since — means it the second time. An id alone is a state value
 * React recognises as unchanged, so nothing would move.
 */
export interface ThreadFocus {
  id: string;
  click: number;
  /**
   * The selection came from the keyboard, so DOM focus follows it to the card.
   *
   * A pointer click must not: the reader's caret is in the prose where they put
   * it, and yanking focus into the rail would take it away from them. A reader
   * who arrived by Tab and Enter has nothing to lose and everything to gain —
   * without this, the highlight is a control that leads nowhere.
   */
  viaKeyboard: boolean;
  /**
   * This selection activated an anchor that was resolved at that moment, so
   * the rail reveals its collapsed conversation. A card click leaves this
   * false: resolved cards keep their own expand/collapse gesture.
   */
  revealResolved: boolean;
}

/**
 * How a thread was selected. The defaults describe a card click: pointer-led,
 * with the card retaining its own expand/collapse gesture.
 */
export interface ThreadSelection {
  viaKeyboard?: boolean;
  revealResolved?: boolean;
}

/** Select a thread, carrying only the behavior its activation requested. */
export type SelectThread = (
  threadId: string,
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
    revealResolved: selection.revealResolved === true,
  };
}

interface Anchor {
  blockId: string;
  start: number;
  end: number;
}

/**
 * The thread a delta op's attributes anchor to, or null. `readsAsMark` is the
 * schema package's own definition of a usable `comment` mark, so what counts as
 * an anchor is decided in one place.
 */
function threadIdOf(attributes: unknown): string | null {
  if (typeof attributes !== "object" || attributes === null) return null;
  const value = (attributes as Record<string, unknown>)[COMMENT_MARK];
  return readsAsMark(COMMENT_MARK, value) ? (value as CommentMark).threadId : null;
}

/**
 * Where each thread's mark actually sits, from ONE walk of the blocks fragment.
 * The first run in document order wins, so a thread split across two blocks is
 * quoted from its head.
 *
 * One walk and not `listAnnotationRanges` per block: that API re-locates the
 * block by scanning the fragment on every call, so calling it once per block is
 * quadratic in the block count — and this runs on every keystroke.
 *
 * The fragment is read directly, which means honouring the one rule that walk
 * carries: the first element to claim an id is the visible block and any later
 * element repeating that id is shadowed (see `partitionById` in schema's
 * blocks.ts). An element with no id has claimed no block identity, so no thread
 * can name it and nothing here can quote it.
 */
function anchorsByThread(ydoc: Y.Doc): Map<string, Anchor> {
  const found = new Map<string, Anchor>();
  const claimed = new Set<string>();
  for (const child of getBlocksFragment(ydoc).toArray()) {
    if (!(child instanceof Y.XmlElement)) continue;
    const blockId = child.getAttribute("id") ?? "";
    if (blockId === "" || claimed.has(blockId)) continue;
    claimed.add(blockId);
    const text = child.firstChild;
    if (!(text instanceof Y.XmlText)) continue;

    // Adjacent ops carrying the same thread are one run: a mark the reader
    // added inside the annotated range splits the delta but not the anchor.
    let openId: string | null = null;
    let start = 0;
    let end = 0;
    const close = (): void => {
      if (openId !== null && !found.has(openId)) {
        found.set(openId, { blockId, start, end });
      }
      openId = null;
    };
    let index = 0;
    for (const op of text.toDelta() as Array<{
      insert?: unknown;
      attributes?: unknown;
    }>) {
      const length =
        typeof op.insert === "string" ? op.insert.length : op.insert === undefined ? 0 : 1;
      if (length === 0) continue;
      const threadId = threadIdOf(op.attributes);
      if (threadId !== null && threadId === openId) {
        end = index + length;
      } else {
        close();
        if (threadId !== null) {
          openId = threadId;
          start = index;
          end = index + length;
        }
      }
      index += length;
    }
    close();
  }
  return found;
}

function excerptOf(blocks: Map<string, Block>, anchor: Anchor | null): string {
  if (anchor === null) return "";
  const text = blocks.get(anchor.blockId)?.text ?? "";
  const quoted = text.slice(anchor.start, anchor.end);
  return quoted.length > EXCERPT_MAX
    ? `${quoted.slice(0, EXCERPT_MAX)}…`
    : quoted;
}

/**
 * The block reference on a card. Position, not id: a reader locating a deleted
 * range needs "Paragraph 3", and a uuid tells them nothing.
 */
function blockRefFor(
  byId: Map<string, Block>,
  order: Map<string, number>,
  blockId: string,
): string {
  const block = byId.get(blockId);
  const index = order.get(blockId);
  if (block === undefined || index === undefined) return "deleted block";
  return blockRefLabel(block.type, index);
}

/**
 * Every thread in the document, in reading order: by the block its range sits
 * in, then by where in that block. Reading order and not thread-id order — a
 * rail sorted by uuid is a rail you cannot follow down the page.
 *
 * An orphan is placed by the block its record names, at the head of it: the
 * offset its range used to have is recorded nowhere, and the alternative —
 * dropping orphans to the bottom of the rail — would move a card away from
 * the passage the conversation is about.
 *
 * A document with no threads costs nothing: this runs on every keystroke through
 * the fragment observer, and most documents have no annotations at all, so the
 * empty map is checked before a single block is read.
 */
export function threadsFromDoc(ydoc: Y.Doc): ThreadView[] {
  if (getAnnotationsMap(ydoc).size === 0) return [];

  const blocks = getBlocks(ydoc);
  const byId = new Map(blocks.map((block) => [block.id, block] as const));
  const order = new Map(blocks.map((block, index) => [block.id, index] as const));
  const anchors = anchorsByThread(ydoc);

  const views: ThreadView[] = listAnnotations(ydoc).map((annotation) => {
    const anchor = anchors.get(annotation.id) ?? null;
    return {
      id: annotation.id,
      blockId: annotation.blockId,
      anchorBlockId: anchor?.blockId ?? null,
      blockRef: blockRefFor(byId, order, anchor?.blockId ?? annotation.blockId),
      excerpt: excerptOf(byId, anchor),
      orphaned: anchor === null,
      resolved: annotation.resolved === true,
      comments: annotation.comments.map((comment, index) => ({
        ...comment,
        key: `${annotation.id}:${index}`,
      })),
      replyCount: Math.max(0, annotation.comments.length - 1),
    };
  });

  const position = (view: ThreadView): [number, number] => {
    const anchor = anchors.get(view.id);
    // A thread whose block is gone entirely sorts last, not first.
    const index = order.get(anchor?.blockId ?? view.blockId) ?? Number.MAX_SAFE_INTEGER;
    // -1, not 0: an orphan has no offset, and sharing 0 with an anchored thread
    // at the very start of the block would tie the two and let a uuid decide
    // which comes first — stable, but with no pattern a reader could follow.
    return [index, anchor?.start ?? -1];
  };
  return views.sort((a, b) => {
    const [blockA, startA] = position(a);
    const [blockB, startB] = position(b);
    if (blockA !== blockB) return blockA - blockB;
    if (startA !== startB) return startA - startB;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/**
 * Call `onChange` with a fresh rail whenever it could have changed. Returns the
 * unsubscribe.
 *
 * Two subscriptions, because the rail joins two places: the annotations map and
 * the blocks fragment. Both are observed deeply, and for the same reason — the
 * change that matters is one level down. On the fragment it is a *format*
 * change, a mark being deleted with its text, which a shallow observer would
 * never report as a thread orphaning; on the annotations map it is a reply,
 * which is an insert into the thread's own nested comments array and so never
 * touches the map's own keys. Without the deep observer a reply arriving from
 * another replica would sit in the document unrendered until something else
 * moved.
 *
 * The two are coalesced onto a microtask, so a single transaction that touches
 * both — creating a thread writes the map *and* the mark — recomputes the rail
 * once instead of twice. The first read is synchronous: a mounting rail should
 * not paint empty for a tick.
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
 * The thread a click landed in, or null. The editor renders a `comment` mark as
 * a span carrying `data-comment-thread` (see editor/nodes.ts), so a click
 * anywhere inside the highlight resolves through the nearest such ancestor.
 */
export function threadIdFromTarget(target: EventTarget | null): string | null {
  if (!(target instanceof Element)) return null;
  const threadId =
    target
      .closest("[data-comment-thread]")
      ?.getAttribute("data-comment-thread") ?? "";
  return threadId === "" ? null : threadId;
}

/**
 * The thread a key press activated, or null — the keyboard's `threadIdFromTarget`.
 *
 * Enter and Space are what `role="button"` promises, and the target is the
 * decision: a key press with the *caret* in an annotated range targets the
 * contenteditable host, which no highlight is an ancestor of, so typing inside a
 * comment is untouched. Only a highlight the reader has actually focused — by
 * Tab — reads as an activation.
 */
export function threadIdFromActivation(event: KeyboardEvent): string | null {
  if (event.key !== "Enter" && event.key !== " ") return null;
  return threadIdFromTarget(event.target);
}

/**
 * The timer that will clear each flashing span's class. Keyed by the element so a
 * second click cancels the first click's timer instead of letting it strip the
 * class out from under the new flash — and weakly, because ProseMirror is free to
 * replace the span at any redraw.
 */
const flashTimers = new WeakMap<Element, ReturnType<typeof setTimeout>>();

/**
 * Scroll a thread's highlight into view and flash it. A no-op when the thread is
 * orphaned — there is no anchor to scroll to, which is exactly why the card says
 * which block the range lived in instead.
 *
 * Each click restarts the flash rather than joining one already running: the
 * class comes off, the layout is forced, the class goes back on. Without the
 * restart a click near the end of a flash gets almost no animation at all.
 */
export function flashThreadHighlight(threadId: string): void {
  const spans = document.querySelectorAll<HTMLElement>(
    `[data-comment-thread="${CSS.escape(threadId)}"]`,
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

/**
 * The rule that fades a resolved thread's highlight back into the prose.
 *
 * A stylesheet and not a class on the span, because the span is ProseMirror's:
 * it is rebuilt whenever the text inside it changes, and a class this app wrote
 * would vanish on the next keystroke and come back only at the next annotation
 * change. A selector matching `data-comment-thread` — rendered by the live
 * comment mark view (`editor/comment-anchors.ts`) and by the schema's static
 * form (`editor/nodes.ts`) — survives every redraw, and resolving a thread is
 * rare enough that regenerating one rule costs nothing.
 *
 * The declarations are the resolved *state* of `.ub-comment` in styles.css: the
 * amber ground goes and the underline thins to a dotted neutral rule. Faded,
 * not gone — the range is still annotated, and a reader must still be able to
 * find the conversation from the prose.
 *
 * A thread id is data — it is a key in a Y.Map any client can write — so it is
 * checked against {@link SAFE_THREAD_ID}, in shape *and* in length, rather than
 * escaped. Escaping a CSS string means getting backslashes, quotes *and* the
 * line terminators that end a string early all right, and a rule this small is
 * not worth that. An id the check refuses simply gets no fade rule: its
 * highlight stays amber, which is loud and harmless.
 */
export function resolvedHighlightCss(threadIds: readonly string[]): string {
  const safe = threadIds.filter((id) => SAFE_THREAD_ID.test(id));
  if (safe.length === 0) return "";
  const selector = safe.map((id) => `[data-comment-thread="${id}"]`).join(",");
  return `${selector}{background:transparent;border-bottom:1px dotted var(--muted-foreground);}`;
}

/** Scroll a thread's card into view inside the rail. */
export function scrollThreadCardIntoView(threadId: string): void {
  document
    .getElementById(threadCardId(threadId))
    ?.scrollIntoView({ block: "nearest" });
}

/**
 * Move DOM focus to a thread's card — the far end of the keyboard path.
 *
 * The card's body is the one `<button>` in it (see ThreadsPane), which is
 * already the rail's single tab stop per thread, so landing there hands the
 * reader the conversation *and* the Reply and Resolve controls beside it in
 * tab order.
 */
export function focusThreadCard(threadId: string): void {
  document
    .getElementById(threadCardId(threadId))
    ?.querySelector<HTMLElement>("button")
    ?.focus();
}

/** The reader's own locale: a byline is display data, not document data. */
const TIMESTAMP_FORMAT = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

/** What the byline renders: the visible label, and the `<time>` machine value. */
export interface CommentTimestamp {
  label: string;
  /** Absent when `createdAt` is not a date — an invalid `dateTime` is worse than none. */
  dateTime?: string;
}

/**
 * A comment's timestamp for the card's byline: absolute, in the reader's locale.
 * Absolute and not "30 seconds ago", which is a label that goes stale on screen
 * in a document nobody is touching.
 *
 * A value this reader cannot parse is shown verbatim — an unparseable timestamp
 * is the writer's business, and hiding it would be the wrong kind of quiet — and
 * carries no `dateTime`, because a machine-readable attribute that is not a date
 * is a lie a parser will believe.
 */
export function commentTimestamp(createdAt: string): CommentTimestamp {
  const at = Date.parse(createdAt);
  if (Number.isNaN(at)) return { label: createdAt };
  return {
    label: TIMESTAMP_FORMAT.format(at),
    dateTime: new Date(at).toISOString(),
  };
}
