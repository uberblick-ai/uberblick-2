/**
 * Binding an editor to a fragment without letting it destroy content.
 *
 * This is the load-time *and* run-time half of the palette gate, in one place,
 * because both halves have to be right for the preservation rule to hold: unknown
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
 * The same trap sits *inside* a known block: a nested Y.XmlElement, or a mark
 * the editor schema does not declare, throws one level down and takes the
 * nested element or the whole Y.XmlText with it. An embed inside a Y.XmlText is
 * the quiet variant — it throws nothing, it simply has no ProseMirror
 * representation, so the next edit rewrites the text without it.
 * `findForeignBlocks` therefore scans recursively (see palette.ts), and this
 * guard is only as good as that scan.
 *
 * ## The two halves
 *
 * **Load time** is easy: check the fragment first, and do not bind when it holds
 * anything foreign.
 *
 * **Run time** is the subtle one. Foreign content arriving from another client is
 * deleted inside the very Yjs transaction cleanup that delivered it, so a React
 * re-render cannot get there first. What does get there first is
 * `beforeObserverCalls`: Yjs emits it on the Y.Doc after the transaction has
 * been applied and *before* any `observe`/`observeDeep` listener runs, and
 * y-prosemirror's binding listens with `observeDeep`. Destroying the editor from
 * that callback unregisters the binding's observer before Yjs ever reaches it,
 * so the content survives.
 *
 * A shallow `fragment.observe` is not enough here and used to be the bug: it
 * never fires for a change one level down (a nested element, a formatting mark),
 * which is exactly where the second half of the hazard lives.
 *
 * The guard is registered *before* the editor is created, and it destroys the
 * editor synchronously inside the callback. Both are load-bearing.
 */

import { normalizeLegacyTables } from "@uberblick/schema";
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
  /** Only admitted and synchronized replicas may convert legacy tables. */
  canNormalize?: () => boolean;
}

export function bindGuardedEditor(
  options: GuardedBindingOptions,
): GuardedBinding {
  const { fragment, onUnbind, canNormalize, ...rest } = options;
  const ydoc = fragment.doc;
  if (ydoc === null) {
    // No Y.Doc, no transactions to guard — and y-prosemirror cannot bind an
    // unintegrated fragment either.
    throw new Error("bindGuardedEditor: the fragment must belong to a Y.Doc");
  }

  if (canNormalize?.() === true) normalizeLegacyTables(ydoc);
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
  // Before the binding, so the teardown can outrun y-prosemirror's observer.
  ydoc.on("beforeObserverCalls", guard);

  instance = createUberblickEditor({ ...rest, fragment });

  return {
    editor: instance,
    refused: false,
    destroy: () => {
      ydoc.off("beforeObserverCalls", guard);
      const doomed = instance;
      instance = null;
      doomed?.destroy();
    },
  };
}
