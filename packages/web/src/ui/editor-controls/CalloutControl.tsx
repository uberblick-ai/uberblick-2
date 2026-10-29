import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { ReactElement } from "react";
import { createPortal } from "react-dom";
import type { Editor } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import { CALLOUT_VARIANTS, isCalloutIcon, isCalloutVariant } from "@uberblick/schema";
import type { Gemoji } from "gemoji";
import { yUndoPluginKey } from "y-prosemirror";
import { findBlockById } from "../../editor/blocks.js";
import { filterEmoji, loadedEmojiData, loadEmojiData } from "../../editor/emoji-data.js";
import { retypeBlockInTransaction } from "../../editor/retype.js";
import { selectedBlock } from "../../editor/source-chrome.js";
import { InlineIconText } from "../InlineIconText.js";
import { PickerList } from "../PickerList.js";
import { Button } from "../shadcn/button.js";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "../shadcn/dropdown-menu.js";
import { Popover, PopoverAnchor, PopoverContent } from "../shadcn/popover.js";
import { useEditorControlsHost } from "./EditorControlsHost.js";

interface SavedSelection {
  anchor: number;
  head: number;
}

function label(variant: string): string {
  return variant.charAt(0).toUpperCase() + variant.slice(1);
}

/** Caption controls own a block identity while focus is outside its prose. */
function CalloutCaption({ editor, id, canWrite, shortcuts }: {
  editor: Editor;
  id: string;
  canWrite: () => boolean;
  shortcuts: Map<string, () => void>;
}): ReactElement | null {
  const [menuOpen, setMenuOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [data, setData] = useState<readonly Gemoji[] | null>(loadedEmojiData);
  const [loadFailed, setLoadFailed] = useState(false);
  const saved = useRef<SavedSelection | null>(null);
  const returnToBlock = useRef(false);
  const changingPicker = useRef(false);
  const search = useRef<HTMLInputElement | null>(null);
  const list = useRef<HTMLDivElement | null>(null);
  const listId = useId();
  const controlsHost = useEditorControlsHost();
  const found = findBlockById(editor.state.doc, id);
  const eligible = !editor.isDestroyed && found?.node.type.name === "callout" && editor.isEditable && canWrite();
  const dom = eligible ? editor.view.nodeDOM(found.pos) : null;
  const caption = dom instanceof HTMLElement ? dom.querySelector(".ub-callout-caption") : null;

  const rememberSelection = useCallback((): void => {
    const live = findBlockById(editor.state.doc, id);
    if (live?.node.type.name !== "callout") return;
    const selection = editor.state.selection;
    saved.current = { anchor: selection.anchor - live.pos - 1, head: selection.head - live.pos - 1 };
    returnToBlock.current = false;
  }, [editor, id]);

  useEffect(() => {
    shortcuts.set(id, () => {
      if (editor.isDestroyed || !editor.isEditable || !canWrite()) return;
      rememberSelection();
      setMenuOpen(true);
    });
    return () => { shortcuts.delete(id); };
  }, [shortcuts, id, editor, canWrite, rememberSelection]);

  useEffect(() => {
    if (!eligible) {
      setMenuOpen(false);
      setPickerOpen(false);
    }
  }, [eligible]);

  useEffect(() => {
    if (!pickerOpen || loadFailed) return;
    let disposed = false;
    void loadEmojiData().then((entries) => {
      if (!disposed) setData(entries);
    }).catch(() => { if (!disposed) setLoadFailed(true); });
    return () => { disposed = true; };
  }, [pickerOpen, loadFailed]);

  if (!eligible || caption === null) return null;
  const variant = isCalloutVariant(found.node.attrs.variant) ? found.node.attrs.variant : "note";
  const entries = data === null ? [] : filterEmoji(data, query.trim()).filter((entry) => isCalloutIcon(entry.text));

  const restoreFocus = (): void => {
    if (editor.isDestroyed) return;
    const live = findBlockById(editor.state.doc, id);
    if (live === null || saved.current === null) return;
    const offset = (value: number): number => live.pos + 1 + Math.max(0, Math.min(live.node.content.size, value));
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc,
      offset(saved.current.anchor), offset(saved.current.head))));
    if (!editor.isDestroyed) editor.view.focus();
  };

  const choose = (choice: { variant: string } | { icon: string | null } | { type: "quote" | "paragraph" }): void => {
    if (editor.isDestroyed || !editor.isEditable || !canWrite()) return;
    const live = findBlockById(editor.state.doc, id);
    if (live?.node.type.name !== "callout") return;
    const tr = editor.state.tr;
    if ("type" in choice) {
      if (!retypeBlockInTransaction(tr, live.pos, choice.type)) return;
    } else if ("variant" in choice) {
      if (!isCalloutVariant(choice.variant)) return;
      retypeBlockInTransaction(tr, live.pos, "callout", { variant: choice.variant });
    } else {
      if (choice.icon !== null && !isCalloutIcon(choice.icon)) return;
      retypeBlockInTransaction(tr, live.pos, "callout", { icon: choice.icon });
    }
    if (saved.current !== null) {
      const offset = (value: number): number => live.pos + 1 + Math.max(0, Math.min(live.node.content.size, value));
      tr.setSelection(TextSelection.create(tr.doc, offset(saved.current.anchor), offset(saved.current.head)));
    }
    const undo = yUndoPluginKey.getState(editor.state)?.undoManager;
    if (tr.docChanged) undo?.stopCapturing();
    editor.view.dispatch(tr);
    if (tr.docChanged) undo?.stopCapturing();
    returnToBlock.current = true;
    setMenuOpen(false);
    setPickerOpen(false);
    if (!editor.isDestroyed) editor.view.focus();
  };

  return createPortal(
    <DropdownMenu open={menuOpen} onOpenChange={(next) => {
      if (next) {
        if (editor.isDestroyed || !editor.isEditable || !canWrite()) return;
        rememberSelection();
      }
      setMenuOpen(next);
    }}>
      <Popover open={pickerOpen} onOpenChange={(next) => {
        if (next && (editor.isDestroyed || !editor.isEditable || !canWrite())) return;
        setPickerOpen(next);
      }}>
        <PopoverAnchor asChild>
          <DropdownMenuTrigger asChild>
            <Button variant="plain" size="custom" type="button" className="ub-callout-trigger pointer-events-auto flex max-w-full items-center gap-[0.35rem] rounded-(--radius-sm) border-0 bg-transparent px-[0.3rem] py-[0.05rem] text-inherit [font:inherit] focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2 [@media(any-pointer:coarse)]:min-w-11"
              aria-label="Callout variant" title="Callout variant · Shift+F10 from the callout" aria-keyshortcuts="Shift+F10">
              {label(variant)}<span aria-hidden="true">▾</span>
            </Button>
          </DropdownMenuTrigger>
        </PopoverAnchor>
        <DropdownMenuContent align="start" aria-label="Callout" container={controlsHost?.portalContainer}
          collisionBoundary={controlsHost?.boundary ?? []}
          onEscapeKeyDown={() => { returnToBlock.current = true; }}
          onCloseAutoFocus={(event) => {
            if (changingPicker.current || returnToBlock.current) event.preventDefault();
            if (changingPicker.current) changingPicker.current = false;
            else if (returnToBlock.current) restoreFocus();
          }}>
          {CALLOUT_VARIANTS.map((name) => <DropdownMenuItem key={name} onSelect={() => choose({ variant: name })}>
            <span aria-hidden="true" className="inline-block w-4">{name === variant ? "✓" : ""}</span>{label(name)}
          </DropdownMenuItem>)}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => {
            changingPicker.current = true;
            setQuery("");
            setLoadFailed(false);
            setMenuOpen(false);
            setPickerOpen(true);
          }}>Change icon…</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => choose({ type: "quote" })}>Quote</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => choose({ type: "paragraph" })}>Paragraph</DropdownMenuItem>
        </DropdownMenuContent>
        <PopoverContent align="start" className="w-[min(18rem,calc(100vw_-_2rem))]! overflow-hidden p-0!"
          container={controlsHost?.portalContainer} collisionBoundary={controlsHost?.boundary ?? []}
          onOpenAutoFocus={(event) => { event.preventDefault(); search.current?.focus(); }}
          onEscapeKeyDown={() => { returnToBlock.current = true; }}
          onCloseAutoFocus={(event) => {
            if (returnToBlock.current) { event.preventDefault(); restoreFocus(); }
          }}>
          <form className="border-b border-border p-2" onSubmit={(event) => {
            event.preventDefault();
            const first = entries[0];
            if (query.trim() !== "" && first !== undefined) choose({ icon: first.text });
          }}>
            <input ref={search} type="search" role="combobox" aria-label="Search icons" aria-autocomplete="list"
              aria-expanded={pickerOpen} aria-controls={listId} placeholder="Search icons"
              className="w-full rounded-(--radius-sm) border border-input bg-background px-2 py-1 text-foreground [font:inherit] [@media(pointer:coarse)]:ub-type-body"
              value={query} onChange={(event) => setQuery(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
                if (event.key === "ArrowDown") {
                  event.preventDefault();
                  list.current?.querySelector<HTMLElement>('[role="option"]')?.focus();
                }
              }} />
          </form>
          {loadFailed ? <div className="p-2"><p>Icons could not be loaded.</p><Button onClick={() => setLoadFailed(false)}>Try again</Button></div> :
            <PickerList id={listId} label="Callout icons" listRef={list}
              options={entries.map((entry) => ({ id: entry.text, label: entry.label, selected: entry.text === found.node.attrs.icon,
                glyph: <InlineIconText text={entry.text} /> }))}
              onPick={(icon) => choose({ icon })} empty={data === null ? "Loading icons…" : "No matching icons."} />}
          <div className="border-t border-border p-1">
            <Button variant="plain" className="w-full justify-start" onClick={() => choose({ icon: null })}>Use default icon</Button>
          </div>
        </PopoverContent>
      </Popover>
    </DropdownMenu>, caption,
  );
}

export function CalloutControl({ editor, canWrite }: { editor: Editor; canWrite: () => boolean }): ReactElement {
  const [, tick] = useState(0);
  const shortcuts = useRef(new Map<string, () => void>());
  useEffect(() => {
    if (editor.isDestroyed) return;
    const dom = editor.view.dom;
    const read = (): void => tick((value) => value + 1);
    const key = (event: KeyboardEvent): void => {
      if (editor.isDestroyed || event.isComposing || event.keyCode === 229 || event.key !== "F10" || !event.shiftKey ||
        event.ctrlKey || event.altKey || event.metaKey || !editor.isEditable || !canWrite()) return;
      const block = selectedBlock(editor.state, "callout");
      if (typeof block?.node.attrs.id !== "string") return;
      event.preventDefault();
      shortcuts.current.get(block.node.attrs.id)?.();
    };
    editor.on("transaction", read);
    editor.on("update", read);
    dom.addEventListener("keydown", key);
    return () => { editor.off("transaction", read); editor.off("update", read); dom.removeEventListener("keydown", key); };
  }, [editor, canWrite]);
  const ids: string[] = [];
  editor.state.doc.forEach((node) => { if (node.type.name === "callout" && typeof node.attrs.id === "string") ids.push(node.attrs.id); });
  return <>{ids.map((id) => <CalloutCaption key={id} editor={editor} id={id} canWrite={canWrite}
    shortcuts={shortcuts.current} />)}</>;
}
