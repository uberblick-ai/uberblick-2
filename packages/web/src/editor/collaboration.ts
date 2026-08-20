/**
 * The collaboration binding: y-prosemirror plugins over a schema-owned fragment.
 *
 * The fragment is passed in, and it is always `getBlocksFragment(ydoc)` — the
 * `blocks` Y.XmlFragment, **not** the Y.Doc's default fragment. y-prosemirror's
 * examples bind `ydoc.getXmlFragment('prosemirror')`; binding that here would
 * create a fifth root type the schema package knows nothing about, and the
 * document would look empty to every other client.
 *
 * Plugin order matters and is not arbitrary: `yCursorPlugin` and `yUndoPlugin`
 * both read `ySyncPluginKey`'s state, so the sync plugin must come first.
 */

import { Extension } from "@tiptap/core";
import type { Plugin } from "@tiptap/pm/state";
import {
  redo,
  undo,
  yCursorPlugin,
  ySyncPlugin,
  yUndoPlugin,
} from "y-prosemirror";
import type { Awareness } from "y-protocols/awareness";
import type * as Y from "yjs";

export interface CollaborationOptions {
  /** The `blocks` fragment of the document's Y.Doc. */
  fragment: Y.XmlFragment | null;
  /** Provider awareness. `null` disables remote cursors (tests, read-only views). */
  awareness: Awareness | null;
}

export const Collaboration = Extension.create<CollaborationOptions>({
  name: "uberblickCollaboration",

  addOptions() {
    return { fragment: null, awareness: null };
  },

  addProseMirrorPlugins() {
    const { fragment, awareness } = this.options;
    if (fragment === null) return [];
    const plugins: Plugin[] = [ySyncPlugin(fragment) as unknown as Plugin];
    if (awareness !== null) {
      plugins.push(yCursorPlugin(awareness) as unknown as Plugin);
    }
    plugins.push(yUndoPlugin() as unknown as Plugin);
    return plugins;
  },

  addKeyboardShortcuts() {
    // The Yjs UndoManager replaces ProseMirror history entirely: undoing a
    // ProseMirror step would revert remote changes interleaved with local ones.
    return {
      "Mod-z": () => undo(this.editor.state),
      "Mod-y": () => redo(this.editor.state),
      "Shift-Mod-z": () => redo(this.editor.state),
    };
  },
});
