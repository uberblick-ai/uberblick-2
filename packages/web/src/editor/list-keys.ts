/**
 * Lists are flat item blocks: depth is an attribute, not reparenting. Commands
 * must return false outside lists so core keys keep working. At indent limits,
 * Tab is consumed to keep focus in the editor.
 *
 * Splits give the new half id: null for BlockIds to fill; copied duplicate ids
 * would break id-addressed operations. Decorations never write list structure.
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
 * Continue with the same list style/depth; core splitBlock would create a
 * paragraph for the new half.
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
 * At an item's start, retype through setNodeMarkup to preserve its id,
 * annotations and backlinks.
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
 * Use schema listNumbers for both styles, swapping them for the second pass.
 * The passes must agree on set boundaries and match Markdown numbering.
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

  // Walk backward to read each set's size from its last item. Position 1 closes
  // that set; shallower items close all deeper sets.
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

/** One list a screen reader is told about: the items of a single set. */
interface ListSet {
  /** `ol` for a numbered set, `ul` for a bulleted one — every member agrees. */
  tag: "ol" | "ul";
  items: DocBlock[];
}

/**
 * Flat item siblings cannot have a DOM list wrapper. Use one offscreen ul/ol
 * per style/depth set with aria-owns and stable item ids; omit the container if
 * any id is missing. The keyed widget changes only when membership changes.
 */
function listContainer(set: ListSet): Decoration | null {
  const first = set.items[0];
  if (first === undefined) return null;
  const ids = set.items
    .map(({ node }) => node.attrs.id)
    .filter((id): id is string => typeof id === "string" && id !== "");
  if (ids.length !== set.items.length) return null;

  const owns = ids.join(" ");
  const tag = set.tag;
  return Decoration.widget(
    first.offset,
    () => {
      const dom = document.createElement(tag);
      // Some browsers drop list semantics when markers are hidden.
      dom.setAttribute("role", "list");
      dom.setAttribute("aria-owns", owns);
      dom.className = "ub-sr-only";
      return dom;
    },
    { key: `list-set:${tag}:${owns}`, side: -1 },
  );
}

/** Every decoration the lists in `doc` need. */
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
  const sets: ListSet[] = [];
  // Position 1 opens a set; shallower items close deeper sets, and non-items
  // close all sets. Keep this aligned with listStructure numbering.
  const open = new Map<number, ListSet>();

  for (const [index, block] of blocks.entries()) {
    const item = structure[index];
    if (item === null || item === undefined) {
      open.clear();
      continue;
    }
    const depth = item.level - 1;
    for (const level of [...open.keys()]) if (level > depth) open.delete(level);
    let set = item.position === 1 ? undefined : open.get(depth);
    if (set === undefined) {
      set = { tag: item.number === null ? "ul" : "ol", items: [] };
      sets.push(set);
      open.set(depth, set);
    }
    set.items.push(block);

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

  for (const set of sets) {
    const container = listContainer(set);
    if (container !== null) decorations.push(container);
  }
  return decorations;
}

/**
 * Use schema listNumbers for markers and ARIA so live rendering and Markdown
 * export agree. CSS counters cannot distinguish a nested bullet from a new
 * numbered set. Bare li nodes also need explicit listitem roles and per-set
 * containers; recompute decorations for local and remote edits without writes.
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
