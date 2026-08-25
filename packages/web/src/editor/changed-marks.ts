/**
 * How a changed block looks, and how it stops looking changed.
 *
 * Two halves, both editor-side:
 *
 * - {@link ChangedBlockMarks} draws the accent line, as a ProseMirror node
 *   decoration that adds one class to the block's own element. Nothing is
 *   inserted into the document and nothing is rendered inside a NodeView: the
 *   `code` and `mermaid` blocks own their DOM (see source-chrome.ts), and a
 *   marker built in there would be a second thing to keep in step with every
 *   re-render. A class on the outer element is applied by ProseMirror itself,
 *   for a plain node and a NodeView alike, and the line is drawn by CSS in the
 *   left gutter `--block-gutter` already reserves — so it costs no layout.
 *
 * - {@link clearWhenSeen} is the reading rule: a block that has been fully on
 *   screen for {@link SEEN_MS} has been read, and its mark goes. An
 *   IntersectionObserver answers "on screen" without a scroll handler, and one
 *   timer per block answers "long enough" — leaving the viewport cancels it, so
 *   a block scrolled past at speed keeps its mark.
 *
 * The redraw is the subtle part. Marks appear inside a Yjs transaction, which
 * ProseMirror is already redrawing for, but they *clear* on a timer with no
 * transaction behind them. So the plugin listens to the tracker and dispatches
 * an empty transaction when the set changes. That is safe only because the
 * tracker notifies on a microtask rather than inside the Yjs observer — see the
 * module comment in changed-blocks.ts, which explains what dispatching in there
 * would overwrite.
 */

import { Extension } from "@tiptap/core";
import type { Editor } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import type { EditorState, Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { ChangedBlocks } from "./changed-blocks.js";

/** The class the decoration adds. The accent line itself is CSS. */
export const CHANGED_BLOCK_CLASS = "ub-changed";

/** How long a block must be fully on screen before it counts as read. */
export const SEEN_MS = 2_000;

export const changedBlocksPluginKey = new PluginKey("uberblick/changed-blocks");

export interface ChangedBlockMarkOptions {
  /** The document's tracker, or `null` to draw nothing. */
  marks: ChangedBlocks | null;
}

function markedBlocks(
  state: EditorState,
  marks: ChangedBlocks,
): DecorationSet | null {
  const ids = marks.ids();
  if (ids.size === 0) return null;
  const decorations: Decoration[] = [];
  state.doc.forEach((node, offset) => {
    const id: unknown = node.attrs.id;
    if (typeof id !== "string" || !ids.has(id)) return;
    decorations.push(
      Decoration.node(offset, offset + node.nodeSize, {
        class: CHANGED_BLOCK_CLASS,
      }),
    );
  });
  return DecorationSet.create(state.doc, decorations);
}

export const ChangedBlockMarks = Extension.create<ChangedBlockMarkOptions>({
  name: "uberblickChangedBlocks",

  addOptions() {
    return { marks: null };
  },

  addProseMirrorPlugins() {
    const marks = this.options.marks;
    if (marks === null) return [];
    return [
      new Plugin({
        key: changedBlocksPluginKey,
        props: {
          // Read straight off the tracker rather than mirrored into plugin
          // state: there is one set, and a copy of it could only ever be a
          // second answer to the same question.
          decorations: (state) => markedBlocks(state, marks),
        },
        view: (view) => {
          const redraw = (): void => {
            if (view.isDestroyed) return;
            // An empty transaction: no steps, so nothing reaches the Y.Doc —
            // it exists only to make ProseMirror ask for decorations again.
            view.dispatch(view.state.tr);
          };
          const unsubscribe = marks.subscribe(redraw);
          return { destroy: unsubscribe };
        },
      }),
    ];
  },
});

/**
 * Whether the reader can see the whole block.
 *
 * A block taller than the window can never reach a ratio of 1, and refusing to
 * ever clear its mark would be the wrong answer — filling the viewport is as
 * seen as a block that size gets.
 */
function fullyVisible(entry: IntersectionObserverEntry): boolean {
  if (!entry.isIntersecting) return false;
  if (entry.intersectionRatio >= 1) return true;
  const root = entry.rootBounds;
  return root !== null && entry.intersectionRect.height >= root.height;
}

export interface ClearWhenSeenOptions {
  /** How long "fully on screen" has to last. */
  delayMs?: number;
}

/**
 * Clear a document's marks as its blocks are read. Returns the teardown.
 *
 * Blocks are found by `id`, which every block renders (see nodes.ts) and the
 * outline already navigates by. Watching is re-derived whenever the set changes
 * and whenever the document does — the second matters because ProseMirror
 * replaces a block's element when its markup changes, and an observer left on
 * the old element would never fire again.
 *
 * A browser with no IntersectionObserver gets no clearing rather than a
 * fallback scroll handler: the marks are then simply persistent for the
 * session, which is honest and costs nothing.
 */
export function clearWhenSeen(
  marks: ChangedBlocks,
  editor: Editor,
  options: ClearWhenSeenOptions = {},
): () => void {
  const Observer = globalThis.IntersectionObserver;
  if (Observer === undefined) return () => {};
  const delay = options.delayMs ?? SEEN_MS;

  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const watched = new Map<string, Element>();

  const stopTimer = (id: string): void => {
    const timer = timers.get(id);
    if (timer === undefined) return;
    clearTimeout(timer);
    timers.delete(id);
  };

  const observer = new Observer(
    (entries) => {
      for (const entry of entries) {
        const id = entry.target.id;
        if (id === "" || !marks.has(id)) continue;
        if (!fullyVisible(entry)) {
          // Scrolled past, not read.
          stopTimer(id);
          continue;
        }
        if (timers.has(id)) continue;
        timers.set(
          id,
          setTimeout(() => {
            timers.delete(id);
            marks.clear(id);
          }, delay),
        );
      }
    },
    { threshold: [0, 1] },
  );

  const sync = (): void => {
    const ids = marks.ids();
    if (ids.size === 0 && watched.size === 0) return;
    for (const [id, element] of [...watched]) {
      if (ids.has(id) && element.isConnected) continue;
      observer.unobserve(element);
      watched.delete(id);
      stopTimer(id);
    }
    for (const id of ids) {
      if (watched.has(id)) continue;
      const element = document.getElementById(id);
      if (element === null) continue;
      watched.set(id, element);
      observer.observe(element);
    }
  };

  const onTransaction = ({ transaction }: { transaction: Transaction }): void => {
    if (transaction.docChanged) sync();
  };

  sync();
  const unsubscribe = marks.subscribe(sync);
  editor.on("transaction", onTransaction);

  return () => {
    unsubscribe();
    editor.off("transaction", onTransaction);
    observer.disconnect();
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
    watched.clear();
  };
}
