import { useCallback, useEffect, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { RoomConnection } from "../../collab/rooms.js";
import { focusThread } from "../comments/threads.js";
import type { SelectThread, ThreadFocus, ThreadView } from "../comments/threads.js";
import { useThreads } from "../hooks.js";

export interface ThreadsRail {
  threads: ThreadView[];
  focusedThread: ThreadFocus | null;
  threadsOpen: boolean;
  hasReplyDrafts: boolean;
  setHasReplyDrafts(present: boolean): void;
  setThreadsOpen: Dispatch<SetStateAction<boolean>>;
  closeThreads(): void;
  restoreThreadsFocus(event: Event): void;
  onFocusThread: SelectThread;
  onToggleThreads(): void;
}

export function useThreadsRail(doc: RoomConnection | null): ThreadsRail {
  /** One focus value connects the editor highlight and rail card across panes. */
  const [focusedThread, setFocusedThread] = useState<ThreadFocus | null>(null);
  /**
   * Whether the narrow rail is open. Retained across resizing; the wide rail
   * always remains a non-modal column.
   */
  const [threadsOpen, setThreadsOpen] = useState(false);
  const [replyDrafts, setReplyDrafts] = useState<{ room: string | null; present: boolean }>({ room: null, present: false });
  const room = doc?.room ?? null;
  const hasReplyDrafts = replyDrafts.room === room && replyDrafts.present;
  const setHasReplyDrafts = useCallback((present: boolean) => {
    setReplyDrafts((current) => current.room === room && current.present === present ? current : { room, present });
  }, [room]);
  const threadsOpenNow = useRef(threadsOpen);
  threadsOpenNow.current = threadsOpen;
  /**
   * Remember the drawer opener so closing a hidden narrow rail restores
   * visible focus.
   */
  const threadsOpener = useRef<HTMLElement | null>(null);
  const closeThreads = useCallback(() => setThreadsOpen(false), []);

  // Run after the modal unmounts and releases its focus scope. A resize to the
  // wide rail also unmounts it, but keeps the open state and must not return
  // focus to the prose while the reader is still using the rail.
  const restoreThreadsFocus = useCallback((event: Event) => {
    event.preventDefault();
    if (threadsOpenNow.current) return;
    const opener = threadsOpener.current;
    threadsOpener.current = null;
    const back =
      opener?.isConnected === true && !opener.hasAttribute("data-comment-resolved")
        ? opener
        : document.querySelector<HTMLElement>(".ub-threads-toggle");
    back?.focus();
  }, []);

  const onFocusThread = useCallback<SelectThread>((threadId, selection) => {
    if (threadId === null) {
      setFocusedThread(null);
      return;
    }
    setFocusedThread((previous) => focusThread(previous, threadId, selection));
    // The highlight is still what holds focus here — the card takes it a commit
    // later, from the rail's own effect — so this is the reader's way back.
    if (
      selection?.viaKeyboard === true &&
      document.activeElement instanceof HTMLElement
    ) {
      threadsOpener.current = document.activeElement;
    }
    // Selecting a thread asks to read it. Keep that request across resizing,
    // even while the wide rail is already visible as a non-modal column.
    setThreadsOpen(true);
  }, []);

  const onToggleThreads = useCallback(() => {
    if (threadsOpen) {
      closeThreads();
      return;
    }
    // The click has already put focus on the handle, which is where closing
    // should leave it.
    threadsOpener.current = null;
    setThreadsOpen(true);
  }, [threadsOpen, closeThreads]);

  /**
   * Share one thread reading between rail content, the pane-edge count and
   * the empty-drawer gate.
   */
  const threads = useThreads(doc);
  /**
   * An open drawer must close if navigation or a remote deletion empties its
   * rail.
   */
  useEffect(() => {
    // Opening for a newly created thread can precede the observer's reading.
    // Close when the rail empties, rather than when its open state changes.
    if (threads.length === 0 && !hasReplyDrafts) closeThreads();
  }, [threads.length, hasReplyDrafts, closeThreads]);

  return {
    threads, focusedThread, threadsOpen, setThreadsOpen, closeThreads, hasReplyDrafts, setHasReplyDrafts,
    restoreThreadsFocus, onFocusThread, onToggleThreads,
  };
}
