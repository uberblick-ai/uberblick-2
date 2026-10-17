import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { ReactElement, RefObject } from "react";
import type { DirectoryEntry } from "@uberblick/schema";
import { documentSearchRows, rankDocumentSearchRows, useDocumentSearch } from "../shell/document-search-results.js";
import type { DocumentSearchSource } from "../shell/document-search-results.js";
import { PickerList } from "./PickerList.js";
import type { PickerOption } from "./PickerList.js";
import { Dialog, DialogContent, DialogTitle } from "./shadcn/dialog.js";

export function CommandPalette({ entries, searchClient, writable, onSelect, onCreate }: {
  entries: readonly DirectoryEntry[];
  searchClient: DocumentSearchSource;
  writable: boolean;
  onSelect: (uuid: string) => void;
  onCreate: () => void;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const search = useRef<HTMLInputElement | null>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const keydown = (event: KeyboardEvent): void => {
      const apple = /Mac|iPhone|iPad|iPod/.test(navigator.platform);
      if (event.isComposing || event.keyCode === 229 || event.key.toLowerCase() !== "k" ||
        event.altKey || event.shiftKey || (apple ? !event.metaKey || event.ctrlKey : !event.ctrlKey || event.metaKey)) return;
      // Capture before the editor's keymaps so opening never edits the document.
      event.preventDefault();
      event.stopPropagation();
      if (event.repeat) return;
      if (search.current !== null) search.current.focus();
      else {
        returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        setOpen(true);
      }
    };
    document.addEventListener("keydown", keydown, true);
    return () => document.removeEventListener("keydown", keydown, true);
  }, []);

  return <Dialog open={open} onOpenChange={setOpen}>
    <DialogContent aria-describedby={undefined}
      onOpenAutoFocus={(event) => { event.preventDefault(); search.current?.focus(); }}
      onCloseAutoFocus={(event) => {
        event.preventDefault();
        if (returnFocus.current?.isConnected) returnFocus.current.focus();
        returnFocus.current = null;
      }}>
      <DialogTitle className="sr-only">Command palette</DialogTitle>
      {open && <PaletteSearch entries={entries} searchClient={searchClient} writable={writable} searchRef={search}
        onPick={(uuid) => {
          returnFocus.current = null;
          setOpen(false);
          if (uuid === "create") onCreate();
          else onSelect(uuid);
        }} />}
    </DialogContent>
  </Dialog>;
}

function PaletteSearch({ entries, searchClient, writable, searchRef, onPick }: {
  entries: readonly DirectoryEntry[];
  searchClient: DocumentSearchSource;
  writable: boolean;
  searchRef: RefObject<HTMLInputElement | null>;
  onPick: (uuid: string) => void;
}): ReactElement {
  const [query, setQuery] = useState("");
  const text = query.trim();
  const { hits, unavailable, pending } = useDocumentSearch(text, searchClient, entries);
  const rows = useMemo(() => documentSearchRows(entries), [entries]);
  const results = useMemo(() => text === "" || unavailable || pending ? [] : rankDocumentSearchRows(rows, hits), [text, unavailable, pending, rows, hits]);
  const list = useRef<HTMLDivElement | null>(null);
  const listId = useId();
  const options: PickerOption[] = [
    ...results.map((row) => ({ id: row.uuid, label: row.title || "Untitled", detail: row.kind === "decision" ? "Decision" : "Document", selected: false })),
    { id: "create", label: "Create document", selected: false, disabled: !writable },
  ];
  const choose = (uuid: string): void => {
    if (uuid === "create" && !writable) return;
    onPick(uuid);
  };

  return <>
    <div className="border-b border-border p-3">
      <input ref={searchRef} type="search" role="combobox" aria-label="Search documents and decisions"
        aria-autocomplete="list" aria-expanded="true" aria-controls={listId}
        className="w-full box-border rounded-(--radius-sm) border border-input bg-transparent px-3 py-2 text-popover-foreground [font:inherit] [@media(pointer:coarse)]:ub-type-body"
        placeholder="Search documents and decisions" value={query}
        onChange={(event) => setQuery(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            const buttons = list.current?.querySelectorAll<HTMLButtonElement>('[role="option"]:not(:disabled)');
            buttons?.[event.key === "ArrowDown" ? 0 : buttons.length - 1]?.focus();
          } else if (event.key === "Enter") {
            event.preventDefault();
            const first = options.find((option) => !option.disabled);
            if (!pending && first !== undefined) choose(first.id);
          }
        }} />
    </div>
    {(searchClient === null || unavailable) ? <p role="status" className="m-0 px-3 py-2 text-muted-foreground">Search is unavailable.</p>
      : pending ? <p role="status" className="m-0 px-3 py-2 text-muted-foreground">Searching…</p>
        : text !== "" && results.length === 0 && <p role="status" className="m-0 px-3 py-2 text-muted-foreground">No documents or decisions match “{query}”.</p>}
    <PickerList id={listId} label="Documents, decisions and actions" listRef={list} options={options} onPick={choose} empty="" />
  </>;
}
