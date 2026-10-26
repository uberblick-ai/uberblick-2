/**
 * The model owns mention triggers, candidates and writes; CaretMenu handles
 * placement and ProseMirror keys. Empty results keep the answer visible but
 * release Enter/arrows to prose. Read only directory candidates, never target
 * rooms, and refresh arrivals while open so discovery cannot hydrate an
 * unresolved reference.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactElement, RefObject } from "react";
import type { Editor } from "@tiptap/core";
import type { Transaction } from "@tiptap/pm/state";
import {
  linkMentionAtTrigger,
  personMentionAtTrigger,
  mentionTriggerAt,
  opensMentionSession,
} from "../../editor/mention-menu.js";
import type { MentionTrigger } from "../../editor/mention-menu.js";
import type { DocLinkContext } from "../../editor/doc-links.js";
import { useCaretMenuKeys } from "./caret-menu.js";
import { CaretMenu, useCaretMenuIds } from "./CaretMenu.js";
import { mentionCandidates } from "../../mentions.js";
import type { MentionCandidate } from "../../mentions.js";
import { useWorkspaceMembers } from "../workspace-members.js";

interface MentionSession {
  trigger: MentionTrigger;
}

export function MentionMenu({
  editor,
  host,
  docLinks,
  openDocId,
  members: suppliedMembers,
}: {
  editor: Editor;
  /** The editor frame, used to find the pane's collision boundary. */
  host: RefObject<HTMLElement | null>;
  /**
   * Live document references from the workspace directory.
   */
  docLinks: DocLinkContext | null;
  /** The document on screen, which is never offered as a reference target. */
  openDocId: string | null;
  members?: readonly string[];
}): ReactElement | null {
  const workspaceMembers = useWorkspaceMembers();
  const members = suppliedMembers ?? workspaceMembers;
  const enabled = docLinks !== null || members.length > 0;
  const [session, setSession] = useState<MentionSession | null>(null);
  // Transaction listeners invalidate a session before React publishes a render.
  const liveSession = useRef<MentionSession | null>(null);
  /** The highlighted entry, and the list it was highlighted in. */
  const [highlight, setHighlight] = useState<{ list: string; index: number; keyboard: boolean }>({
    list: "",
    index: 0,
    keyboard: false,
  });
  /**
   * Escape and outside click dismiss this trigger until it stops matching; a
   * fresh @ can open another session.
   */
  const dismissed = useRef(false);
  /** Bumped when the directory changes, so an open card re-reads its candidates. */
  const [directoryTick, setDirectoryTick] = useState(0);

  // Validate sessions from current state; opening still requires the
  // qualifying local transaction.
  useEffect(() => {
    // Without a workspace, skip the session and its per-keystroke rendering.
    const publish = (next: MentionSession | null): void => {
      liveSession.current = next;
      setSession(next);
    };
    if (!enabled) {
      publish(null);
      return;
    }
    const read = (transaction: Transaction | null): void => {
      const trigger = mentionTriggerAt(editor);
      if (trigger === null) {
        dismissed.current = false;
        publish(null);
        return;
      }
      if (dismissed.current) {
        publish(null);
        return;
      }
      const current = liveSession.current;
      const here = { trigger };
      if (current === null) {
        publish(transaction !== null && opensMentionSession(transaction, trigger)
          ? here
          : null);
        return;
      }
      // Map the occurrence and its enclosing cell. Removed boundaries cannot
      // identify a successor cell, even when it holds the same query.
      const carried = transaction === null
        ? { pos: current.trigger.from, deleted: false }
        : transaction.mapping.mapResult(current.trigger.from, 1);
      const cell = current.trigger.cell;
      const start = cell === null ? null : transaction?.mapping.mapResult(cell.from, 1);
      const end = cell === null ? null : transaction?.mapping.mapResult(cell.to, -1);
      const sameCell = cell === null
        ? trigger.cell === null
        : trigger.cell !== null && !start?.deleted && !end?.deleted
          && (start?.pos ?? cell.from) === trigger.cell.from
          && (end?.pos ?? cell.to) === trigger.cell.to;
      publish(!carried.deleted && carried.pos === trigger.from
        && current.trigger.blockId === trigger.blockId && sameCell ? here : null);
    };
    read(null);
    const onTransaction = ({ transaction }: { transaction: Transaction }): void =>
      read(transaction);
    const onUpdate = (): void => {
      if (!editor.isEditable) read(null);
    };
    editor.on("transaction", onTransaction);
    editor.on("update", onUpdate);
    return () => {
      editor.off("transaction", onTransaction);
      editor.off("update", onUpdate);
      liveSession.current = null;
    };
  }, [editor, enabled]);

  // A document arriving while the card is open belongs on the list. Subscribed
  // only while there is a card to update.
  const open = session !== null && enabled;
  useEffect(() => {
    if (!open || docLinks === null) return;
    return docLinks.subscribe(() => setDirectoryTick((tick) => tick + 1));
  }, [open, docLinks]);

  const query = session?.trigger.query ?? "";
  const entries =
    open
      ? mentionCandidates(docLinks?.candidates() ?? [], members, query, openDocId)
      : [];
  // Editing the query makes a different list, so the remembered position no
  // longer means anything and the first entry is highlighted again.
  const list = JSON.stringify([query, directoryTick, members]);
  const chosen = highlight.list === list ? highlight.index : 0;
  const active = entries.length === 0 ? -1 : Math.min(chosen, entries.length - 1);

  const highlightAt = useCallback(
    (index: number, keyboard = false): void =>
      setHighlight((current) =>
        current.list === list && current.index === index && current.keyboard === keyboard
          ? current
          : { list, index, keyboard },
      ),
    [list],
  );

  const choose = useCallback(
    (entry: MentionCandidate | undefined): void => {
      if (entry === undefined || session === null || liveSession.current !== session) return;
      // Close after either a pick or refusal. Do not remember dismissal: a
      // successful reference removes the trigger, and retaining it would
      // suppress the next @.
      if (entry.kind === "person") personMentionAtTrigger(editor, session.trigger, entry.username, members);
      else linkMentionAtTrigger(editor, session.trigger, entry.docId, docLinks);
      liveSession.current = null;
      setSession(null);
    },
    [editor, session, docLinks, members],
  );

  const step = useCallback(
    (delta: number): void => {
      if (entries.length === 0) return;
      highlightAt((active + delta + entries.length) % entries.length, true);
    },
    [entries.length, active, highlightAt],
  );

  /**
   * Own keys only while they can act on options; empty results return Enter
   * and arrows to prose.
   */
  const handleKey = useCallback(
    (key: string): boolean => {
      if (session === null || liveSession.current !== session) return false;
      if (key === "Escape") {
        dismissed.current = true;
        liveSession.current = null;
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
      if (key === "Enter" || key === "Tab") {
        choose(entries[active]);
        return true;
      }
      return false;
    },
    [step, choose, entries, active, session],
  );

  const { listId, activeId } = useCaretMenuIds(active);
  useCaretMenuKeys(editor, open ? handleKey : null, listId, activeId);

  return (
    <CaretMenu
      editor={editor}
      host={host}
      open={open}
      onDismiss={() => {
        dismissed.current = true;
        liveSession.current = null;
        setSession(null);
      }}
      listKey={list}
      listId={listId}
      label="People and documents"
      options={entries.map((entry) => ({
        id: entry.kind === "person" ? `person:${entry.username}` : entry.docId,
        label: entry.label,
        group: entry.kind === "person" ? "People" : "Documents",
      }))}
      active={active}
      reveal={highlight.list === list && highlight.keyboard}
      highlightAt={highlightAt}
      choose={(index) => choose(entries[index])}
      empty="No people or documents match."
    />
  );
}
