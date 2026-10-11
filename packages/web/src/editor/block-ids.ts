/**
 * Assign missing and duplicate ids in document order: the first occurrence
 * keeps its identity, later copies get fresh UUIDs. Splits copy attributes and
 * would otherwise break id-addressed edits, annotations and revision checks.
 * Keep repair in undo history: addToHistory:false marks the entire Yjs split
 * transaction uncaptured. Idempotent repair can run again after undo.
 */

import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import type { Transaction } from "@tiptap/pm/state";

export const blockIdPluginKey = new PluginKey("uberblick/block-ids");

export interface BlockIdOptions {
  /** Id source. Injectable so tests can assert exact values. */
  newId: () => string;
  /** Whether this replica may repair the shared document right now. */
  canWrite: () => boolean;
}

const defaultNewId = (): string => crypto.randomUUID();
const defaultCanWrite = (): boolean => true;

export function blockIdPlugin(options: Partial<BlockIdOptions> = {}): Plugin {
  const newId = options.newId ?? defaultNewId;
  const canWrite = options.canWrite ?? defaultCanWrite;
  return new Plugin({
    key: blockIdPluginKey,
    appendTransaction(_transactions, _oldState, newState) {
      if (!canWrite()) return null;
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
      return tr;
    },
  });
}

/** Tiptap wrapper around {@link blockIdPlugin}. */
export const BlockIds = Extension.create<BlockIdOptions>({
  name: "uberblickBlockIds",
  addOptions() {
    return { newId: defaultNewId, canWrite: defaultCanWrite };
  },
  addProseMirrorPlugins() {
    return [
      blockIdPlugin({
        newId: this.options.newId,
        canWrite: this.options.canWrite,
      }),
    ];
  },
});
