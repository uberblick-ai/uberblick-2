/**
 * Stable block ids, assigned from the editor side.
 *
 * The schema package assigns an id to every block it creates. The editor
 * creates blocks too — pressing Enter splits a paragraph, and ProseMirror's
 * `split` copies the original node's attributes onto **both** halves. Without
 * this plugin the second half would carry a duplicate id, and duplicate ids
 * break every id-addressed operation in the system (`editBlock`, annotation
 * anchoring, `rev` checks) because `findBlockElement` resolves the first match.
 *
 * So: on every transaction, walk the top-level blocks and assign a fresh UUID
 * to any block whose id is missing or already seen earlier in the document.
 * First occurrence keeps the id; later duplicates get new ones. That makes an
 * Enter-split deterministic — the first half stays the block it was, the second
 * half is a new block.
 *
 * The repair transaction is marked `addToHistory: false`: an id assignment is
 * bookkeeping, not a user edit, and undoing it would leave an id-less block.
 */

import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import type { Transaction } from "@tiptap/pm/state";

export const blockIdPluginKey = new PluginKey("uberblick/block-ids");

export interface BlockIdOptions {
  /** Id source. Injectable so tests can assert exact values. */
  newId: () => string;
}

const defaultNewId = (): string => crypto.randomUUID();

export function blockIdPlugin(options: Partial<BlockIdOptions> = {}): Plugin {
  const newId = options.newId ?? defaultNewId;
  return new Plugin({
    key: blockIdPluginKey,
    appendTransaction(_transactions, _oldState, newState) {
      const seen = new Set<string>();
      let tr: Transaction | null = null;
      newState.doc.forEach((node, offset) => {
        const id = node.attrs.id;
        const usable = typeof id === "string" && id !== "" && !seen.has(id);
        if (usable) {
          seen.add(id as string);
          return;
        }
        const fresh = newId();
        seen.add(fresh);
        tr ??= newState.tr;
        tr.setNodeAttribute(offset, "id", fresh);
      });
      if (tr === null) return null;
      // Not a user edit: keep it out of the undo stack.
      return (tr as Transaction).setMeta("addToHistory", false);
    },
  });
}

/** Tiptap wrapper around {@link blockIdPlugin}. */
export const BlockIds = Extension.create<BlockIdOptions>({
  name: "uberblickBlockIds",
  addOptions() {
    return { newId: defaultNewId };
  },
  addProseMirrorPlugins() {
    return [blockIdPlugin({ newId: this.options.newId })];
  },
});
