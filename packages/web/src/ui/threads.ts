/**
 * The Threads rail: comment threads as the reader sees them, derived from the
 * open document.
 *
 * Nothing is stored for the rail. A thread is JSON in the `annotations` Y.Map
 * and its range is a `comment` mark on some block's Y.XmlText, so the rail is
 * those two reads joined — which is why a thread another client creates needs no
 * extra plumbing to appear.
 *
 * The join is what makes the orphaned state detectable. A thread is orphaned
 * when its id appears in no block's marks: every annotated character was
 * deleted, so the conversation has no anchor left. The schema package never
 * cascade-deletes the thread (see annotations.ts), and neither does this — an
 * orphaned thread is rendered dimmed, with its text intact, and is the one card
 * that has nothing to scroll to.
 *
 * Marks are looked for in *every* block, not just the one the thread's JSON
 * names, because a block split moves half a marked range into a new block. The
 * first anchor in document order is the one the card quotes.
 */

import type * as Y from "yjs";
import {
  getAnnotationsMap,
  getBlocks,
  getBlocksFragment,
  listAnnotationRanges,
  listAnnotations,
} from "@uberblick/schema";
import type { AnnotationComment, Block, BlockType } from "@uberblick/schema";

/** Longest quoted excerpt a card shows before it is cut short. */
const EXCERPT_MAX = 160;

/** How long a clicked highlight stays flashed, in milliseconds. */
const FLASH_MS = 1200;

const FLASH_CLASS = "ub-comment-flash";

const BLOCK_LABELS: Record<BlockType, string> = {
  paragraph: "Paragraph",
  heading: "Heading",
  code: "Code block",
  mermaid: "Mermaid block",
};

/**
 * A comment plus the key the rail renders it under. A stored comment carries no
 * id — the thread is append-only JSON, and its storage shape is not this
 * change's business — so a comment's identity is its position, and the key is
 * derived here rather than in the view.
 */
export interface ThreadComment extends AnnotationComment {
  key: string;
}

/** One thread's card. */
export interface ThreadView {
  id: string;
  /** The block the thread's JSON names — where the range was made. */
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

interface Anchor {
  blockId: string;
  start: number;
  end: number;
}

/**
 * Where each thread's mark actually sits, from one delta scan per block. The
 * first run in document order wins, so a thread split across two blocks is
 * quoted from its head.
 */
function anchorsByThread(ydoc: Y.Doc, blocks: Block[]): Map<string, Anchor> {
  const found = new Map<string, Anchor>();
  for (const block of blocks) {
    for (const run of listAnnotationRanges(ydoc, block.id)) {
      if (found.has(run.threadId)) continue;
      found.set(run.threadId, {
        blockId: block.id,
        start: run.start,
        end: run.end,
      });
    }
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
  return `${BLOCK_LABELS[block.type]} ${index + 1}`;
}

/**
 * Every thread in the document, in reading order: by the block its range sits
 * in, then by where in that block. Reading order and not thread-id order — a
 * rail sorted by uuid is a rail you cannot follow down the page.
 *
 * An orphan is placed by the block its JSON names, at the head of it: the offset
 * its range used to have is recorded nowhere, and the alternative — dropping
 * orphans to the bottom of the rail — would move a card away from the passage
 * the conversation is about.
 */
export function threadsFromDoc(ydoc: Y.Doc): ThreadView[] {
  const blocks = getBlocks(ydoc);
  const byId = new Map(blocks.map((block) => [block.id, block] as const));
  const order = new Map(blocks.map((block, index) => [block.id, index] as const));
  const anchors = anchorsByThread(ydoc, blocks);

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
 * Two subscriptions, because the rail joins two places: the annotations map
 * (threads arriving, comments appended) and the blocks fragment, observed deeply
 * so a *format* change one level down — a mark being deleted with its text — is
 * seen too. A shallow fragment observer would never notice a thread orphaning.
 */
export function observeThreads(
  ydoc: Y.Doc,
  onChange: (threads: ThreadView[]) => void,
): () => void {
  const fragment = getBlocksFragment(ydoc);
  const annotations = getAnnotationsMap(ydoc);
  const read = (): void => onChange(threadsFromDoc(ydoc));
  read();
  fragment.observeDeep(read);
  annotations.observe(read);
  return () => {
    fragment.unobserveDeep(read);
    annotations.unobserve(read);
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
 * Scroll a thread's highlight into view and flash it. A no-op when the thread is
 * orphaned — there is no anchor to scroll to, which is exactly why the card says
 * which block the range lived in instead.
 */
export function flashThreadHighlight(threadId: string): void {
  const spans = document.querySelectorAll(
    `[data-comment-thread="${CSS.escape(threadId)}"]`,
  );
  const first = spans[0];
  if (first === undefined) return;
  first.scrollIntoView({ behavior: "smooth", block: "center" });
  for (const span of spans) {
    span.classList.add(FLASH_CLASS);
    setTimeout(() => span.classList.remove(FLASH_CLASS), FLASH_MS);
  }
}

/** Scroll a thread's card into view inside the rail. */
export function scrollThreadCardIntoView(threadId: string): void {
  document
    .getElementById(threadCardId(threadId))
    ?.scrollIntoView({ block: "nearest" });
}

/** The reader's own locale: a byline is display data, not document data. */
const RELATIVE_FORMAT = new Intl.RelativeTimeFormat(undefined, {
  numeric: "auto",
});

const RELATIVE_STEPS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ["second", 60],
  ["minute", 60],
  ["hour", 24],
  ["day", 7],
  ["week", 4.348],
  ["month", 12],
  ["year", Number.POSITIVE_INFINITY],
];

/**
 * A comment's age, for the card's byline. Falls back to the stored string when
 * it is not a timestamp this reader understands: an unparseable value is a
 * writer's business, and hiding it would be the wrong kind of quiet.
 */
export function relativeTime(iso: string, now: number = Date.now()): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return iso;
  let value = (at - now) / 1000;
  for (const [unit, span] of RELATIVE_STEPS) {
    if (Math.abs(value) < span) {
      return RELATIVE_FORMAT.format(Math.round(value), unit);
    }
    value /= span;
  }
  return iso;
}
