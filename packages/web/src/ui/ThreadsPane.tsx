/**
 * The Threads rail: every comment thread in the open document, and the two
 * things a reader can do about one — reply to it, or resolve it.
 *
 * A card's body is one `<button>` and nothing but phrasing content inside it —
 * a blockquote or a paragraph there would be invalid inside a button, and one
 * button per card keeps the rail a single tab stop per thread with Enter
 * activating it. The actions sit *beside* that button rather than inside it,
 * because a button may not contain a button. The quote marks around the excerpt
 * are CSS, not text.
 *
 * Clicking a card flashes the highlight in the prose; clicking a highlight
 * focuses the card. Both directions are the same `ThreadFocus`, held by the app
 * shell, because the two ends live in different panes.
 *
 * Resolved threads leave the count and move below it, collapsed and dimmed.
 * They are never dropped: a conversation someone has already had is the reason
 * the text reads the way it does now.
 *
 * Both writes go through the schema package's annotation API — `addComment` and
 * `setAnnotationResolved` — in one transaction each, so a reply and a resolve
 * reach a second client exactly the way an agent's do.
 */

import { useEffect, useState } from "react";
import type { ReactElement } from "react";
import { addComment, setAnnotationResolved } from "@uberblick/schema";
import type { AnnotationComment } from "@uberblick/schema";
import type { RoomConnection } from "../collab/rooms.js";
import { useThreads } from "./hooks.js";
import { CommentForm } from "./CommentForm.js";
import {
  commentTimestamp,
  flashThreadHighlight,
  resolvedHighlightCss,
  scrollThreadCardIntoView,
  threadCardId,
} from "./threads.js";
import type { ThreadFocus, ThreadView } from "./threads.js";

function Comment({ comment }: { comment: AnnotationComment }): ReactElement {
  const { label, dateTime } = commentTimestamp(comment.createdAt);
  return (
    <span className="ub-thread-comment">
      <span className="ub-thread-byline">
        <span className="ub-thread-author">{comment.author}</span>
        {/* No `dateTime` when the stored value is not a date: React drops the
            attribute, and the label still shows what the document holds. */}
        <time dateTime={dateTime}>{label}</time>
      </span>
      <span className="ub-thread-text">{comment.text}</span>
    </span>
  );
}

function ThreadCard({
  thread,
  focused,
  collapsed,
  replying,
  onSelect,
  onReply,
  onReplyOpen,
  onReplyClose,
  onResolve,
}: {
  thread: ThreadView;
  focused: boolean;
  /** Resolved and not expanded: head and excerpt only. */
  collapsed: boolean;
  replying: boolean;
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
        className={`ub-thread${focused ? " ub-thread-focused" : ""}${thread.orphaned ? " ub-thread-orphaned" : ""}${thread.resolved ? " ub-thread-resolved" : ""}`}
        aria-current={focused ? "true" : undefined}
        aria-expanded={thread.resolved ? !collapsed : undefined}
        onClick={onSelect}
      >
        <span className="ub-thread-head">
          <span className="ub-thread-ref">{thread.blockRef}</span>
          {thread.orphaned && <span className="ub-chip ub-chip-orphaned">orphaned</span>}
          {thread.resolved && <span className="ub-chip">resolved</span>}
        </span>
        {thread.orphaned ? (
          // The range is gone, so there is nothing to quote. Say so, and say
          // where it was — the conversation itself is right below, untouched.
          <span className="ub-thread-gone">
            annotated range deleted from {thread.blockRef}
          </span>
        ) : (
          <span className="ub-thread-excerpt">{thread.excerpt}</span>
        )}
        {collapsed ? (
          <span className="ub-thread-replies">
            {thread.comments.length}{" "}
            {thread.comments.length === 1 ? "comment" : "comments"} — show
          </span>
        ) : (
          thread.comments.map((comment) => (
            <Comment key={comment.key} comment={comment} />
          ))
        )}
        {!collapsed && thread.replyCount > 0 && (
          <span className="ub-thread-replies">
            {thread.replyCount} {thread.replyCount === 1 ? "reply" : "replies"}
          </span>
        )}
      </button>
      {!collapsed &&
        (replying ? (
          <CommentForm
            placeholder="Reply…"
            submitLabel="Reply"
            onSubmit={onReply}
            onCancel={onReplyClose}
          />
        ) : (
          <div className="ub-thread-actions">
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
  focused,
  author,
  onFocus,
}: {
  connection: RoomConnection | null;
  focused: ThreadFocus | null;
  /** The awareness name this client publishes — the author of its replies. */
  author: string;
  onFocus: (threadId: string) => void;
}): ReactElement | null {
  const threads = useThreads(connection);
  const [replyTo, setReplyTo] = useState<string | null>(null);
  /**
   * The one resolved thread the reader has opened back up. One at a time: the
   * resolved list is an archive, and expanding a card there is a glance, not a
   * mode the rail should stay in.
   */
  const [expanded, setExpanded] = useState<string | null>(null);

  // A highlight click focuses a card that may be scrolled out of the rail. Keyed
  // on the whole focus and not its id, so clicking the same highlight again
  // scrolls the rail back to its card — see `ThreadFocus`.
  useEffect(() => {
    if (focused !== null) scrollThreadCardIntoView(focused.id);
  }, [focused]);

  // A pending reply outlives the conversation it belonged to unless it is let
  // go: hiding the form while a thread reads as resolved is not the same as
  // forgetting it, and a thread someone else resolves and then reopens would
  // bring the form — and its focus grab — back with nobody having asked.
  useEffect(() => {
    if (replyTo === null) return;
    const thread = threads.find((candidate) => candidate.id === replyTo);
    if (thread === undefined || thread.resolved) setReplyTo(null);
  }, [threads, replyTo]);

  if (connection === null || threads.length === 0) return null;
  const { ydoc } = connection;
  const open = threads.filter((thread) => !thread.resolved);
  const resolved = threads.filter((thread) => thread.resolved);

  const card = (thread: ThreadView): ReactElement => (
    <ThreadCard
      key={thread.id}
      thread={thread}
      focused={thread.id === focused?.id}
      collapsed={thread.resolved && expanded !== thread.id}
      // A resolved thread never shows the form, however `replyTo` got here: it
      // may name a thread someone else resolved a moment ago, and expanding
      // that card must not offer a reply nobody asked for.
      replying={replyTo === thread.id && !thread.resolved}
      onSelect={() => {
        onFocus(thread.id);
        flashThreadHighlight(thread.id);
        // A resolved card is collapsed, so the click that selects it is also
        // the click that opens it — and closes it again.
        if (thread.resolved) {
          setExpanded((current) => (current === thread.id ? null : thread.id));
        }
      }}
      onReplyOpen={() => setReplyTo(thread.id)}
      onReplyClose={() => setReplyTo(null)}
      onReply={(text) => {
        // `addComment` appends to a thread that is right here on screen; there
        // is no range to clash with, so it has no refusal to answer with.
        addComment(ydoc, thread.id, author, text);
        setReplyTo(null);
        return true;
      }}
      onResolve={(next) => {
        setAnnotationResolved(ydoc, thread.id, next);
        setReplyTo((current) => (current === thread.id ? null : current));
        setExpanded(null);
      }}
    />
  );

  return (
    <section className="ub-threads" aria-label="Threads">
      {/* The count is the open threads: a rail that keeps counting settled
          conversations stops telling you anything about the document. */}
      <p className="ub-rail-head">
        Threads <span className="ub-muted">{open.length}</span>
      </p>
      <ul>{open.map(card)}</ul>
      {resolved.length > 0 && (
        <>
          <p className="ub-rail-head ub-rail-subhead">
            Resolved <span className="ub-muted">{resolved.length}</span>
          </p>
          <ul>{resolved.map(card)}</ul>
          {/* Fades the resolved ranges in the prose. See `resolvedHighlightCss`
              for why this is a stylesheet rather than a class on the span. */}
          <style data-resolved-highlights="">
            {resolvedHighlightCss(resolved.map((thread) => thread.id))}
          </style>
        </>
      )}
    </section>
  );
}
