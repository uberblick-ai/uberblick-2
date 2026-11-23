import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactElement, RefObject } from "react";
import type { Editor } from "@tiptap/core";
import type { Transaction } from "@tiptap/pm/state";
import { addFootnoteAtTrigger, footnoteTriggerAt, opensFootnoteSession } from "../../editor/footnote-menu.js";
import type { FootnoteTrigger } from "../../editor/footnote-menu.js";
import { CaretMenu, useCaretMenuIds } from "./CaretMenu.js";
import { useCaretMenuKeys } from "./caret-menu.js";

export function FootnoteMenu({ editor, host }: {
  editor: Editor;
  host: RefObject<HTMLElement | null>;
}): ReactElement | null {
  const [session, setSession] = useState<FootnoteTrigger | null>(null);
  const live = useRef<FootnoteTrigger | null>(null);
  const dismiss = useCallback((): void => { live.current = null; setSession(null); }, []);
  useEffect(() => {
    if (editor.isDestroyed) return;
    const read = ({ transaction }: { transaction: Transaction }): void => {
      const trigger = footnoteTriggerAt(editor);
      if (trigger === null || !opensFootnoteSession(transaction)) { dismiss(); return; }
      live.current = trigger;
      setSession(trigger);
    };
    const checkEditable = (): void => { if (!editor.isEditable) dismiss(); };
    editor.on("transaction", read);
    editor.on("update", checkEditable);
    return () => {
      live.current = null;
      editor.off("transaction", read);
      editor.off("update", checkEditable);
    };
  }, [editor, dismiss]);
  const choose = useCallback((): void => {
    if (!editor.isDestroyed && session !== null && live.current === session) addFootnoteAtTrigger(editor, session);
    dismiss();
  }, [editor, session, dismiss]);
  const handleKey = useCallback((key: string): boolean => {
    if (session === null || live.current !== session) return false;
    if (key === "Escape") { dismiss(); return true; }
    if (key === "Enter" || key === "Tab") { choose(); return true; }
    return key === "ArrowDown" || key === "ArrowUp";
  }, [session, choose, dismiss]);
  const { listId, activeId } = useCaretMenuIds(0);
  useCaretMenuKeys(editor, session !== null ? handleKey : null, listId, activeId);
  return <CaretMenu editor={editor} host={host} open={session !== null} onDismiss={dismiss}
    listId={listId} listKey="footnote" label="Footnotes"
    options={[{ id: "add-footnote", label: "Add footnote" }]} active={0} reveal={false}
    highlightAt={() => {}} choose={choose} empty="" />;
}
