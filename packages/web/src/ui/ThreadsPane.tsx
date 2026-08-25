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
 *
 * A card on screen is always a render old, and the document is shared: the
 * thread it names can be resolved or deleted by anyone between the render and
 * the click. So a reply re-reads the thread at submit and refuses if it is gone
 * or settled, rather than appending to a conversation that is over. A refusal
 * keeps the writer's text — that is `CommentForm`'s contract for returning
 * false — and says why on the card rather than inside the form, because the
 * form is on its way out: resolving a thread takes the reply form with it (see
 * the effect below), so a message in the form's own error slot would be removed
 * in the same flush that wrote it.
 *
 * That message is then reconciled against the document like everything else on
 * a card. It described the thread at one moment, and the same client that
 * settled the thread can reopen it a second later — from anywhere.
 */

import { useEffect, useState } from "react";
import type { ReactElement } from "react";
import { addComment, getAnnotation, setAnnotationResolved } from "@uberblick/schema";
import type { AnnotationComment } from "@uberblick/schema";
import type { RoomConnection } from "../collab/rooms.js";
import { useThreads } from "./hooks.js";
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
  readOnly,
  refusal,
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
  /** The conversation is readable, but nothing on the card writes. */
  readOnly: boolean;
  /**
   * Why the last reply to this thread was refused, if it was — and null on a
   * card that reads as open, because that is what the refusal is about.
   */
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
      {/* Outside the `collapsed` branch below: a reply refused because someone
          else resolved the thread arrives on a card that is collapsing in the
          same flush, and the reason has to outlive that. */}
      {refusal !== null && <p className="ub-comment-error">{refusal}</p>}
      {/* An archived document's threads are history: every comment stays
          readable, and there is nothing here that would write to it. */}
      {!collapsed &&
        !readOnly &&
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
  readOnly = false,
  onFocus,
}: {
  connection: RoomConnection | null;
  focused: ThreadFocus | null;
  /** The awareness name this client publishes — the author of its replies. */
  author: string;
  /**
   * Read the threads, write nothing — what an archived document allows. The
   * rail keeps every card, and drops Reply, Resolve and Reopen.
   */
  readOnly?: boolean;
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
  /**
   * The one refused reply, and the thread it was refused on. Set where a reply
   * is turned away and cleared only by the watch below — the state it describes
   * belongs to the document, so nothing here is entitled to clear it by hand.
   */
  const [refusal, setRefusal] = useState<{ id: string; message: string } | null>(
    null,
  );

  // A highlight click focuses a card that may be scrolled out of the rail. Keyed
  // on the whole focus and not its id, so clicking the same highlight again
  // scrolls the rail back to its card — see `ThreadFocus`.
  //
  // A keyboard activation also takes DOM focus with it, which is the far end of
  // the path a Tab and an Enter started in the prose (#101). In an effect and
  // not at the key press, because the rail may be a drawer that this very
  // selection opened: the card is focusable once React has committed it.
  useEffect(() => {
    if (focused === null) return;
    scrollThreadCardIntoView(focused.id);
    if (focused.viaKeyboard) focusThreadCard(focused.id);
  }, [focused]);

  // A pending reply outlives the conversation it belonged to unless it is let
  // go: hiding the form while a thread reads as resolved is not the same as
  // forgetting it, and a thread someone else resolves and then reopens would
  // bring the form — and its focus grab — back with nobody having asked.
  //
  // Read-only is the same hazard with a different cause: archiving a document
  // hides the form without forgetting it, and the restore would bring it back
  // and take the focus with it (`CommentForm` autofocuses), on a gesture nobody
  // made. Whoever archived it ended the conversation for now; the reply is let
  // go with it.
  useEffect(() => {
    if (replyTo === null) return;
    if (readOnly) {
      setReplyTo(null);
      return;
    }
    const thread = threads.find((candidate) => candidate.id === replyTo);
    if (thread === undefined || thread.resolved) setReplyTo(null);
  }, [threads, replyTo, readOnly]);

  // A refusal describes a thread at one moment, and that thread is shared:
  // whoever settled it can reopen it, and an id that is gone can come back on a
  // new thread. "Reopen it to reply" standing over an open thread is worse than
  // silence, so the message lives exactly as long as the state that justified
  // it — a remote reopen takes it away with nobody here clicking anything.
  //
  // The rail answers first: it is what the message is displayed beside, and its
  // recompute on every document change is what runs this again. The document is
  // the tiebreaker for the one window where the rail is a flush behind — the
  // refusal is written in the same task the resolve arrives in, which is the
  // whole reason it exists.
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
      readOnly={readOnly}
      // Same guard as `replying` above, for the same reason: the message is
      // about a settled thread, so a card that reads as open must not show it —
      // not even for the one committed frame between a reopen reaching the rail
      // and the effect below letting the message go.
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
      onReplyOpen={() => setReplyTo(thread.id)}
      onReplyClose={() => setReplyTo(null)}
      onReply={(text) => {
        // Read the thread as the document has it *now*, not as this card was
        // rendered: between the two, another client may have resolved it or
        // deleted it, and neither should quietly take a reply.
        if (getAnnotation(ydoc, thread.id)?.resolved === true) {
          setRefusal({
            id: thread.id,
            message:
              "This thread was resolved while you wrote — reopen it to reply.",
          });
          return false;
        }
        // `addComment` looks the thread up itself and returns null when it is
        // not there, so it — not the read above — is the last word on whether
        // anything was written.
        if (addComment(ydoc, thread.id, author, text) === null) {
          setRefusal({ id: thread.id, message: "This thread no longer exists." });
          return false;
        }
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
