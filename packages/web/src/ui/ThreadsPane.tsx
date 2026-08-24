/**
 * The Threads rail: every comment thread in the open document, read-only.
 *
 * A card is one `<button>` and nothing but phrasing content inside it — a
 * blockquote or a paragraph there would be invalid inside a button, and one
 * button per card keeps the rail a single tab stop per thread with Enter
 * activating it. The quote marks around the excerpt are CSS, not text.
 *
 * Clicking a card flashes the highlight in the prose; clicking a highlight
 * focuses the card. Both directions are the same `ThreadFocus`, held by the app
 * shell, because the two ends live in different panes.
 */

import { useEffect } from "react";
import type { ReactElement } from "react";
import type { AnnotationComment } from "@uberblick/schema";
import type { RoomConnection } from "../collab/rooms.js";
import { useThreads } from "./hooks.js";
import {
  commentTimestamp,
  flashThreadHighlight,
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
  onSelect,
}: {
  thread: ThreadView;
  focused: boolean;
  onSelect: () => void;
}): ReactElement {
  return (
    <li id={threadCardId(thread.id)}>
      <button
        type="button"
        className={`ub-thread${focused ? " ub-thread-focused" : ""}${thread.orphaned ? " ub-thread-orphaned" : ""}`}
        aria-current={focused ? "true" : undefined}
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
        {thread.comments.map((comment) => (
          <Comment key={comment.key} comment={comment} />
        ))}
        {thread.replyCount > 0 && (
          <span className="ub-thread-replies">
            {thread.replyCount} {thread.replyCount === 1 ? "reply" : "replies"}
          </span>
        )}
      </button>
    </li>
  );
}

export function ThreadsPane({
  connection,
  focused,
  onFocus,
}: {
  connection: RoomConnection | null;
  focused: ThreadFocus | null;
  onFocus: (threadId: string) => void;
}): ReactElement | null {
  const threads = useThreads(connection);

  // A highlight click focuses a card that may be scrolled out of the rail. Keyed
  // on the whole focus and not its id, so clicking the same highlight again
  // scrolls the rail back to its card — see `ThreadFocus`.
  useEffect(() => {
    if (focused !== null) scrollThreadCardIntoView(focused.id);
  }, [focused]);

  if (threads.length === 0) return null;
  return (
    <section className="ub-threads" aria-label="Threads">
      <p className="ub-rail-head">
        Threads <span className="ub-muted">{threads.length}</span>
      </p>
      <ul>
        {threads.map((thread) => (
          <ThreadCard
            key={thread.id}
            thread={thread}
            focused={thread.id === focused?.id}
            onSelect={() => {
              onFocus(thread.id);
              flashThreadHighlight(thread.id);
            }}
          />
        ))}
      </ul>
    </section>
  );
}
