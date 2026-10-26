import { useEffect, useId, useRef, useState } from "react";
import type { ChangeEvent, KeyboardEvent, ReactElement } from "react";
import { renderMarkdownLink } from "@uberblick/schema";
import type { DocLinkContext } from "../../editor/doc-links.js";
import { mentionCandidates } from "../../mentions.js";
import { CaretMenuList } from "../editor-controls/CaretMenuList.js";
import { useEditorControlsHost } from "../editor-controls/EditorControlsHost.js";
import { Popover, PopoverAnchor, PopoverContent } from "../shadcn/popover.js";
import { Textarea } from "../shadcn/textarea.js";
import { useWorkspaceMembers } from "../workspace-members.js";

interface Session { from: number; prefix: string }

function queryAt(field: HTMLTextAreaElement, session: Session): string | null {
  const { value, selectionStart, selectionEnd } = field;
  if (selectionStart !== selectionEnd || value.slice(0, session.from) !== session.prefix) return null;
  const token = value.slice(session.from, selectionStart);
  return /^@[^\s@]*$/.test(token) ? token.slice(1) : null;
}

export function CommentMentionField({
  text, setText, placeholder, autoFocus, hidden, docLinks, openDocId, onSubmit, onCancel, compact = false, onFocus,
}: {
  text: string;
  setText: (text: string) => void;
  placeholder: string;
  autoFocus: boolean;
  hidden: boolean;
  docLinks: DocLinkContext | null;
  openDocId: string | null;
  onSubmit: () => void;
  onCancel: () => void;
  compact?: boolean;
  onFocus?: (() => void) | undefined;
}): ReactElement {
  const field = useRef<HTMLTextAreaElement | null>(null);
  const members = useWorkspaceMembers();
  const controlsHost = useEditorControlsHost();
  const [session, setSession] = useState<Session | null>(null);
  const [query, setQuery] = useState("");
  const [directoryTick, setDirectoryTick] = useState(0);
  const [highlight, setHighlight] = useState({ list: "", index: 0, keyboard: false });
  const listId = useId();
  const open = session !== null && !hidden;
  useEffect(() => { if (hidden) setSession(null); }, [hidden]);
  useEffect(() => {
    if (!open || docLinks === null) return;
    return docLinks.subscribe(() => setDirectoryTick((tick) => tick + 1));
  }, [open, docLinks]);
  const entries = mentionCandidates(docLinks?.candidates() ?? [], members, query, openDocId);
  const list = `${query}:${directoryTick}:${members.join(",")}`;
  const active = entries.length === 0 ? -1 : Math.min(highlight.list === list ? highlight.index : 0, entries.length - 1);
  const choose = (index: number): void => {
    const input = field.current;
    const entry = entries[index];
    if (input === null || session === null || entry === undefined || input.value !== text || queryAt(input, session) !== query) return;
    const current = mentionCandidates(docLinks?.candidates() ?? [], members, query, openDocId);
    if (!current.some((item) => item.kind === entry.kind && (item.kind === "person"
      ? entry.kind === "person" && item.username === entry.username
      : entry.kind === "document" && item.docId === entry.docId))) return;
    const inserted = entry.kind === "person" ? `@${entry.username}` : renderMarkdownLink(entry.label, entry.docId);
    const caret = session.from + inserted.length + 1;
    const next = `${text.slice(0, session.from)}${inserted} ${text.slice(input.selectionStart)}`;
    setSession(null);
    setText(next);
    // The state update commits after the gesture; selection belongs to that value.
    requestAnimationFrame(() => {
      if (field.current?.value !== next) return;
      field.current.focus();
      field.current.setSelectionRange(caret, caret);
    });
  };
  const change = (event: ChangeEvent<HTMLTextAreaElement>): void => {
    const input = event.currentTarget;
    const native = event.nativeEvent as InputEvent;
    setText(input.value);
    if (session !== null) {
      const nextQuery = queryAt(input, session);
      if (nextQuery === null) setSession(null);
      else setQuery(nextQuery);
      return;
    }
    // Pasting, undoing or deleting stored text must never start a session.
    const from = input.selectionStart - 1;
    if (native.isComposing || native.inputType !== "insertText" || native.data !== "@"
      || input.selectionStart !== input.selectionEnd || input.value[from] !== "@"
      || (from > 0 && !/\s/.test(input.value[from - 1] ?? ""))) return;
    setQuery("");
    setSession({ from, prefix: input.value.slice(0, from) });
  };
  const keyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    // Safari can send the confirming key after compositionend with only its IME keyCode set.
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    if (session !== null && ["ArrowDown", "ArrowUp", "Enter", "Tab", "Escape"].includes(event.key)) {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Escape") setSession(null);
      else if (event.key === "Enter" || event.key === "Tab") choose(active);
      else if (entries.length > 0) setHighlight({ list, index: (active + (event.key === "ArrowDown" ? 1 : -1) + entries.length) % entries.length, keyboard: true });
      return;
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      onSubmit();
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onCancel();
    }
  };
  return <Popover open={open} onOpenChange={(shown) => { if (!shown) setSession(null); }}>
    <PopoverAnchor asChild>
      <Textarea ref={field} className="ub-comment-input resize-y in-[.ub-composer]:max-h-16 in-[.ub-composer]:resize-none"
        rows={compact ? 1 : 2} autoFocus={autoFocus} placeholder={placeholder} value={text}
        data-mention-menu-open={open || undefined}
        aria-haspopup="listbox" aria-controls={open ? listId : undefined}
        aria-activedescendant={open && active >= 0 ? `${listId}-${active}` : undefined}
        onChange={change} onKeyDown={keyDown} onFocus={onFocus}
        onSelect={(event) => {
          if (session !== null && queryAt(event.currentTarget, session) !== query) setSession(null);
        }} />
    </PopoverAnchor>
    <PopoverContent align="start" container={controlsHost?.portalContainer ?? undefined}
      aria-label="People and documents" className="flex w-[17rem] flex-col overflow-hidden rounded-(--radius) bg-card p-[0.3rem] text-card-foreground"
      onOpenAutoFocus={(event) => event.preventDefault()}
      onCloseAutoFocus={(event) => event.preventDefault()}
      onInteractOutside={(event) => { if (event.target === field.current) event.preventDefault(); }}
      onEscapeKeyDown={(event) => {
        // Radix sees Escape in document capture, before the form/composer.
        event.preventDefault();
        event.stopPropagation();
        if (!event.isComposing && event.keyCode !== 229) setSession(null);
      }}>
      <CaretMenuList listId={listId} listKey={list} label="People and documents"
        options={entries.map((entry) => ({ id: entry.kind === "person" ? `person:${entry.username}` : entry.docId,
          label: entry.label, group: entry.kind === "person" ? "People" : "Documents" }))}
        active={active} reveal={highlight.list === list && highlight.keyboard}
        highlightAt={(index) => setHighlight({ list, index, keyboard: false })} choose={choose}
        empty="No person or document matches." />
    </PopoverContent>
  </Popover>;
}
