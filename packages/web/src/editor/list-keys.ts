/**
 * The list's behaviour: its keyboard, and what a run of items is rendered as.
 *
 * The keyboard is Tab and Shift-Tab to change depth, Enter to continue the
 * list, Backspace at the start of an item to leave it. The markers on screen
 * and the list a screen reader hears are both decoration — see
 * {@link listStructurePlugin}.
 *
 * Four bindings, and every one of them is a rule about *one block*, because a
 * list here is a run of adjacent `list-item` blocks rather than a tree (#59).
 * Nothing lifts, sinks or re-parents anything: indenting is an attribute, and
 * continuing a list is a split that keeps the attributes it split from.
 *
 * ## Why plain ProseMirror commands
 *
 * Each binding is a `Command`, so it can be exercised against a real editor
 * state with no keyboard and no DOM — and refusing is a first-class answer. A
 * command that is not about a list item returns false, which is what lets the
 * key fall through to the chain behind it: Enter still splits a paragraph,
 * Backspace still deletes a character, Tab still does whatever the browser does
 * outside a list.
 *
 * The one deliberate exception is Tab *inside* a list at the edge of the range:
 * it returns true having changed nothing, because letting Tab through there
 * would move focus out of the editor mid-list, which is not what a reader
 * pressing it in a list can possibly mean.
 *
 * ## Why the split carries a null id
 *
 * `Transaction.split` copies the node's attributes onto both halves, id
 * included, and duplicate ids break every id-addressed operation in the system.
 * So the new half is given `id: null` and the block-id plugin (block-ids.ts)
 * assigns it a fresh one in the same gesture — the same contract an Enter-split
 * paragraph has always had, stated explicitly rather than relying on the
 * plugin's duplicate repair.
 */

import { Extension } from "@tiptap/core";
import { keymap } from "@tiptap/pm/keymap";
import type { Command, EditorState } from "@tiptap/pm/state";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { MAX_LIST_INDENT, listNumbers } from "@uberblick/schema";
import type { ListMarkerInput } from "@uberblick/schema";
import { renderableIndent } from "./nodes.js";
import { retypeBlockInTransaction } from "./retype.js";

/** The top-level list item the selection head sits in, with its position. */
function listItemAt(
  state: EditorState,
): { pos: number; node: ProseMirrorNode } | null {
  const { $head } = state.selection;
  // Depth 1 is a top-level block; the document has no other depth.
  if ($head.depth !== 1) return null;
  const node = $head.parent;
  if (node.type.name !== "list-item") return null;
  return { pos: $head.before(1), node };
}

/**
 * Move the item under the caret `delta` levels, clamped to the range the model
 * holds. Handled even when it cannot move — see the module comment on Tab.
 */
export function changeListIndent(delta: number): Command {
  return (state, dispatch) => {
    const item = listItemAt(state);
    if (item === null) return false;
    const current = renderableIndent(item.node.attrs.indent);
    const next = Math.min(MAX_LIST_INDENT, Math.max(0, current + delta));
    if (next !== current) {
      dispatch?.(state.tr.setNodeAttribute(item.pos, "indent", String(next)));
    }
    return true;
  };
}

/**
 * Enter inside a list item: a new item below it, same marker, same depth.
 *
 * ProseMirror's own `splitBlock` would hand the second half the document's
 * *default* block type — a paragraph — which is the one thing a reader pressing
 * Enter in a list does not want.
 */
export const splitListItem: Command = (state, dispatch) => {
  const item = listItemAt(state);
  if (item === null) return false;
  if (dispatch === undefined) return true;

  const tr = state.tr;
  if (!state.selection.empty) tr.deleteSelection();
  tr.split(tr.selection.from, 1, [
    { type: item.node.type, attrs: { ...item.node.attrs, id: null } },
  ]);
  dispatch(tr.scrollIntoView());
  return true;
};

/**
 * Backspace at the very start of a list item turns it back into a paragraph —
 * the way out of a list, and the undo of the `- ` that made it one.
 *
 * The re-type goes through the sanctioned path (`setNodeMarkup`, id carried
 * over): the block a reader is leaving keeps every annotation and backlink
 * pointing at it.
 */
export const liftListItem: Command = (state, dispatch) => {
  const item = listItemAt(state);
  if (item === null) return false;
  const { $head, empty } = state.selection;
  if (!empty || $head.parentOffset !== 0) return false;

  const tr = state.tr;
  if (!retypeBlockInTransaction(tr, item.pos, "paragraph")) return false;
  dispatch?.(tr);
  return true;
};

export function listKeymap(): Plugin {
  return keymap({
    Tab: changeListIndent(1),
    "Shift-Tab": changeListIndent(-1),
    Enter: splitListItem,
    Backspace: liftListItem,
  });
}

/* ------------------------------------------------- markers and structure */

/** A top-level block, with the position a decoration is placed at. */
interface DocBlock {
  offset: number;
  node: ProseMirrorNode;
}

/** Where one list item sits, for the eye and for a screen reader alike. */
interface ItemStructure {
  /** The marker an ordered item is drawn with; `null` for a bullet. */
  number: number | null;
  /** Its depth, as ARIA counts depth: the outermost level is 1. */
  level: number;
  /** Its place among the siblings at its own depth, and how many there are. */
  position: number;
  size: number;
}

/**
 * Read the shape of every list in the document off its blocks: `null` for each
 * block that is not a list item, and where the item sits for each one that is.
 *
 * The sets come from the schema package's {@link listNumbers}, called twice.
 * The first call numbers the ordered items; the second, with the two styles
 * swapped, numbers exactly the ones the first left null. Swapping flips the
 * comparison that opens a new set on both sides at once, so the two calls agree
 * about where every set begins — which is what lets the rule stay in the schema
 * package, where the markdown writer reads it, instead of being written a
 * second time here.
 */
function listStructure(
  blocks: readonly ListMarkerInput[],
): Array<ItemStructure | null> {
  const numbers = listNumbers(blocks);
  const swapped = listNumbers(
    blocks.map((block) => ({
      ...block,
      list: block.list === "ordered" ? "bullet" : "ordered",
    })),
  );
  const positions = blocks.map(
    (_block, index) => numbers[index] ?? swapped[index] ?? null,
  );

  // Backwards, so the first item met at a depth is its set's *last* one — and
  // therefore its size. The set is finished once the item numbered 1 is
  // reached, and a shallower item ends every deeper set below it, because a
  // deeper set can only belong to the items that follow it.
  const sizes: Array<number | null> = positions.map(() => null);
  const open = new Map<number, number>();
  for (let index = positions.length - 1; index >= 0; index -= 1) {
    const position = positions[index];
    if (position === null || position === undefined) {
      open.clear();
      continue;
    }
    const depth = blocks[index]?.indent ?? 0;
    for (const level of [...open.keys()]) if (level > depth) open.delete(level);
    const size = open.get(depth) ?? position;
    open.set(depth, size);
    sizes[index] = size;
    if (position === 1) open.delete(depth);
  }

  return positions.map((position, index) => {
    if (position === null) return null;
    return {
      number: numbers[index] ?? null,
      level: (blocks[index]?.indent ?? 0) + 1,
      position,
      size: sizes[index] ?? position,
    };
  });
}

/**
 * The list itself: an empty `<ul>`/`<ol>`, off screen, that claims the run's
 * items with `aria-owns`.
 *
 * There is no element to wrap the items in. They are siblings of every other
 * block and the document has no nesting to build a wrapper from (#59), so the
 * container is *asserted* rather than drawn: `aria-owns` re-parents the items
 * in the accessibility tree only, and on screen nothing moves. It addresses
 * them by the ids already on the `<li>`s — a block id, unique and stable for
 * the life of the block — so the reference cannot drift onto another block. A
 * run holding an item without an id yet gets no container at all: a dangling
 * `aria-owns` reference is worse than none.
 *
 * The tag is the run's own style, which is the one thing ARIA has no word for:
 * a screen reader tells a numbered list from a bulleted one by `ol` vs `ul`.
 *
 * A widget decoration, keyed on the run, so the element is left alone while the
 * run is unchanged and replaced the moment its membership changes.
 */
function listContainer(run: readonly DocBlock[]): Decoration | null {
  const first = run[0];
  if (first === undefined) return null;
  const ids = run
    .map(({ node }) => node.attrs.id)
    .filter((id): id is string => typeof id === "string" && id !== "");
  if (ids.length !== run.length) return null;

  const tag = first.node.attrs.list === "ordered" ? "ol" : "ul";
  const owns = ids.join(" ");
  return Decoration.widget(
    first.offset,
    () => {
      const dom = document.createElement(tag);
      // Spelled out rather than left to the tag, because a list styled without
      // markers — which is exactly how the items are styled — is a list some
      // browsers stop reporting as one.
      dom.setAttribute("role", "list");
      dom.setAttribute("aria-owns", owns);
      dom.className = "ub-sr-only";
      return dom;
    },
    { key: `list-run:${tag}:${owns}`, side: -1 },
  );
}

/** Every decoration the lists in `doc` need, in document order. */
function listDecorations(doc: ProseMirrorNode): Decoration[] {
  const blocks: DocBlock[] = [];
  doc.forEach((node, offset) => {
    blocks.push({ offset, node });
  });
  const structure = listStructure(
    blocks.map(({ node }) => ({
      type: node.type.name,
      list: typeof node.attrs.list === "string" ? node.attrs.list : undefined,
      indent: renderableIndent(node.attrs.indent),
    })),
  );

  const decorations: Decoration[] = [];
  let run: DocBlock[] = [];
  const endRun = (): void => {
    const container = listContainer(run);
    if (container !== null) decorations.push(container);
    run = [];
  };

  for (const [index, block] of blocks.entries()) {
    const item = structure[index];
    if (item === null || item === undefined) {
      endRun();
      continue;
    }
    run.push(block);
    decorations.push(
      Decoration.node(block.offset, block.offset + block.node.nodeSize, {
        role: "listitem",
        "aria-level": String(item.level),
        "aria-posinset": String(item.position),
        "aria-setsize": String(item.size),
        ...(item.number === null ? {} : { "data-number": String(item.number) }),
      }),
    );
  }
  endRun();
  return decorations;
}

/**
 * What a list is, said twice: to the eye as the marker on each item, and to a
 * screen reader as a list that contains them.
 *
 * The marker is `data-number` on an ordered item, which the stylesheet draws.
 * The number comes from the schema package's {@link listNumbers} — the same
 * call the markdown writer makes — so what a reader sees and what an export
 * writes cannot disagree. Doing it in CSS instead was tried and is wrong: a
 * counter can only be reset by a rule matching some block, and no selector can
 * say "a bullet nested *inside* an ordered item", so a nested bullet restarted
 * the enclosing list's numbering while the export carried on counting.
 *
 * The screen reader's half is the same facts as ARIA: `role="listitem"` with
 * `aria-level`, `aria-posinset` and `aria-setsize` on every item, and a list
 * container per run (see {@link listContainer}). Without it a bare `<li>`
 * outside a list is not a list item at all — HTML gives it no role there, and
 * the marker, being generated content, is the only thing left saying otherwise.
 *
 * Decorations, so nothing is written to the document: this is all display, and
 * it is recomputed from the document on every draw — including for a peer's
 * edit or an agent's, which is what keeps a live list numbered, counted and
 * announced correctly.
 */
export function listStructurePlugin(): Plugin {
  return new Plugin({
    props: {
      decorations(state: EditorState): DecorationSet | null {
        const decorations = listDecorations(state.doc);
        return decorations.length === 0
          ? null
          : DecorationSet.create(state.doc, decorations);
      },
    },
  });
}

/** Tiptap wrapper around the list's keyboard and its rendering layer. */
export const ListBlocks = Extension.create({
  name: "uberblickListBlocks",
  addProseMirrorPlugins() {
    return [listKeymap(), listStructurePlugin()];
  },
});
