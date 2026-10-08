/** A block-owned language picker; ProseMirror still owns all source text. */
import { useEffect, useId, useRef, useState } from "react";
import type { ReactElement } from "react";
import { createPortal } from "react-dom";
import type { Editor } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { TextSelection } from "@tiptap/pm/state";
import { yUndoPluginKey } from "y-prosemirror";
import { findBlockById } from "../editor/block-menu.js";
import { retypeBlockInTransaction } from "../editor/retype.js";
import { selectedBlock } from "../editor/source-chrome.js";
import { codeLanguages } from "../editor/syntax-highlighting.js";
import { PickerList } from "./PickerList.js";
import { Popover, PopoverContent, PopoverTrigger } from "./shadcn/popover.js";

const languages = ["", ...codeLanguages.filter((name) => name !== "plaintext").sort()];

interface Target {
  id: string;
  anchor: number;
  head: number;
}

export function CodeLanguageControl({ editor, canWrite }: {
  editor: Editor;
  canWrite: () => boolean;
}): ReactElement | null {
  const [, tick] = useState(0);
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState<Target | null>(null);
  const [query, setQuery] = useState("");
  const search = useRef<HTMLInputElement | null>(null);
  const list = useRef<HTMLDivElement | null>(null);
  const picked = useRef(false);
  const returnToBlock = useRef(false);
  const listId = useId();

  useEffect(() => {
    const read = (): void => tick((value) => value + 1);
    editor.on("transaction", read);
    return () => { editor.off("transaction", read); };
  }, [editor]);

  const caret = selectedBlock(editor.state, "code");
  const id = target?.id ?? caret?.node.attrs.id;
  const found = typeof id === "string" ? findBlockById(editor.state.doc, id) : null;
  const eligible = found?.node.type.name === "code";
  const dom = eligible ? editor.view.nodeDOM(found.pos) : null;
  const caption = dom instanceof HTMLElement ? dom.querySelector(".ub-code-caption") : null;

  useEffect(() => {
    if (!eligible || !editor.isEditable) {
      setOpen(false);
      setTarget(null);
    }
  }, [eligible, editor.isEditable]);

  if (!eligible || caption === null) return null;
  const language = typeof found.node.attrs.language === "string" ? found.node.attrs.language : "";
  const filtered = languages.filter((name) =>
    (name || "Plain text").toLowerCase().includes(query.trim().toLowerCase()),
  );

  const selectionInBlock = (live: NonNullable<ReturnType<typeof findBlockById>>, saved: Target, doc: PMNode): TextSelection => {
    const offset = (value: number): number => live.pos + 1 + Math.max(0, Math.min(live.node.content.size, value));
    return TextSelection.create(doc, offset(saved.anchor), offset(saved.head));
  };

  const choose = (next: string): void => {
    // Focus and the selection can move while a menu is open. Resolve the
    // control's identity again, never the block under the current selection.
    if (target === null || !canWrite() || !editor.isEditable) return;
    const live = findBlockById(editor.state.doc, target.id);
    if (live?.node.type.name !== "code") return;
    const transaction = editor.state.tr;
    const changed = retypeBlockInTransaction(transaction, live.pos, "code", { language: next });
    transaction.setSelection(selectionInBlock(live, target, transaction.doc));
    const undo = yUndoPluginKey.getState(editor.state)?.undoManager;
    if (changed) {
      // A language pick is its own undo gesture, even immediately after typing.
      undo?.stopCapturing();
    }
    editor.view.dispatch(transaction);
    if (changed) undo?.stopCapturing();
    picked.current = true;
    returnToBlock.current = true;
    setOpen(false);
  };

  return createPortal(
    <Popover open={open} onOpenChange={(next) => {
      if (next) {
        if (!canWrite() || !editor.isEditable) return;
        picked.current = false;
        returnToBlock.current = false;
        const selection = editor.state.selection;
        setTarget({ id, anchor: selection.anchor - found.pos - 1, head: selection.head - found.pos - 1 });
        setQuery("");
      }
      setOpen(next);
    }}>
      <PopoverTrigger asChild>
        <button type="button" className="ub-code-language-trigger flex max-w-full min-h-6 cursor-pointer items-center gap-[0.35rem] rounded-(--radius-sm) border-0 bg-transparent px-[0.3rem] py-0 text-muted-foreground [font:inherit] hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2 [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:min-w-11" aria-label="Code language"
          aria-haspopup="listbox" aria-controls={open ? listId : undefined}>
          <span className="overflow-hidden text-ellipsis">{language || "Plain text"}</span><span aria-hidden="true">▾</span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[min(16rem,calc(100vw_-_2rem))]! overflow-hidden p-0!"
        onOpenAutoFocus={(event) => { event.preventDefault(); search.current?.focus(); }}
        onEscapeKeyDown={() => { returnToBlock.current = true; }}
        onCloseAutoFocus={(event) => {
          if (returnToBlock.current) event.preventDefault();
          if (returnToBlock.current && !editor.isDestroyed && target !== null) {
            const live = findBlockById(editor.state.doc, target.id);
            if (live?.node.type.name === "code") {
              if (!picked.current) editor.view.dispatch(editor.state.tr.setSelection(selectionInBlock(live, target, editor.state.doc)));
              editor.view.focus();
            }
          }
          setTarget(null);
          setQuery("");
        }}>
        <form className="border-b border-border p-2" onSubmit={(event) => {
          event.preventDefault();
          if (filtered[0] !== undefined) choose(filtered[0]);
        }}>
          <input ref={search} type="search" role="combobox" aria-label="Search languages"
            aria-autocomplete="list" aria-expanded={open} aria-controls={listId}
            className="w-full rounded-(--radius-sm) border border-input bg-background px-2 py-1 text-foreground [font:inherit] [@media(pointer:coarse)]:text-base"
            placeholder="Search languages" value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
              if (event.key === "ArrowDown") {
                event.preventDefault();
                list.current?.querySelector<HTMLElement>('[role="option"]')?.focus();
              }
            }} />
        </form>
        <PickerList id={listId} label="Code languages" listRef={list}
          options={filtered.map((name) => ({ id: name, label: name || "Plain text", selected: name === language }))}
          onPick={choose} empty="No matching languages." />
      </PopoverContent>
    </Popover>,
    caption,
  );
}
