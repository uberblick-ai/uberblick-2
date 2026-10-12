/** ProseMirror owns key ordering, composition and the iOS Enter replay. */
import { useLayoutEffect, useRef } from "react";
import type { Editor } from "@tiptap/core";

export function useCaretMenuKeys(
  editor: Editor,
  handleKey: ((key: string) => boolean) | null,
  listId: string,
  activeId: string | undefined,
): void {
  const current = useRef({ handleKey, listId, activeId });
  useLayoutEffect(() => {
    Object.assign(current.current, { handleKey, listId, activeId });
    // React's highlight changes view attributes, not document state or history.
    editor.view.updateState(editor.state);
  }, [editor, handleKey, listId, activeId]);

  useLayoutEffect(() => {
    const controller = current.current;
    const { menus } = editor.storage.caretMenuKeys;
    menus.add(controller);
    editor.view.updateState(editor.state);
    return () => {
      menus.delete(controller);
      if (!editor.isDestroyed) editor.view.updateState(editor.state);
    };
  }, [editor]);
}
