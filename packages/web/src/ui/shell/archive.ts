import { useCallback, useEffect, useRef } from "react";
import { archiveDocument, archiveDecisionRecord, deleteDirectoryEntry, getDirectoryEntry, decisionTopicArchived, decisionTopicTitle, getMeta, isDirectoryEntryArchived, resolveDecisionTopics, restoreDirectoryEntry, unpinDoc } from "@uberblick/schema";
import { toast } from "sonner";
import { acquireRoom } from "../../collab/rooms.js";
import type { ShellEnvironment } from "./environment.js";
import type { ShellRooms } from "./rooms.js";
import { docPath } from "../route.js";
import type { Navigate } from "../route.js";

type ArchiveOptions = Pick<ShellEnvironment, "defaultIdentity" | "workspace"> & Pick<ShellRooms, "directory" | "doc" | "sidebar" | "selected"> & { navigate: Navigate };

export function useArchive({ directory, doc, sidebar, selected, defaultIdentity, workspace, navigate }: ArchiveOptions) {
  const restoreFocusRoom = useRef<string | null>(null);
  const archiveConfirmationFocusRoom = useRef<string | null>(null);
  const archiveUndoReleases = useRef(new Set<() => void>());
  useEffect(() => () => {
    for (const release of archiveUndoReleases.current) release();
  }, []);
  /**
   * Restore through the shared schema lifecycle operation against the
   * directory document.
   */
  const onRestore = useCallback(() => {
    if (
      directory === null ||
      selected === null ||
      !directory.status.writable
    ) {
      return;
    }
    restoreFocusRoom.current = null;
    restoreDirectoryEntry(directory.ydoc, selected);
  }, [directory, selected]);

  const onRestoreFocused = useCallback(() => {
    restoreFocusRoom.current = null;
    archiveConfirmationFocusRoom.current = null;
  }, []);

  const onDelete = useCallback(() => {
    if (directory === null || selected === null || !directory.status.writable) return;
    const entry = getDirectoryEntry(directory.ydoc, selected);
    if (entry === null || entry.kind === "decision" || entry.deleted !== true ||
      (doc !== null && getMeta(doc.ydoc).kind === "decision")) return;
    deleteDirectoryEntry(directory.ydoc, selected);
    // Pin cleanup cannot hold up deletion; readers hide deleted UUIDs even
    // when this replica cannot write the sidebar yet.
    if (sidebar?.status.writable) unpinDoc(sidebar.ydoc, selected);
  }, [directory, selected, doc, sidebar]);

  /**
   * Remember focus inside archive confirmation so a remote tombstone can
   * transfer it to Restore when the portal disappears.
   */
  const onArchiveConfirmationFocusChange = useCallback(
    (focused: boolean) => {
      if (doc === null) return;
      if (focused) {
        archiveConfirmationFocusRoom.current = doc.room;
      } else if (archiveConfirmationFocusRoom.current === doc.room) {
        archiveConfirmationFocusRoom.current = null;
      }
    },
    [doc],
  );

  // Re-read room state at activation; require a synced writable sidebar
  // so the archive uses the current pin state.
  const onArchive = useCallback((recordOnly = false) => {
    if (
      directory === null ||
      doc === null ||
      sidebar === null ||
      selected === null ||
      !directory.status.writable ||
      !sidebar.status.writable ||
      !sidebar.status.synced
    ) {
      return;
    }
    const entry = getDirectoryEntry(directory.ydoc, selected);
    if (entry === null || decisionTopicArchived(directory.ydoc, selected)) return;
    const freshTopic = entry.kind === "decision"
      ? resolveDecisionTopics(directory.ydoc).find((candidate) => candidate.topic === (entry.topic ?? entry.uuid)) : undefined;
    const title = (freshTopic === undefined ? getMeta(doc.ydoc).title : decisionTopicTitle(freshTopic)) || "Untitled";
    if (recordOnly) {
      if (!archiveDecisionRecord(directory.ydoc, sidebar.ydoc, selected)) return;
      if (workspace !== null && entry.kind === "decision") navigate(docPath(workspace.segment, entry.topic ?? entry.uuid));
    } else {
      restoreFocusRoom.current = doc.room;
      archiveDocument(directory.ydoc, sidebar.ydoc, selected);
    }
    const uuid = selected;
    // Keep the original directory alive while Undo is offered, including
    // navigation to a document in another workspace.
    const held = acquireRoom(directory.room, defaultIdentity, { presence: false });
    let closed = false;
    const close = (): void => {
      if (closed) return;
      closed = true;
      held.release();
      archiveUndoReleases.current.delete(close);
    };
    archiveUndoReleases.current.add(close);
    const id = toast.success(`Archived “${title}”.`, {
      onDismiss: close,
      onAutoClose: close,
      action: {
        label: "Undo",
        onClick: (event) => {
          try {
            if (closed || !isDirectoryEntryArchived(held.connection.ydoc, uuid)) return;
            if (!held.connection.status.writable) {
              // Keep the replacement visible after Sonner finishes this action.
              event.preventDefault();
              toast.error(`“${title}” is still archived. Open its link and choose Restore when the connection is ready.`, {
                id,
                action: undefined,
              });
              return;
            }
            restoreFocusRoom.current = null;
            restoreDirectoryEntry(held.connection.ydoc, uuid);
          } finally {
            close();
          }
        },
      },
    });
  }, [directory, doc, sidebar, selected, defaultIdentity, workspace, navigate]);

  return { restoreFocusRoom, archiveConfirmationFocusRoom, onRestore, onRestoreFocused, onArchiveConfirmationFocusChange, onArchive, onDelete };
}
