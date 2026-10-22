import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactElement, RefObject } from "react";
import type { Editor } from "@tiptap/core";
import type { Transaction } from "@tiptap/pm/state";
import { emojiTriggerAt, isEmojiTyping, opensEmojiSession, pickEmojiAtTrigger } from "../../editor/emoji-menu.js";
import type { EmojiTrigger } from "../../editor/emoji-menu.js";
import { filterEmoji, loadedEmojiData, loadEmojiData } from "../../editor/emoji-data.js";
import type { EmojiEntry } from "../../editor/emoji-data.js";
import { InlineIconText } from "../InlineIconText.js";
import { CaretMenu, useCaretMenuIds } from "./CaretMenu.js";
import { useCaretMenuKeys } from "./caret-menu.js";

export function EmojiMenu({ editor, host }: {
  editor: Editor;
  host: RefObject<HTMLElement | null>;
}): ReactElement | null {
  const [session, setSession] = useState<EmojiTrigger | null>(null);
  const live = useRef<EmojiTrigger | null>(null);
  const [highlight, setHighlight] = useState({ query: "", index: 0, keyboard: false });
  const [, setDataReady] = useState(false);

  useEffect(() => {
    let disposed = false;
    const publish = (trigger: EmojiTrigger | null): void => {
      live.current = trigger;
      setSession(trigger);
    };
    const hasMatches = (trigger: EmojiTrigger): boolean => {
      const data = loadedEmojiData();
      return data === null || !/^[a-z]{2}/i.test(trigger.query) || filterEmoji(data, trigger.query).length > 0;
    };
    const read = ({ transaction }: { transaction: Transaction }): void => {
      const trigger = emojiTriggerAt(editor);
      if (trigger === null || !hasMatches(trigger)) { publish(null); return; }
      const current = live.current;
      if (current === null) {
        if (!opensEmojiSession(transaction, trigger)) return;
        publish(trigger);
        void loadEmojiData().then(() => {
          if (disposed) return;
          setDataReady(true);
          if (live.current !== null && !hasMatches(live.current)) publish(null);
        }).catch(() => { if (!disposed) publish(null); });
        return;
      }
      // Non-typing writes (including paste, undo and peers) cannot carry a pick.
      if (transaction.docChanged && !isEmojiTyping(transaction)) { publish(null); return; }
      const start = transaction.mapping.mapResult(current.from, -1);
      const parent = transaction.mapping.mapResult(current.parentFrom, -1);
      const end = transaction.mapping.mapResult(current.to, 1);
      publish(!start.deleted && !parent.deleted && start.pos === trigger.from
        && parent.pos === trigger.parentFrom && end.pos === trigger.to
        && current.blockId === trigger.blockId ? trigger : null);
    };
    const checkEditable = (): void => { if (!editor.isEditable) publish(null); };
    editor.on("transaction", read);
    editor.on("update", checkEditable);
    return () => {
      disposed = true;
      live.current = null;
      editor.off("transaction", read);
      editor.off("update", checkEditable);
    };
  }, [editor]);

  const data = loadedEmojiData();
  const query = session?.query ?? "";
  const entries = session !== null && /^[a-z]{2}/i.test(query) && data !== null ? filterEmoji(data, query) : [];
  const active = entries.length === 0 ? -1 : Math.min(highlight.query === query ? highlight.index : 0, entries.length - 1);
  const open = session !== null && entries.length > 0;
  const dismiss = useCallback((): void => { live.current = null; setSession(null); }, []);
  const highlightAt = useCallback((index: number, keyboard = false): void => {
    setHighlight({ query, index, keyboard });
  }, [query]);
  const choose = useCallback((entry: EmojiEntry | undefined): void => {
    if (entry === undefined || session === null || live.current !== session) return;
    pickEmojiAtTrigger(editor, session, entry);
    dismiss();
  }, [editor, session, dismiss]);
  const handleKey = useCallback((key: string): boolean => {
    if (session === null || live.current !== session || entries.length === 0) return false;
    if (key === "Escape") { dismiss(); return true; }
    if (key === "ArrowDown" || key === "ArrowUp") {
      highlightAt((active + (key === "ArrowDown" ? 1 : -1) + entries.length) % entries.length, true);
      return true;
    }
    if (key === "Enter" || key === "Tab") { choose(entries[active]); return true; }
    return false;
  }, [session, entries, dismiss, highlightAt, active, choose]);
  const { listId, activeId } = useCaretMenuIds(active);
  useCaretMenuKeys(editor, open ? handleKey : null, listId, activeId);
  return <CaretMenu
    editor={editor} host={host} open={open} onDismiss={dismiss}
    listKey={query} listId={listId} label="Emoji and icons"
    options={entries.map((entry) => ({
      id: entry.id, label: entry.label,
      glyph: <span aria-hidden="true"><InlineIconText text={entry.text} /></span>,
    }))}
    active={active} reveal={highlight.query === query && highlight.keyboard}
    highlightAt={highlightAt} choose={(index) => choose(entries[index])} empty=""
  />;
}
