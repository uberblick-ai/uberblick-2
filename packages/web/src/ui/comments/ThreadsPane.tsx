/** Drafts belong to conversations, outside the drawer's mount lifetime. */
import { useEffect, useRef, useState } from "react";
import type { Dispatch, ReactElement, SetStateAction } from "react";
import { addComment, deleteComment, editComment, getAnnotation, getCommentDeleteEligibility, getWorkspaceMainRepository, setAnnotationResolved } from "@uberblick/schema";
import type { CommentDeleteRefusal } from "@uberblick/schema";
import type { RoomConnection } from "../../collab/rooms.js";
import type { DocLinkContext } from "../../editor/doc-links.js";
import { writeDocument } from "../../collab/document-write.js";
import { CommentForm } from "./CommentForm.js";
import { CommentText } from "./CommentText.js";
import { CommentByline, CommentEdited } from "./CommentByline.js";
import {
  flashThreadHighlight,
  focusThreadCard,
  returnFocusToComment,
  selectedHighlightCss,
  scrollThreadCardIntoView,
  threadCardId,
} from "./threads.js";
import type { ThreadComment, ThreadFocus, ThreadView } from "./threads.js";
import { Button } from "../shadcn/button.js";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogTitle } from "../shadcn/alert-dialog.js";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../shadcn/collapsible.js";
import { Sheet, SheetContent, SheetTitle } from "../shadcn/sheet.js";
import { useTimestampClock } from "../timestamps.js";
import { useWorkspaceSetting } from "../workspace-setting.js";

interface CommentEdit {
  threadId: string;
  commentId: string;
  text: string;
  refusal: string | null;
  autoFocus: boolean;
}

const deleteRefusal: Record<CommentDeleteRefusal, string> = {
  thread_not_found: "This comment no longer exists.",
  comment_not_found: "This comment no longer exists.",
  thread_resolved: "This conversation was resolved. Your comment was not deleted.",
  account_required: "Sign in to delete your comment.",
  comment_account_missing: "This comment was written without an account and cannot be deleted.",
  comment_not_owned: "This comment belongs to a different account.",
  reply_account_missing: "A reply was written without an account, so this conversation cannot be deleted.",
  reply_not_owned: "Someone else replied, so this conversation cannot be deleted.",
};

function removeOwnComment({ connection, catalogConnection, readOnly, account, threadId, commentId, canCleanupTags }: {
  connection: RoomConnection;
  catalogConnection: RoomConnection | null;
  readOnly: boolean;
  account: string | null;
  threadId: string;
  commentId: string;
  canCleanupTags: (() => boolean) | undefined;
}): { ok: true; removed: "comment" | "thread" } | { ok: false; message: string } {
  if (readOnly || !connection.status.writable) return { ok: false, message: "This document is read-only. Your comment was not deleted." };
  const result = writeDocument(connection.ydoc, catalogConnection?.ydoc ?? null,
    () => deleteComment(connection.ydoc, threadId, commentId, account ?? undefined), undefined, canCleanupTags);
  return result.ok ? result : { ok: false, message: deleteRefusal[result.reason] };
}

function DeleteConfirmation({ open, replyCount, narrow, onClose, onDelete }: {
  open: boolean;
  replyCount: number;
  narrow: boolean;
  onClose: () => void;
  onDelete: () => string | null;
}): ReactElement {
  const deleted = useRef<string | null>(null);
  return <AlertDialog open={open} onOpenChange={(shown) => { if (!shown) onClose(); }}>
    <AlertDialogContent onCloseAutoFocus={(event) => {
      if (deleted.current === null) return;
      event.preventDefault();
      const toggle = narrow ? document.querySelector<HTMLElement>(".ub-threads-toggle") : null;
      if (toggle !== null) toggle.focus();
      else returnFocusToComment(deleted.current);
      deleted.current = null;
    }}>
      <AlertDialogTitle>Delete this conversation?</AlertDialogTitle>
      <AlertDialogDescription>
        This permanently deletes the opening comment and {replyCount} {replyCount === 1 ? "reply" : "replies"}. This cannot be undone.
      </AlertDialogDescription>
      <AlertDialogFooter>
        <AlertDialogCancel>Cancel</AlertDialogCancel>
        <AlertDialogAction variant="destructive" onClick={() => { deleted.current = onDelete(); }}>Delete</AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>;
}

function useRecoveredCommentRefusals(connection: RoomConnection | null, threads: readonly ThreadView[],
  setRefusals: Dispatch<SetStateAction<Record<string, string>>>, setEdits: Dispatch<SetStateAction<Record<string, CommentEdit>>>): void {
  useEffect(() => {
    if (connection === null) return;
    setRefusals((current) => {
      const next = Object.fromEntries(Object.entries(current).filter(([key]) => {
        const thread = threads.find((item) => key === `${connection.room}:${item.id}`);
        return thread === undefined || getAnnotation(connection.ydoc, thread.id)?.resolved !== false;
      }));
      return Object.keys(next).length === Object.keys(current).length ? current : next;
    });
    setEdits((current) => {
      let changed = false;
      const next = { ...current };
      for (const [key, edit] of Object.entries(current)) {
        const thread = threads.find((item) => key.startsWith(`${connection.room}:`) && item.id === edit.threadId);
        if (edit.refusal !== null && thread !== undefined && !thread.resolved
          && thread.comments.some((comment) => comment.key === edit.commentId)) {
          next[key] = { ...edit, refusal: null };
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [connection, threads, setRefusals, setEdits]);
}

function ThreadCard({
  thread, now, focused, draft, readOnly, refusal, onSelect, onReply,
  onDeselect, onReplyFocus, onResolve, docLinks, openDocId, hidden, mainRepository,
  account, edits, onStartEdit, onEditText, onEditFocus, onSaveEdit, onCancelEdit,
  canDelete, onDelete, deletionRefusal,
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
  account: string | null;
  edits: CommentEdit[];
  onStartEdit: (comment: ThreadComment) => void;
  onEditText: (commentId: string, text: string) => void;
  onEditFocus: (commentId: string) => void;
  onSaveEdit: (commentId: string, text: string) => boolean;
  onCancelEdit: (commentId: string) => void;
  canDelete: (commentId: string) => boolean;
  onDelete: (commentId: string) => void;
  deletionRefusal: string | null;
}): ReactElement {
  const comments = focused ? thread.comments : thread.comments.slice(0, 1);
  const newest = thread.comments.flatMap((comment) => [comment.createdAt, comment.editedAt])
    .reduce<string>((latest, value) => value !== undefined && Number.isFinite(Date.parse(value))
      && (!Number.isFinite(Date.parse(latest)) || Date.parse(value) > Date.parse(latest)) ? value : latest,
    thread.comments.at(-1)?.createdAt ?? "");
  const canEdit = (comment: ThreadComment): boolean => focused && !readOnly && !thread.resolved
    && account !== null && comment.account?.toLowerCase() === account.toLowerCase();
  const strandedEdits = edits.filter((edit) => !thread.comments.some((comment) => comment.key === edit.commentId && canEdit(comment)));
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
          const editing = event.target instanceof Element ? event.target.closest(".ub-comment-editing") : null;
          const commentId = editing?.closest("[data-comment-id]")?.getAttribute("data-comment-id");
          if (commentId != null) onCancelEdit(commentId);
          else onDeselect();
        }
      }}>
      {thread.orphaned && <span className="ub-thread-gone ub-type-small text-(--muted-foreground)">on ‘…’ (text removed)</span>}
      {comments.map((comment, index) => {
        const edit = edits.find((item) => item.commentId === comment.key);
        return <div key={comment.key} className="ub-thread-comment" data-comment-id={comment.key}>
        {index === 0 ? <Button variant="plain" size="custom" type="button" className="ub-thread-select text-left"
          aria-label="Comment" aria-expanded={focused} onClick={onSelect}>
          <CommentByline comment={comment} now={now} updatedAt={newest} />
        </Button> : <CommentByline comment={comment} now={now} />}
        {edit !== undefined && canEdit(comment)
          ? <div className="ub-comment-editing">
            <CommentForm compact showCancel placeholder="Edit comment…" submitLabel="Save"
              draft={{ text: edit.text, onChange: (text) => onEditText(comment.key, text) }}
              autoFocus={edit.autoFocus} onFocus={() => onEditFocus(comment.key)}
              docLinks={docLinks} openDocId={openDocId} hidden={hidden} error={edit.refusal}
              onSubmit={(text) => onSaveEdit(comment.key, text)} onCancel={() => onCancelEdit(comment.key)} />
          </div>
          : <>
            <div className="ub-thread-text whitespace-pre-wrap"><CommentText text={comment.text} docLinks={docLinks} mainRepository={mainRepository} />
              {comment.editedAt !== undefined && <> <CommentEdited editedAt={comment.editedAt} now={now} /></>}
            </div>
            {canEdit(comment) && <div className="flex justify-end gap-1">
              <Button variant="plain" size="custom" type="button" className="ub-comment-action ub-comment-edit ub-type-small text-(--muted-foreground)"
                onClick={() => onStartEdit(comment)}>Edit</Button>
              {canDelete(comment.key) && <Button variant="plain" size="custom" type="button" className="ub-comment-action ub-comment-delete ub-type-small text-(--muted-foreground)"
                onClick={() => onDelete(comment.key)}>Delete</Button>}
            </div>}
          </>}
      </div>;
      })}
      {focused && strandedEdits.map((edit) => <div key={edit.commentId} className="ub-thread-unsent ub-type-small">
        <p className={edit.refusal !== null ? "ub-comment-error" : "text-(--muted-foreground)"}>
          {edit.refusal ?? (!thread.comments.some((comment) => comment.key === edit.commentId)
            ? "This comment no longer exists. Your unsent edit is kept here."
            : thread.resolved ? "Unsent edit — reopen to continue" : "Your unsent edit is kept here.")}
        </p>
        <p className="m-0 whitespace-pre-wrap select-text">{edit.text}</p>
        <Button variant="tool" size="custom" onClick={() => onCancelEdit(edit.commentId)}>Cancel</Button>
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
      {deletionRefusal !== null && <p className="ub-comment-error" role="alert">{deletionRefusal}</p>}
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
  const [edits, setEdits] = useState<Record<string, CommentEdit>>({});
  const [showResolved, setShowResolved] = useState(false);
  const [refusals, setRefusals] = useState<Record<string, string>>({});
  const [deleteRefusals, setDeleteRefusals] = useState<Record<string, string>>({});
  const [pendingDelete, setPendingDelete] = useState<{ room: string; threadId: string; commentId: string; replyCount: number } | null>(null);
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
    onDraftsChange?.(connection !== null && (Object.entries(drafts).some(([key, text]) =>
      key.startsWith(`${connection.room}:`) && text !== "")
      || Object.keys(edits).some((key) => key.startsWith(`${connection.room}:`))));
  }, [connection, drafts, edits, onDraftsChange]);
  useRecoveredCommentRefusals(connection, threads, setRefusals, setEdits);
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
  const editKey = (threadId: string, commentId: string): string => `${draftKey(threadId)}:${commentId}`;
  const cancelEdit = (threadId: string, commentId: string): void => {
    setEdits((current) => {
      const next = { ...current };
      delete next[editKey(threadId, commentId)];
      return next;
    });
    requestAnimationFrame(() => {
      document.getElementById(threadCardId(threadId))
        ?.querySelector<HTMLButtonElement>(`[data-comment-id="${CSS.escape(commentId)}"] .ub-comment-edit`)?.focus();
    });
  };
  const updateEdit = (threadId: string, commentId: string, patch: Partial<CommentEdit>): void => {
    const key = editKey(threadId, commentId);
    setEdits((current) => {
      const existing = current[key];
      return existing === undefined ? current : { ...current, [key]: { ...existing, ...patch } };
    });
  };
  const roomEdits = Object.entries(edits).filter(([key]) => key.startsWith(`${connection.room}:`));
  const ownAccount = account?.state === "signed-in" ? account.handle : null;
  const deselect = (id: string): void => {
    onFocus(null);
    if (narrow) onOpenChange?.(false);
    else returnFocusToComment(id);
  };
  const removeComment = (threadId: string, commentId: string): boolean => {
    const result = removeOwnComment({ connection, catalogConnection, readOnly, account: ownAccount, threadId, commentId, canCleanupTags });
    if (!result.ok) {
      setDeleteRefusals((current) => ({ ...current, [draftKey(threadId)]: result.message }));
      return false;
    }
    setDeleteRefusals((current) => {
      const next = { ...current };
      delete next[draftKey(threadId)];
      return next;
    });
    if (result.removed === "thread") deselect(threadId);
    else requestAnimationFrame(() => focusThreadCard(threadId));
    return true;
  };
  const unresolved = threads.filter((thread) => !thread.resolved);
  const resolved = threads.filter((thread) => thread.resolved);
  const card = (thread: ThreadView): ReactElement => <ThreadCard key={thread.id}
    thread={thread} now={now} focused={thread.id === focused?.id}
    draft={{ text: drafts[draftKey(thread.id)] ?? "", onChange: (text) => setDrafts((current) => ({ ...current, [draftKey(thread.id)]: text })) }}
    readOnly={readOnly || !connection.status.writable} docLinks={docLinks} openDocId={openDocId} hidden={hidden || (narrow && !open)} mainRepository={mainRepository}
    account={ownAccount} edits={roomEdits.map(([, edit]) => edit).filter((edit) => edit.threadId === thread.id)}
    onStartEdit={(comment) => setEdits((current) => ({ ...current, [editKey(thread.id, comment.key)]: {
      threadId: thread.id, commentId: comment.key, text: comment.text, refusal: null, autoFocus: true,
    } }))}
    onEditText={(commentId, text) => updateEdit(thread.id, commentId, { text })}
    onEditFocus={(commentId) => updateEdit(thread.id, commentId, { autoFocus: false })}
    onCancelEdit={(commentId) => cancelEdit(thread.id, commentId)}
    canDelete={(commentId) => getCommentDeleteEligibility(ydoc, thread.id, commentId, ownAccount ?? undefined).ok}
    deletionRefusal={deleteRefusals[draftKey(thread.id)] ?? null}
    onDelete={(commentId) => {
      const eligible = getCommentDeleteEligibility(ydoc, thread.id, commentId, ownAccount ?? undefined);
      if (eligible.ok && eligible.removed === "thread" && eligible.replyCount > 0) {
        setPendingDelete({ room: connection.room, threadId: thread.id, commentId, replyCount: eligible.replyCount });
      } else removeComment(thread.id, commentId);
    }}
    onSaveEdit={(commentId, text) => {
      if (readOnly || !connection.status.writable || ownAccount === null) return false;
      const refuse = (message: string): false => {
        updateEdit(thread.id, commentId, { refusal: message });
        return false;
      };
      if (getAnnotation(ydoc, thread.id)?.resolved === true) {
        return refuse("This comment was resolved while you wrote — reopen it to edit.");
      }
      if (writeDocument(ydoc, catalogConnection?.ydoc ?? null,
        () => editComment(ydoc, thread.id, commentId, ownAccount, text), undefined, canCleanupTags) === null) {
        return refuse("This comment no longer exists or belongs to a different account. Your unsent edit is kept here.");
      }
      cancelEdit(thread.id, commentId);
      return true;
    }}
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
  const removedEdits = roomEdits.filter(([, edit]) => !threads.some((thread) => thread.id === edit.threadId));
  const removedRefusals = Object.entries(deleteRefusals).filter(([key]) => key.startsWith(`${connection.room}:`)
    && !threads.some((thread) => draftKey(thread.id) === key));
  if (threads.length === 0 && removedDrafts.length === 0 && removedEdits.length === 0 && removedRefusals.length === 0 && pendingDelete === null) return null;
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
    {removedEdits.map(([key, edit]) => <div key={key} className="ub-thread-unsent">
      <p className="ub-comment-error">This comment no longer exists. Your unsent edit is kept here.</p>
      <p className="whitespace-pre-wrap select-text">{edit.text}</p>
      <Button variant="tool" size="custom" onClick={() => cancelEdit(edit.threadId, edit.commentId)}>Cancel</Button>
    </div>)}
    {removedRefusals.map(([key, message]) => <p key={key} className="ub-comment-error" role="alert">{message}</p>)}
  </section>;
  const highlights = <style data-selected-highlight="">{selectedHighlightCss(focused?.id ?? null)}</style>;
  const pendingReplyCount = threads.find((thread) => thread.id === pendingDelete?.threadId)?.replyCount ?? pendingDelete?.replyCount ?? 0;
  const confirmation = <DeleteConfirmation open={pendingDelete !== null && pendingDelete.room === connection.room && !hidden}
    narrow={narrow} replyCount={pendingReplyCount} onClose={() => setPendingDelete(null)}
    onDelete={() => pendingDelete !== null && removeComment(pendingDelete.threadId, pendingDelete.commentId) ? pendingDelete.threadId : null} />;
  if (narrow) return <>
    {highlights}
    {confirmation}
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
          } else {
            const editing = event.target instanceof Element ? event.target.closest(".ub-comment-editing") : null;
            const commentId = editing?.closest("[data-comment-id]")?.getAttribute("data-comment-id");
            const edit = roomEdits.find(([, item]) => item.commentId === commentId)?.[1];
            if (edit !== undefined) {
              event.preventDefault();
              event.stopPropagation();
              cancelEdit(edit.threadId, edit.commentId);
            } else onFocus(null);
          }
        }}>
        <SheetTitle className="sr-only">Comments</SheetTitle>
        <div className="min-h-0 flex-1 overflow-y-auto p-3 pt-12 [@media(any-pointer:coarse)]:pt-14">{content}</div>
      </SheetContent>
    </Sheet>
  </>;
  return <>{highlights}{confirmation}<aside id="ub-rail" className="ub-rail flex min-h-0 w-full flex-1 flex-col overflow-y-auto p-3 ub-type-ui">{content}</aside></>;
}
