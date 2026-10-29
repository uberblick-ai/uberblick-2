import { createContext, useContext } from "react";
import type { Editor } from "@tiptap/core";

export interface EditorControlsHostValue {
  /** Keep editor overlays inside the surrounding modal's interaction boundary. */
  portalContainer: HTMLElement | null;
  /** Floating UI collision boundary; the document editor defaults to its pane. */
  boundary: HTMLElement | null;
}

export const EditorControlsHost = createContext<EditorControlsHostValue | null>(null);

export function useEditorControlsHost(): EditorControlsHostValue | null {
  return useContext(EditorControlsHost);
}

/** Radix captures before ProseMirror, which skips already-prevented key events. */
export function editorControlsOwnEscape(container: HTMLElement | null, event: KeyboardEvent, editor: Editor | null): boolean {
  if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return true;
  if (container?.querySelector('[data-slot="caret-menu-content"]') && editor !== null && !editor.isDestroyed) {
    for (const menu of editor.storage.caretMenuKeys.menus) {
      if (menu.handleKey?.("Escape")) return true;
    }
  }
  const composer = container?.querySelector('[data-slot="selection-composer"]');
  return composer !== null && composer !== undefined && event.composedPath().some((target) =>
    target instanceof Node && (composer.contains(target)
      || (target instanceof HTMLElement && target.classList.contains("ProseMirror"))),
  );
}
