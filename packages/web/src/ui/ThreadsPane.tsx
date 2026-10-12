/**
 * Each card has one body button with phrasing content; actions sit beside it
 * to avoid nested buttons. Quote marks are CSS. Share focus with editor
 * highlights. Keep resolved threads collapsed below the open count. Schema
 * writes recheck the live thread; a refused reply keeps its draft and reason
 * outside the retiring form, and that reason disappears when the thread
 * reopens.
 */

import { useEffect, useRef, useState } from "react";
import type { ReactElement } from "react";
import { addComment, getAnnotation, setAnnotationResolved } from "@uberblick/schema";
import type { AnnotationComment } from "@uberblick/schema";
import type { RoomConnection } from "../collab/rooms.js";
import { writeDocument } from "../collab/directory-stub.js";
import { CommentForm } from "./CommentForm.js";
import {
  commentTimestamp,
  flashThreadHighlight,
  focusThreadCard,
  resolvedHighlightCss,
  scrollThreadCardIntoView,
  threadCardId,
} from "./threads.js";
import type { ThreadFocus, ThreadView } from "./threads.js";
import { Sheet, SheetContent, SheetTitle } from "./shadcn/sheet.js";
import { useTimestampClock } from "./timestamps.js";

function Comment({
  comment,
  now,
}: {
  comment: AnnotationComment;
  now: number;
}): ReactElement {
  const { label, dateTime, title } = commentTimestamp(comment.createdAt, now);
  return (
    <span className="ub-thread-comment flex flex-col">
      <span className="ub-thread-byline flex gap-[0.35rem] text-[0.7rem] text-(--muted-foreground)">
        <span className="ub-thread-author font-medium text-foreground">{comment.author}</span>
        {/* No `dateTime` when the stored value is not a date: React drops the
            attribute, and the label still shows what the document holds. */}
        <time dateTime={dateTime} title={title}>
          {label}
        </time>
      </span>
      <span className="ub-thread-text whitespace-pre-wrap">{comment.text}</span>
    </span>
  );
}

function ThreadCard({
  thread,
  now,
  focused,
  collapsed,
  replying,
  draft,
  readOnly,
  refusal,
  onSelect,
  onReply,
  onReplyOpen,
  onReplyClose,
  onResolve,
}: {
  thread: ThreadView;
  now: number;
  focused: boolean;
  /** Resolved and not expanded: head and excerpt only. */
  collapsed: boolean;
  replying: boolean;
  draft: { text: string; onChange: (text: string) => void };
  /** The conversation is readable, but nothing on the card writes. */
  readOnly: boolean;
  /** Keep the refused-reply reason only while the card reads as settled. */
  refusal: string | null;
  onSelect: () => void;
  onReply: (text: string) => boolean;
  onReplyOpen: () => void;
  onReplyClose: () => void;
  onResolve: (resolved: boolean) => void;
}): ReactElement {
  return (
    <li id={threadCardId(thread.id)} className="ub-thread-card">
      <button
        type="button"
        // Resolved and orphaned cards keep their labels and collapse state;
        // opacity would also dim their enabled text below its contrast floor.
        className={`ub-thread flex w-full cursor-pointer flex-col gap-[0.35rem] rounded-(--radius-sm) border border-l-2 border-(--border) px-[0.6rem] py-2 text-left [font:inherit] hover:border-l-brand ${focused ? "ub-thread-focused border-l-brand bg-(--brand-subtle)" : "bg-card"} text-card-foreground${thread.orphaned ? " ub-thread-orphaned" : ""}${thread.resolved ? " ub-thread-resolved" : ""}`}
        aria-current={focused ? "true" : undefined}
        aria-expanded={thread.resolved ? !collapsed : undefined}
        onClick={onSelect}
      >
        <span className="ub-thread-head flex items-center gap-[0.35rem]">
          {/* The one auto margin keeps both state chips together at the edge. */}
          <span className="ub-thread-ref mr-auto font-(family-name:--font-mono) text-[0.7rem] tracking-[0.02em] text-(--muted-foreground)">{thread.blockRef}</span>
          {thread.orphaned && (
            // The subtle warning fill disappears on a focused amber ground.
            <span className={`ub-chip ub-chip-orphaned rounded-(--radius-sm) px-[0.3rem] text-[0.65rem] tracking-[0.04em] uppercase ${focused ? "bg-(--status-warning) text-(--brand-foreground)" : "bg-(--status-warning-subtle) text-foreground"}`}>
              orphaned
            </span>
          )}
          {thread.resolved && <span className="ub-chip rounded-(--radius-sm) bg-(--card-accent) px-[0.3rem] text-[0.65rem] tracking-[0.04em] text-secondary-foreground uppercase">resolved</span>}
        </span>
        {thread.orphaned ? (
          // The range is gone, so there is nothing to quote. Say so, and say
          // where it was — the conversation itself is right below, untouched.
          <span className="ub-thread-gone text-[0.75rem] text-(--muted-foreground)">
            annotated range deleted from {thread.blockRef}
          </span>
        ) : (
          // Quote marks are chrome; the excerpt itself stays verbatim.
          <span className="ub-thread-excerpt border-l-2 border-(--border) pl-[0.4rem] text-foreground italic before:content-['“'] after:content-['”']">{thread.excerpt}</span>
        )}
        {collapsed ? (
          <span className="ub-thread-replies text-[0.7rem] text-(--muted-foreground)">
            {thread.comments.length}{" "}
            {thread.comments.length === 1 ? "comment" : "comments"} — show
          </span>
        ) : (
          thread.comments.map((comment) => (
            <Comment key={comment.key} comment={comment} now={now} />
          ))
        )}
        {!collapsed && thread.replyCount > 0 && (
          <span className="ub-thread-replies text-[0.7rem] text-(--muted-foreground)">
            {thread.replyCount} {thread.replyCount === 1 ? "reply" : "replies"}
          </span>
        )}
      </button>
      {/*
          * Keep refusal outside the collapsing branch so a concurrent resolve cannot
          * hide it with the form.
       */}
      {refusal !== null && <p className="ub-comment-error">{refusal}</p>}
      {/* Archived conversations remain readable without write controls. */}
      {!collapsed &&
        !readOnly &&
        (replying ? (
          <CommentForm
            placeholder="Reply…"
            submitLabel="Reply"
            draft={draft}
            autoFocus={false}
            onSubmit={onReply}
            onCancel={onReplyClose}
          />
        ) : (
          <div className="ub-thread-actions flex gap-1 pt-[0.3rem] pl-[0.6rem]">
            {!thread.resolved && (
              <button type="button" className="ub-tool" onClick={onReplyOpen}>
                Reply
              </button>
            )}
            <button
              type="button"
              className="ub-tool"
              onClick={() => onResolve(!thread.resolved)}
            >
              {thread.resolved ? "Reopen" : "Resolve"}
            </button>
          </div>
        ))}
    </li>
  );
}

export function ThreadsPane({
  connection,
  threads,
  focused,
  author,
  readOnly = false,
  onFocus,
  narrow = false,
  open = false,
  onOpenChange,
  onCloseAutoFocus,
}: {
  connection: RoomConnection | null;
  /**
   * Share the shell's ordered thread list with the pane-edge count and drawer
   * gate instead of recomputing it in three observers.
   */
  threads: readonly ThreadView[];
  focused: ThreadFocus | null;
  /** The awareness name this client publishes — the author of its replies. */
  author: string;
  /** Archives retain every card while withholding Reply, Resolve and Reopen. */
  readOnly?: boolean;
  onFocus: (threadId: string) => void;
  narrow?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  onCloseAutoFocus?: (event: Event) => void;
}): ReactElement | null {
  const [replyTo, setReplyTo] = useState<string | null>(null);
  // The pane stays mounted when the sheet closes or switches to a column.
  // The modal content can unmount without losing the form or its draft.
  const [replyText, setReplyText] = useState("");
  // Only choosing Reply takes focus. A retained form remounting after closure
  // or a breakpoint crossing is not another request to start writing in it.
  useEffect(() => {
    if (replyTo === null) return;
    document
      .getElementById(threadCardId(replyTo))
      ?.querySelector<HTMLTextAreaElement>(".ub-comment-input")
      ?.focus();
  }, [replyTo]);
  const cancelReply = (): void => {
    setReplyTo(null);
    setReplyText("");
  };
  const now = useTimestampClock();
  /** Only one resolved card may be expanded at a time. */
  const [expanded, setExpanded] = useState<string | null>(null);
  /**
   * Pair the refused reply with its thread and clear it only when the
   * observed document state no longer justifies it.
   */
  const [refusal, setRefusal] = useState<{ id: string; message: string } | null>(
    null,
  );
  const handledSelection = useRef<ThreadFocus | null>(null);

  // Key scrolling on the whole focus value so repeated highlight activation
  // works. Move keyboard focus after commit because selecting may mount the
  // drawer and card.
  useEffect(() => {
    // A resize or a dismissal can rerun this effect, but neither repeats the
    // last highlight's request to move focus out of the prose.
    if (
      focused === null ||
      focused === handledSelection.current ||
      (narrow && !open) ||
      // Creation selects its thread before the coalesced document observer
      // supplies its card. Retain that request until the card can receive it.
      !threads.some((thread) => thread.id === focused.id)
    ) return;
    // The first committed frame still has the collapsed card to focus. Reveal
    // it, then let this effect's second pass scroll and focus the expanded card.
    // A card selection never sets this flag, so its own toggle remains intact.
    if (focused.revealResolved && expanded !== focused.id) {
      setExpanded(focused.id);
      return;
    }
    handledSelection.current = focused;
    scrollThreadCardIntoView(focused.id);
    if (focused.viaKeyboard) focusThreadCard(focused.id);
  }, [focused, expanded, narrow, open, threads]);

  // Clear reply intent when the thread resolves or the document becomes read-
  // only; reopening or restoring must not resurrect a form without another
  // Reply gesture.
  useEffect(() => {
    if (replyTo === null) return;
    if (readOnly) {
      setReplyTo(null);
      return;
    }
    const thread = threads.find((candidate) => candidate.id === replyTo);
    if (thread === undefined || thread.resolved) setReplyTo(null);
  }, [threads, replyTo, readOnly]);

  // Keep refusal only while its thread remains settled. Use the rail first
  // and the live document during the same-task observer lag, so a remote
  // reopen never leaves a stale refusal.
  useEffect(() => {
    if (refusal === null || connection === null) return;
    const settled = threads.some(
      (candidate) => candidate.id === refusal.id && candidate.resolved,
    );
    if (!settled && getAnnotation(connection.ydoc, refusal.id)?.resolved !== true) {
      setRefusal(null);
    }
  }, [threads, refusal, connection]);

  if (connection === null || threads.length === 0) return null;
  const { ydoc } = connection;
  const unresolved = threads.filter((thread) => !thread.resolved);
  const resolved = threads.filter((thread) => thread.resolved);

  const card = (thread: ThreadView): ReactElement => (
    <ThreadCard
      key={thread.id}
      thread={thread}
      now={now}
      focused={thread.id === focused?.id}
      collapsed={thread.resolved && expanded !== thread.id}
      // A resolved thread never shows a retained reply form, even when
      // expanded.
      replying={replyTo === thread.id && !thread.resolved}
      draft={{ text: replyText, onChange: setReplyText }}
      readOnly={readOnly}
      // Suppress settled-thread refusal during the first reopened render,
      // before the clearing effect runs.
      refusal={
        thread.resolved && refusal?.id === thread.id ? refusal.message : null
      }
      onSelect={() => {
        onFocus(thread.id);
        flashThreadHighlight(thread.id);
        // A resolved card is collapsed, so the click that selects it is also
        // the click that opens it — and closes it again.
        if (thread.resolved) {
          setExpanded((current) => (current === thread.id ? null : thread.id));
        }
      }}
      onReplyOpen={() => {
        setReplyText("");
        setReplyTo(thread.id);
      }}
      onReplyClose={cancelReply}
      onReply={(text) => {
        if (!connection.status.writable) return false;
        // Re-read the live thread at submit; a remote resolve or deletion
        // must refuse the reply.
        if (getAnnotation(ydoc, thread.id)?.resolved === true) {
          setRefusal({
            id: thread.id,
            message:
              "This thread was resolved while you wrote — reopen it to reply.",
          });
          return false;
        }
        // addComment performs the final lookup and returns null if the thread
        // disappeared.
        if (writeDocument(ydoc, () => addComment(ydoc, thread.id, author, text)) === null) {
          setRefusal({ id: thread.id, message: "This thread no longer exists." });
          return false;
        }
        setReplyTo(null);
        return true;
      }}
      onResolve={(next) => {
        if (!connection.status.writable) return;
        writeDocument(ydoc, () => setAnnotationResolved(ydoc, thread.id, next));
        setReplyTo((current) => (current === thread.id ? null : current));
        setExpanded(null);
      }}
    />
  );

  const content = (
    <section className="ub-threads" aria-label="Threads">
      {/* Count open threads only; resolved conversations are retained below. */}
      <p className="ub-rail-head mt-0 mr-0 mb-[0.4rem] ml-0 text-[0.7rem] tracking-[0.06em] text-(--muted-foreground) uppercase">
        Threads <span className="ub-muted">{unresolved.length}</span>
      </p>
      <ul className="m-0 flex list-none flex-col gap-2 p-0">{unresolved.map(card)}</ul>
      {resolved.length > 0 && (
        <>
          <p className="ub-rail-head mt-[0.9rem] mr-0 mb-[0.4rem] ml-0 text-[0.7rem] tracking-[0.06em] text-(--muted-foreground) uppercase">
            Resolved <span className="ub-muted">{resolved.length}</span>
          </p>
          <ul className="m-0 flex list-none flex-col gap-2 p-0">{resolved.map(card)}</ul>
        </>
      )}
    </section>
  );
  // The editor's resolved anchors keep their appearance even while the sheet
  // content is unmounted. This derived stylesheet belongs to the stable pane.
  const highlights = resolved.length > 0 ? (
    <style data-resolved-highlights="">
      {resolvedHighlightCss(resolved.map((thread) => thread.id))}
    </style>
  ) : null;
  if (narrow) {
    return (
      <>
        {highlights}
        <Sheet open={open} onOpenChange={(shown) => onOpenChange?.(shown)}>
          <SheetContent
            id="ub-rail"
            className="ub-rail ub-rail-open text-[0.85rem]"
            closeLabel="Close threads"
            aria-describedby={undefined}
            onOpenAutoFocus={(event) => {
              // The portal mounts after the pane's selection effect. Every
              // anchor must reveal its card once it exists, including taps.
              if (focused !== null) scrollThreadCardIntoView(focused.id);
              if (focused?.viaKeyboard) {
                event.preventDefault();
                focusThreadCard(focused.id);
              }
            }}
            onCloseAutoFocus={onCloseAutoFocus}
            onEscapeKeyDown={(event) => {
              // Radix receives Escape in capture, before CommentForm's handler.
              // Cancelling a visible reply is one gesture, leaving the sheet open.
              if (
                event.target instanceof Element &&
                event.target.closest(".ub-comment-form textarea") !== null &&
                !readOnly &&
                threads.some((thread) => thread.id === replyTo && !thread.resolved)
              ) {
                event.preventDefault();
                // Prevent Radix dismissal during composition too, without
                // taking the reply draft away from the input method.
                if (event.isComposing || event.keyCode === 229) return;
                cancelReply();
              }
            }}
          >
            <SheetTitle className="sr-only">Threads</SheetTitle>
            {/* Keep the fixed close target clear of the first unscrolled card. */}
            <div className="min-h-0 flex-1 overflow-y-auto p-3 pt-4 [@media(any-pointer:coarse)]:pt-7">{content}</div>
          </SheetContent>
        </Sheet>
      </>
    );
  }
  return (
    <>
      {highlights}
      <aside
        id="ub-rail"
        className="ub-rail flex w-[var(--outline-width)] flex-none flex-col gap-5 overflow-y-auto border-l border-border p-3 text-[0.85rem] me-[var(--pane-trailing-space)]"
      >
        {content}
      </aside>
    </>
  );
}
