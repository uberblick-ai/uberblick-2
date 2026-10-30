/**
 * Refuse page-fallback content before binding and synchronously destroy the
 * editor before y-prosemirror observes it. Unsupported blocks use the sync
 * binding's opaque placeholders; stray roots and conflicting links still
 * require a page-level reader and, for links, an explicit repair.
 *
 * Register beforeObserverCalls before editor creation. Shallow fragment.observe
 * misses nested edits, while observeDeep runs too late. Fallback detection must
 * include nested link marks even behind another unsupported shape.
 */

import { normalizeLegacyTables, removeLegacyMermaidBlocks, repairDuplicateBlocks } from "@uberblick/schema";
import type { Editor } from "@tiptap/core";
import type * as Y from "yjs";
import { createUberblickEditor } from "./create-editor.js";
import type { CreateEditorOptions } from "./create-editor.js";
import { hasPageFallback } from "./palette.js";

export interface GuardedBinding {
  /** The editor, or null when the gate refused to bind. */
  editor: Editor | null;
  /** True when binding was refused because the fragment requires page fallback. */
  refused: boolean;
  destroy(): void;
}

interface GuardedBindingOptions extends CreateEditorOptions {
  /** Called when the guard tears the editor down mid-session. */
  onUnbind?: (fragment: Y.XmlFragment) => void;
  /** Only admitted and synchronized replicas may normalize stored blocks. */
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

  if (canNormalize?.() === true) {
    removeLegacyMermaidBlocks(ydoc);
    normalizeLegacyTables(ydoc);
    repairDuplicateBlocks(ydoc);
  }
  if (hasPageFallback(fragment)) {
    return { editor: null, refused: true, destroy: () => {} };
  }

  let instance: Editor | null = null;
  const guard = (transaction: Y.Transaction): void => {
    if (instance === null) return;
    // Concurrent same-id conversions use the schema's document-order winner.
    // Repair before y-prosemirror renders both copies and BlockIds gives the
    // shadow a new identity. Local editor splits retain BlockIds' normal path.
    if (!transaction.local && canNormalize?.() === true) {
      removeLegacyMermaidBlocks(ydoc);
      repairDuplicateBlocks(ydoc);
    }
    if (!hasPageFallback(fragment)) return;
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
