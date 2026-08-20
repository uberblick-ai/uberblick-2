/**
 * Binding an editor to a fragment without letting it destroy content.
 *
 * This is the load-time *and* run-time half of the palette gate, in one place,
 * because both halves have to be right for the CLAUDE.md rule to hold: unknown
 * blocks degrade loudly, never silently dropped.
 *
 * ## The hazard
 *
 * y-prosemirror's `createNodeFromYElement` builds a ProseMirror node with
 * `schema.node(el.nodeName, …)`. For a node name the editor's schema does not
 * declare that throws, and its catch block deletes the Y.XmlElement from the
 * document. So an unknown block is not merely unrendered — it is destroyed in
 * the CRDT, and the deletion replicates to every peer including the one that
 * wrote it. A ProseMirror schema cannot have a catch-all node type, so there is
 * no in-editor placeholder that would make binding safe.
 *
 * ## The two halves
 *
 * **Load time** is easy: check the fragment first, and do not bind when it holds
 * anything foreign.
 *
 * **Run time** is the subtle one. A foreign block arriving from another client is
 * deleted inside the very Yjs transaction cleanup that delivered it, so a React
 * re-render cannot get there first. What does get there first is a *shallow*
 * observer: Yjs calls `observe` listeners before `observeDeep` listeners, and
 * y-prosemirror binds with `observeDeep`. A shallow observer that tears the
 * editor down synchronously therefore runs before the binding's observer, and
 * the teardown unregisters that observer — so the block survives.
 *
 * The guard is registered *before* the editor is created, and it destroys the
 * editor from inside the observer callback. Both of those are load-bearing.
 */

import type { Editor } from "@tiptap/core";
import type * as Y from "yjs";
import { createUberblickEditor } from "./create-editor.js";
import type { CreateEditorOptions } from "./create-editor.js";
import { findForeignBlocks } from "./palette.js";

export interface GuardedBinding {
  /** The editor, or null when the gate refused to bind. */
  editor: Editor | null;
  /** True when binding was refused because the fragment holds foreign blocks. */
  refused: boolean;
  destroy(): void;
}

export interface GuardedBindingOptions extends CreateEditorOptions {
  /** Called when the guard tears the editor down mid-session. */
  onUnbind?: (fragment: Y.XmlFragment) => void;
}

export function bindGuardedEditor(
  options: GuardedBindingOptions,
): GuardedBinding {
  const { fragment, onUnbind, ...rest } = options;

  if (findForeignBlocks(fragment).length > 0) {
    return { editor: null, refused: true, destroy: () => {} };
  }

  let instance: Editor | null = null;
  const guard = (): void => {
    if (instance === null) return;
    if (findForeignBlocks(fragment).length === 0) return;
    const doomed = instance;
    instance = null;
    doomed.destroy();
    onUnbind?.(fragment);
  };
  // Before the binding, so this shallow observer precedes y-prosemirror's deep one.
  fragment.observe(guard);

  instance = createUberblickEditor({ ...rest, fragment });

  return {
    editor: instance,
    refused: false,
    destroy: () => {
      fragment.unobserve(guard);
      const doomed = instance;
      instance = null;
      doomed?.destroy();
    },
  };
}
