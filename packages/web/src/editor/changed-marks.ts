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
 *   Nothing here is per block type, so the palette's four types (paragraph,
 *   heading, code, mermaid) are covered by the same rule — and a `table` block
 *   would be, by construction, the day the schema grows one (#59).
 *
 * - {@link clearWhenSeen} is the reading rule: a block that has been fully on
 *   screen for {@link SEEN_MS} has been read, and its mark goes. An
 *   IntersectionObserver answers "on screen" without a scroll handler, and one
 *   timer per block answers "long enough" — leaving the viewport cancels it, so
 *   a block scrolled past at speed keeps its mark, and a block changed *again*
 *   while the reader was looking starts the window over.
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
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { ChangedBlocks } from "./changed-blocks.js";

/** The class the decoration adds. The accent line itself is CSS. */
export const CHANGED_BLOCK_CLASS = "ub-changed";

/** How long a block must be fully on screen before it counts as read. */
export const SEEN_MS = 2_000;

export const changedBlocksPluginKey = new PluginKey<MarkedDecorations>(
  "uberblick/changed-blocks",
);

export interface ChangedBlockMarkOptions {
  /** The document's tracker, or `null` to draw nothing. */
  marks: ChangedBlocks | null;
}

/** The drawn set, and the tracker generation it was drawn from. */
interface MarkedDecorations {
  generation: number;
  decorations: DecorationSet;
}

function build(
  doc: ProseMirrorNode,
  marks: ChangedBlocks,
): MarkedDecorations {
  const generation = marks.generation();
  const touched = marks.touched();
  if (touched.size === 0) {
    return { generation, decorations: DecorationSet.empty };
  }
  const decorations: Decoration[] = [];
  doc.forEach((node, offset) => {
    const id: unknown = node.attrs.id;
    if (typeof id !== "string" || !touched.has(id)) return;
    decorations.push(
      Decoration.node(offset, offset + node.nodeSize, {
        class: CHANGED_BLOCK_CLASS,
      }),
    );
  });
  return { generation, decorations: DecorationSet.create(doc, decorations) };
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
      new Plugin<MarkedDecorations>({
        key: changedBlocksPluginKey,
        state: {
          init: (_config, state: EditorState) => build(state.doc, marks),
          // Kept and mapped, not rebuilt: without this the document would be
          // rescanned on every keystroke for as long as anything is marked.
          //
          // Mapping is trusted only while it carries every decoration through
          // intact, and `onRemove` is how it says otherwise. That one callback
          // covers both ways a block decoration stops being drawable, because
          // `DecorationSet.map` re-checks node decorations against the new
          // document (`NodeType.valid`) rather than merely moving them:
          //
          // - the range itself is deleted, which is what a local re-type does —
          //   `setBlockType` replaces the block's markup, so the decoration's
          //   own positions go with it. A re-type keeps the block id and the
          //   block count and never touches the tracker, so nothing else here
          //   could notice the marker had silently gone;
          // - the range survives but no longer covers exactly one block, which
          //   is what splitting or joining a marked block does. A decoration
          //   spanning two blocks matches neither, so it would be drawn on
          //   nothing at all.
          //
          // Either way the answer is the same: rebuild from the tracker, which
          // is the only thing that actually knows what is marked.
          apply: (transaction, previous, _old, next) => {
            if (marks.generation() !== previous.generation) {
              return build(next.doc, marks);
            }
            if (!transaction.docChanged) return previous;
            let dropped = false;
            const decorations = previous.decorations.map(
              transaction.mapping,
              transaction.doc,
              {
                onRemove: () => {
                  dropped = true;
                },
              },
            );
            if (dropped) return build(next.doc, marks);
            return { generation: previous.generation, decorations };
          },
        },
        props: {
          decorations: (state) =>
            changedBlocksPluginKey.getState(state)?.decorations ?? null,
        },
        view: (view) => {
          const redraw = (): void => {
            if (view.isDestroyed) return;
            // An empty transaction: no steps, so nothing reaches the Y.Doc —
            // it exists only to run `apply` above against the new generation.
            view.dispatch(view.state.tr);
          };
          const unsubscribe = marks.subscribe(redraw);
          return {
            destroy: () => {
              unsubscribe();
            },
          };
        },
      }),
    ];
  },
});

/** Slack for sub-pixel layout, in CSS pixels. */
const VIEWPORT_EPSILON_PX = 1;

/**
 * Every hundredth of the way in, rather than just "any" and "all".
 *
 * An IntersectionObserver only calls back when a threshold is crossed, and a
 * block taller than the pane never reaches a ratio of 1 — so with `[0, 1]` the
 * only callback it ever gets is the one where it first touched the pane, at
 * whatever ratio it happened to have then. The "fills the pane" test below
 * would then be asked at the one moment it is guaranteed to be false. A block
 * ten times the height of the pane peaks at a ratio of 0.1, so the steps have
 * to be fine enough to still land inside its whole range.
 */
const VISIBILITY_THRESHOLDS: number[] = Array.from(
  { length: 101 },
  (_unused, step) => step / 100,
);

/**
 * Whether the reader can see the whole block.
 *
 * A block taller than the pane can never reach a ratio of 1, and refusing to
 * ever clear its mark would be the wrong answer — filling the pane is as seen
 * as a block that size gets.
 */
function fullySeen(entry: IntersectionObserverEntry): boolean {
  if (!entry.isIntersecting) return false;
  if (entry.intersectionRatio >= 1) return true;
  const root = entry.rootBounds;
  if (root === null) return false;
  return entry.intersectionRect.height >= root.height - VIEWPORT_EPSILON_PX;
}

/**
 * The box the prose actually scrolls in, or `null` for the window.
 *
 * "On screen" has to mean "inside the box the reader is scrolling", not inside
 * the window: the document scrolls in `.ub-pane`, so a block well below that
 * pane's fold can still be inside the window's rectangle — and would clear its
 * own mark without ever having been visible. Found by walking rather than by
 * class name, so an editor mounted somewhere else gets the same answer.
 */
function scrollRoot(from: Element): Element | null {
  let node = from.parentElement;
  while (
    node !== null &&
    node !== document.body &&
    node !== document.documentElement
  ) {
    const overflow = getComputedStyle(node).overflowY;
    if (overflow === "auto" || overflow === "scroll" || overflow === "overlay") {
      return node;
    }
    node = node.parentElement;
  }
  return null;
}

export interface ClearWhenSeenOptions {
  /** How long "fully on screen" has to last. */
  delayMs?: number;
  /** The scroll container to measure against. Derived from the editor if unset. */
  root?: Element | null;
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
  const root =
    options.root === undefined ? scrollRoot(editor.view.dom) : options.root;

  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  /** The generation each running timer was started for. */
  const armedAt = new Map<string, number>();
  /** What the observer last reported as fully on screen. */
  const onScreen = new Set<string>();
  const watched = new Map<string, Element>();

  const stop = (id: string): void => {
    const timer = timers.get(id);
    if (timer !== undefined) clearTimeout(timer);
    timers.delete(id);
    armedAt.delete(id);
  };

  /** Start this block's read window over, if it is on screen to be read. */
  const arm = (id: string): void => {
    stop(id);
    if (!onScreen.has(id)) return;
    const generation = marks.touched().get(id);
    if (generation === undefined) return;
    armedAt.set(id, generation);
    timers.set(
      id,
      setTimeout(() => {
        timers.delete(id);
        armedAt.delete(id);
        marks.clear(id);
      }, delay),
    );
  };

  const observer = new Observer(
    (entries) => {
      for (const entry of entries) {
        const id = entry.target.id;
        if (id === "") continue;
        if (!fullySeen(entry)) {
          // Scrolled past, or only partly there. Not read.
          onScreen.delete(id);
          stop(id);
          continue;
        }
        // Already counting: a second report of the same visibility must not
        // extend the window, or a block that stays on screen never clears.
        if (onScreen.has(id) && timers.has(id)) continue;
        onScreen.add(id);
        arm(id);
      }
    },
    { root, threshold: VISIBILITY_THRESHOLDS },
  );

  const sync = (): void => {
    const touched = marks.touched();
    if (touched.size === 0 && watched.size === 0) return;
    for (const [id, element] of [...watched]) {
      if (touched.has(id) && element.isConnected) continue;
      observer.unobserve(element);
      watched.delete(id);
      onScreen.delete(id);
      stop(id);
    }
    for (const [id, generation] of touched) {
      if (!watched.has(id)) {
        const element = document.getElementById(id);
        if (element === null) continue;
        watched.set(id, element);
        // `observe` reports the target's current visibility on its own, so a
        // block marked while it is already on screen still starts a window.
        observer.observe(element);
        continue;
      }
      // Changed again since the window started: whatever the reader has been
      // looking at, it is not this, so the window starts over.
      if (armedAt.get(id) !== generation) arm(id);
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
    armedAt.clear();
    onScreen.clear();
    watched.clear();
  };
}
