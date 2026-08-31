/**
 * The `@` picker: type `@` in a prose block, choose a document, and the typed
 * query becomes an inline reference to it.
 *
 * The model — when an `@` is a mention, what it offers, and the edit behind
 * picking an entry — is `editor/mention-menu.ts`; what this file owns is pixels,
 * focus and keys. It is the block menu's twin and deliberately looks like it:
 * the same card, the same highlight, the same capture-phase key handling and the
 * same input-method guard (`ui/caret-menu.ts`), because a reader who has learned
 * one of the two menus has learned both.
 *
 * Three things are its own.
 *
 * - **Nothing matching keeps the card open.** The block menu closes on an empty
 *   result, because a slash query nothing matches is a reader writing prose. An
 *   `@` query nothing matches is a reader looking for a document that has not
 *   reached this replica — silence would read as "there are none", so the card
 *   says which question it answered instead. It gives Enter and the arrows back
 *   to the prose all the same: there is nothing to move over or pick.
 *
 * - **The candidates are the directory, and only the directory.** No target room
 *   is opened to offer a document, so the picker works with the hub unreachable
 *   and cannot make an unresolved reference resolve by looking at it. It
 *   re-reads when the directory changes, so a document arriving mid-session
 *   joins the list.
 *
 * - **A click outside dismisses, like every menu.** The block menu's slash
 *   session needs no such handler — its query is the whole block, so any click
 *   moves the caret out of it and closes the session by itself. An `@` sits
 *   inside a sentence, and a click landing further along that same sentence
 *   would leave the trigger valid and the card hanging over prose the reader has
 *   moved on from.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactElement, RefObject } from "react";
import type { Editor } from "@tiptap/core";
import type { Transaction } from "@tiptap/pm/state";
import {
  filterMentions,
  linkMentionAtTrigger,
  mentionTriggerAt,
  opensMentionSession,
} from "../editor/mention-menu.js";
import type { MentionTrigger } from "../editor/mention-menu.js";
import type { DocLinkContext } from "../editor/doc-links.js";
import { pointAtCaret, useCompositionGuard } from "./caret-menu.js";
import type { KeySource, Point } from "./caret-menu.js";

interface MentionSession {
  trigger: MentionTrigger;
  point: Point;
}

export function MentionMenu({
  editor,
  host,
  docLinks,
  openDocId,
}: {
  editor: Editor;
  /** The positioned element the card is placed inside — `.ub-editor-frame`. */
  host: RefObject<HTMLElement | null>;
  /**
   * The directory this workspace's references resolve against. Null in an editor
   * with no workspace behind it, where there is nothing to offer and the picker
   * never opens.
   */
  docLinks: DocLinkContext | null;
  /** The document on screen, which is never offered as a reference target. */
  openDocId: string | null;
}): ReactElement | null {
  const [session, setSession] = useState<MentionSession | null>(null);
  /** The highlighted entry, and the list it was highlighted in. */
  const [highlight, setHighlight] = useState<{ list: string; index: number }>({
    list: "",
    index: 0,
  });
  /**
   * Esc, remembered for as long as the session it dismissed — and set by a click
   * outside too, which means the same thing. Cleared the moment the text stops
   * looking like a mention, so typing a fresh `@` opens the picker again while
   * typing on after Esc leaves the text alone.
   */
  const dismissed = useRef(false);
  const card = useRef<HTMLDivElement | null>(null);
  /** Bumped when the directory changes, so an open card re-reads its candidates. */
  const [directoryTick, setDirectoryTick] = useState(0);

  /** The picker has one typing surface: the prose it is anchored in. */
  const sourceOf = useCallback(
    (target: EventTarget | null): KeySource | null =>
      target instanceof Node && editor.view.dom.contains(target) ? "editor" : null,
    [editor],
  );
  const menuOwnsKey = useCompositionGuard(editor, host, sourceOf);

  // The session is derived from the state on every transaction and opened by
  // the transaction — the same two questions, with the same two answers, as the
  // block menu's slash session.
  useEffect(() => {
    // No workspace behind this editor is no directory to offer, so there is
    // nothing for a session to be about — and nothing to re-render per
    // keystroke either.
    if (docLinks === null) return;
    const read = (transaction: Transaction | null): void => {
      const trigger = mentionTriggerAt(editor);
      if (trigger === null) {
        dismissed.current = false;
        setSession(null);
        return;
      }
      if (dismissed.current) {
        setSession(null);
        return;
      }
      setSession((current) => {
        const here = { trigger, point: pointAtCaret(editor, host.current) };
        if (current === null) {
          return transaction !== null && opensMentionSession(transaction, trigger)
            ? here
            : null;
        }
        // A session belongs to **one** `@`. Carrying its position through this
        // transaction and comparing is what makes a caret moved to a second
        // `@hub` in the same block close the card rather than silently re-aim
        // it at the other occurrence.
        const carried =
          transaction === null
            ? current.trigger.from
            : transaction.mapping.map(current.trigger.from);
        return carried === trigger.from ? here : null;
      });
    };
    read(null);
    const onTransaction = ({ transaction }: { transaction: Transaction }): void =>
      read(transaction);
    editor.on("transaction", onTransaction);
    return () => {
      editor.off("transaction", onTransaction);
    };
  }, [editor, host, docLinks]);

  // A document arriving while the card is open belongs on the list. Subscribed
  // only while there is a card to update.
  const open = session !== null && docLinks !== null;
  useEffect(() => {
    if (!open || docLinks === null) return;
    return docLinks.subscribe(() => setDirectoryTick((tick) => tick + 1));
  }, [open, docLinks]);

  const query = session?.trigger.query ?? "";
  const entries =
    open && docLinks !== null
      ? filterMentions(docLinks.candidates(), query, openDocId)
      : [];
  // Editing the query makes a different list, so the remembered position no
  // longer means anything and the first entry is highlighted again.
  const list = `${query}:${directoryTick}`;
  const chosen = highlight.list === list ? highlight.index : 0;
  const active = entries.length === 0 ? -1 : Math.min(chosen, entries.length - 1);

  const highlightAt = useCallback(
    (index: number): void => setHighlight({ list, index }),
    [list],
  );

  const choose = useCallback(
    (docId: string | undefined): void => {
      if (docId === undefined || session === null) return;
      // A refusal means the session no longer describes the document; either way
      // the picker has had its answer and closes. `dismissed` is deliberately
      // not set: the reference replaced the `@query`, so the trigger is already
      // gone — and remembering a dismissal here would keep the *next* `@` from
      // opening a picker at all.
      linkMentionAtTrigger(editor, session.trigger, docId, docLinks);
      setSession(null);
    },
    [editor, session, docLinks],
  );

  const step = useCallback(
    (delta: number): void => {
      if (entries.length === 0) return;
      highlightAt((active + delta + entries.length) % entries.length);
    },
    [entries.length, active, highlightAt],
  );

  /**
   * The keys the picker owns while it is open. Returns false for the rest — and
   * for ↑/↓/Enter when nothing matched, because a key that moves nothing and
   * picks nothing belongs to the prose underneath.
   */
  const handleKey = useCallback(
    (key: string): boolean => {
      if (key === "Escape") {
        dismissed.current = true;
        setSession(null);
        return true;
      }
      if (entries.length === 0) return false;
      if (key === "ArrowDown") {
        step(1);
        return true;
      }
      if (key === "ArrowUp") {
        step(-1);
        return true;
      }
      if (key === "Enter") {
        choose(entries[active]?.docId);
        return true;
      }
      return false;
    },
    [step, choose, entries, active],
  );

  // Taken before ProseMirror sees them, so an Enter that meant "this document"
  // never splits the paragraph it was typed in.
  useEffect(() => {
    if (!open) return;
    const target = editor.view.dom.parentElement ?? editor.view.dom;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!menuOwnsKey(event, "editor")) return;
      if (!handleKey(event.key)) return;
      event.preventDefault();
      event.stopPropagation();
    };
    target.addEventListener("keydown", onKeyDown, true);
    return () => {
      target.removeEventListener("keydown", onKeyDown, true);
    };
  }, [editor, open, handleKey, menuOwnsKey]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: Event): void => {
      const target = event.target;
      if (target instanceof Node && card.current?.contains(target) === true) return;
      dismissed.current = true;
      setSession(null);
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
    };
  }, [open]);

  if (!open || session === null) return null;

  return (
    <div
      className="ub-blockmenu ub-mentionmenu"
      ref={card}
      style={{ top: `${session.point.top}px`, left: `${session.point.left}px` }}
    >
      {entries.length === 0 ? (
        // "This replica", not "the workspace": a directory that has not synced
        // knows of no documents, and claiming there are none would be a claim
        // this client cannot make (see `shell/DocumentList.tsx`).
        <p className="ub-blockmenu-empty ub-muted">
          No document this replica knows matches.
        </p>
      ) : (
        <div className="ub-blockmenu-list" role="listbox" aria-label="Documents">
          {entries.map((entry, position) => (
            <button
              key={entry.docId}
              type="button"
              role="option"
              aria-selected={position === active}
              className={
                position === active
                  ? "ub-blockmenu-entry ub-blockmenu-on"
                  : "ub-blockmenu-entry"
              }
              // The caret stays in the sentence being written until an entry is
              // picked; the pick itself is what moves it.
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => highlightAt(position)}
              onClick={() => choose(entry.docId)}
            >
              <span className="ub-blockmenu-label">{entry.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
