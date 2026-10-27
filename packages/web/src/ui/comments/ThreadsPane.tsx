/** Drafts belong to conversations, outside the drawer's mount lifetime. */
import { useEffect, useRef, useState } from "react";
import type { ReactElement } from "react";
import { addComment, getAnnotation, getWorkspaceMainRepository, setAnnotationResolved } from "@uberblick/schema";
import type { RoomConnection } from "../../collab/rooms.js";
import type { DocLinkContext } from "../../editor/doc-links.js";
import { writeDocument } from "../../collab/document-write.js";
import { CommentForm } from "./CommentForm.js";
import { CommentText } from "./CommentText.js";
import { CommentByline } from "./CommentByline.js";
import {
  flashThreadHighlight,
  focusThreadCard,
  returnFocusToComment,
  selectedHighlightCss,
  scrollThreadCardIntoView,
  threadCardId,
} from "./threads.js";
import type { ThreadFocus, ThreadView } from "./threads.js";
import { Button } from "../shadcn/button.js";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../shadcn/collapsible.js";
import { Sheet, SheetContent, SheetTitle } from "../shadcn/sheet.js";
import { useTimestampClock } from "../timestamps.js";
import { useWorkspaceSetting } from "../workspace-setting.js";

function ThreadCard({
  thread, now, focused, draft, readOnly, refusal, onSelect, onReply,
  onDeselect, onReplyFocus, onResolve, docLinks, openDocId, hidden, mainRepository,
}: {
  thread: ThreadView;
  now: number;
  focused: boolean;
  draft: { text: string; onChange: (text: string) => void };
  readOnly: boolean;
  refusal: string | null;
  onSelect: () => void;
  onDeselect: () => void;
  onReplyFocus: () => void;
  onReply: (text: string) => boolean;
  onResolve: (resolved: boolean) => void;
  docLinks: DocLinkContext | null;
  openDocId: string | null;
  hidden: boolean;
  mainRepository: string | null;
}): ReactElement {
  const comments = focused ? thread.comments : thread.comments.slice(0, 1);
  const newest = thread.comments.at(-1)?.createdAt ?? "";
  return <li id={threadCardId(thread.id)} className="ub-thread-card">
    <fieldset
      className={`ub-thread${focused ? " ub-thread-focused" : ""}${thread.orphaned ? " ub-thread-orphaned" : ""}${thread.resolved ? " ub-thread-resolved" : ""}`}
      aria-current={focused ? "true" : undefined}
      aria-label="Comment"
      data-expanded={focused}
      onClick={(event) => {
        if (!(event.target instanceof Element && event.target.closest("a, button, textarea, input"))) onSelect();
      }}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
        if (event.key === "Escape" && !event.defaultPrevented) {
          event.preventDefault();
          onDeselect();
        }
      }}>
      {thread.orphaned && <span className="ub-thread-gone ub-type-small text-(--muted-foreground)">on ‘…’ (text removed)</span>}
      {comments.map((comment, index) => <div key={comment.key} className="ub-thread-comment">
        {index === 0 ? <Button variant="plain" size="custom" type="button" className="ub-thread-select text-left"
          aria-label="Comment" aria-expanded={focused} onClick={onSelect}>
          <CommentByline comment={comment} now={now} updatedAt={newest} />
        </Button> : <CommentByline comment={comment} now={now} />}
        <div className="ub-thread-text whitespace-pre-wrap"><CommentText text={comment.text} docLinks={docLinks} mainRepository={mainRepository} /></div>
      </div>)}
      {!focused && thread.replyCount > 0 && <span className="ub-thread-replies ub-type-small text-(--muted-foreground)">
        {thread.replyCount} {thread.replyCount === 1 ? "reply" : "replies"}
      </span>}
      {!readOnly && <Button variant="plain" size="custom" type="button"
        aria-label={thread.resolved ? "Reopen" : "Resolve"}
        className="ub-thread-resolve ub-thread-control" onClick={() => onResolve(!thread.resolved)}>
        {thread.resolved ? "Reopen" : "✓ Resolve"}
      </Button>}
      {refusal !== null && <p className="ub-comment-error">{refusal}</p>}
      {thread.resolved && draft.text !== "" && <div className="ub-thread-unsent ub-type-small">
        <span className="text-(--muted-foreground)">Unsent reply — reopen to continue</span>
        <p className="m-0 whitespace-pre-wrap">{draft.text}</p>
      </div>}
      {!readOnly && !thread.resolved && <div className="ub-thread-control ub-thread-reply">
        <CommentForm compact placeholder="Reply…" submitLabel="Reply" draft={draft}
          autoFocus={false} docLinks={docLinks} openDocId={openDocId} hidden={hidden}
          onSubmit={onReply} onCancel={onDeselect} onFocus={onReplyFocus} />
      </div>}
    </fieldset>
  </li>;
}

export function ThreadsPane({
  connection, catalogConnection = null, canCleanupTags, threads, focused,
  author, account, readOnly = false, onFocus, narrow = false, open = false,
  hidden = false, onOpenChange, onCloseAutoFocus, onDraftsChange, docLinks = null, openDocId = null,
}: {
  connection: RoomConnection | null;
  catalogConnection?: RoomConnection | null;
  canCleanupTags?: (() => boolean) | undefined;
  threads: readonly ThreadView[];
  focused: ThreadFocus | null;
  author: string;
  account?: import("../../shell/account.js").AccountIdentity | undefined;
  readOnly?: boolean;
  onFocus: (threadId: string | null) => void;
  narrow?: boolean;
  open?: boolean;
  hidden?: boolean;
  onOpenChange?: (open: boolean) => void;
  onCloseAutoFocus?: (event: Event) => void;
  onDraftsChange?: (hasDrafts: boolean) => void;
  docLinks?: DocLinkContext | null;
  openDocId?: string | null;
}): ReactElement | null {
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [showResolved, setShowResolved] = useState(false);
  const [refusals, setRefusals] = useState<Record<string, string>>({});
  const handledSelection = useRef<ThreadFocus | null>(null);
  const resolvedToggle = useRef<HTMLButtonElement>(null);
  const focusResolvedToggle = useRef(false);
  const now = useTimestampClock();
  const mainRepository = useWorkspaceSetting(catalogConnection, getWorkspaceMainRepository);
  useEffect(() => {
    if (!focusResolvedToggle.current || !threads.some((thread) => thread.resolved) || resolvedToggle.current === null) return;
    focusResolvedToggle.current = false;
    resolvedToggle.current.focus();
  }, [threads]);
  useEffect(() => {
    onDraftsChange?.(connection !== null && Object.entries(drafts).some(([key, text]) =>
      key.startsWith(`${connection.room}:`) && text !== ""));
  }, [connection, drafts, onDraftsChange]);
  useEffect(() => {
    if (connection === null) return;
    setRefusals((current) => {
      const next = Object.fromEntries(Object.entries(current).filter(([key]) => {
        const thread = threads.find((item) => key === `${connection.room}:${item.id}`);
        return thread === undefined || getAnnotation(connection.ydoc, thread.id)?.resolved !== false;
      }));
      return Object.keys(next).length === Object.keys(current).length ? current : next;
    });
  }, [connection, threads]);
  useEffect(() => {
    if (focused === null || focused === handledSelection.current || (narrow && !open)
      || !threads.some((thread) => thread.id === focused.id)) return;
    if (threads.some((thread) => thread.id === focused.id && thread.resolved) && !showResolved) {
      setShowResolved(true);
      return;
    }
    handledSelection.current = focused;
    scrollThreadCardIntoView(focused.id);
    if (focused.viaKeyboard) focusThreadCard(focused.id);
  }, [focused, showResolved, narrow, open, threads]);

  if (connection === null) return null;
  const { ydoc } = connection;
  const draftKey = (id: string): string => `${connection.room}:${id}`;
  const setDraft = (id: string, text: string): void => {
    setDrafts((current) => ({ ...current, [draftKey(id)]: text }));
  };
  const deselect = (id: string): void => {
    onFocus(null);
    if (narrow) onOpenChange?.(false);
    else returnFocusToComment(id);
  };
  const unresolved = threads.filter((thread) => !thread.resolved);
  const resolved = threads.filter((thread) => thread.resolved);
  const card = (thread: ThreadView): ReactElement => <ThreadCard key={thread.id}
    thread={thread} now={now} focused={thread.id === focused?.id}
    draft={{ text: drafts[draftKey(thread.id)] ?? "", onChange: (text) => setDraft(thread.id, text) }}
    readOnly={readOnly} docLinks={docLinks} openDocId={openDocId} hidden={hidden || (narrow && !open)} mainRepository={mainRepository}
    refusal={thread.resolved ? refusals[draftKey(thread.id)] ?? null : null}
    onSelect={() => { onFocus(thread.id); flashThreadHighlight(thread.id); }}
    onReplyFocus={() => { if (focused?.id !== thread.id) onFocus(thread.id); }}
    onDeselect={() => deselect(thread.id)}
    onReply={(text) => {
      if (readOnly || !connection.status.writable) return false;
      const refuse = (message: string): false => {
        setRefusals((current) => ({ ...current, [draftKey(thread.id)]: message }));
        return false;
      };
      if (getAnnotation(ydoc, thread.id)?.resolved === true) {
        return refuse("This comment was resolved while you wrote — reopen it to reply.");
      }
      if (writeDocument(ydoc, catalogConnection?.ydoc ?? null, () => addComment(ydoc, thread.id, author, text,
        { kind: "person", ...(account?.state === "signed-in"
          ? { account: account.handle, ...(account.principalId === undefined ? {} : { principalId: account.principalId }) }
          : {}) }), undefined, canCleanupTags) === null) {
        return refuse("This comment no longer exists.");
      }
      return true;
    }}
    onResolve={(next) => {
      if (readOnly || !connection.status.writable) return;
      writeDocument(ydoc, catalogConnection?.ydoc ?? null, () => setAnnotationResolved(ydoc, thread.id, next), undefined, canCleanupTags);
      if (next) {
        focusResolvedToggle.current = true;
        setShowResolved(false);
        onFocus(null);
      } else onFocus(thread.id);
    }} />;

  const removedDrafts = Object.entries(drafts).filter(([key, text]) => text !== ""
    && key.startsWith(`${connection.room}:`) && !threads.some((thread) => draftKey(thread.id) === key));
  if (threads.length === 0 && removedDrafts.length === 0) return null;
  const content = <section className="ub-threads" aria-label="Comments">
    <ul className="m-0 flex list-none flex-col gap-2 p-0">{unresolved.map(card)}</ul>
    {resolved.length > 0 && <Collapsible open={showResolved} onOpenChange={(shown) => {
      setShowResolved(shown);
      if (!shown && resolved.some((thread) => thread.id === focused?.id)) onFocus(null);
    }}>
      <CollapsibleTrigger asChild><Button ref={resolvedToggle} variant="plain" size="custom" className="ub-resolved-toggle ub-type-small text-(--muted-foreground)">
        {resolved.length} resolved
      </Button></CollapsibleTrigger>
      <CollapsibleContent><ul className="m-0 flex list-none flex-col gap-2 p-0">{resolved.map(card)}</ul></CollapsibleContent>
    </Collapsible>}
    {removedDrafts.map(([key, text]) => <div key={key} className="ub-thread-unsent">
      <p className="ub-comment-error">This comment no longer exists. Your unsent reply is kept here.</p>
      <p className="whitespace-pre-wrap select-text">{text}</p>
    </div>)}
  </section>;
  const highlights = <style data-selected-highlight="">{selectedHighlightCss(focused?.id ?? null)}</style>;
  if (narrow) return <>
    {highlights}
    <Sheet open={open && !hidden} onOpenChange={(shown) => onOpenChange?.(shown)}>
      <SheetContent id="ub-rail" className="ub-rail ub-rail-open ub-type-ui" closeLabel="Close comments"
        aria-describedby={undefined}
        onOpenAutoFocus={(event) => {
          if (focused !== null) scrollThreadCardIntoView(focused.id);
          if (focused?.viaKeyboard) { event.preventDefault(); focusThreadCard(focused.id); }
        }}
        onCloseAutoFocus={(event) => { if (hidden) event.preventDefault(); else onCloseAutoFocus?.(event); }}
        onEscapeKeyDown={(event) => {
          if (event.isComposing || event.keyCode === 229
            || (event.target instanceof Element && event.target.closest("[data-mention-menu-open=true]"))) {
            event.preventDefault();
          } else onFocus(null);
        }}>
        <SheetTitle className="sr-only">Comments</SheetTitle>
        <div className="min-h-0 flex-1 overflow-y-auto p-3 pt-12 [@media(any-pointer:coarse)]:pt-14">{content}</div>
      </SheetContent>
    </Sheet>
  </>;
  return <>{highlights}<aside id="ub-rail" className="ub-rail flex min-h-0 w-full flex-1 flex-col overflow-y-auto p-3 ub-type-ui">{content}</aside></>;
}
