import { useCallback, useEffect, useRef } from "react";
import { appendBlock, decisionDirectoryFields, initDoc, roomForDoc, upsertDirectoryEntry } from "@uberblick/schema";
import { acquireRoom } from "../../collab/rooms.js";
import type { AwarenessUser } from "../../collab/identity.js";
import type { RoomConnection } from "../../collab/rooms.js";
import type { Workspace } from "../route.js";

interface CreateDocumentOptions {
  directory: RoomConnection | null;
  workspace: Workspace | null;
  defaultIdentity: AwarenessUser;
  doc: RoomConnection | null;
  onSelect(uuid: string): void;
  onBackToWorkspace(): void;
}

/** Hold creation until admission and the page's own room connection arrive. */
export function useCreateDocument({
  directory, workspace, defaultIdentity, doc, onSelect, onBackToWorkspace,
}: CreateDocumentOptions) {
  const pending = useRef<{
    room: string;
    release: () => void;
    stop: () => void;
    created: boolean;
    mounted: boolean;
  } | null>(null);
  useEffect(
    () => () => {
      pending.current?.stop();
      pending.current?.release();
    },
    [],
  );
  useEffect(() => {
    const held = pending.current;
    if (held === null) return;
    if (doc === null || doc.room !== held.room) {
      if (!held.mounted || held.created) return;
      pending.current = null;
      held.stop();
      held.release();
      return;
    }
    held.mounted = true;
    if (!held.created) return;
    pending.current = null;
    held.stop();
    held.release();
  }, [doc]);
  return useCallback(() => {
    if (directory === null || workspace === null || !directory.status.writable) return;
    const uuid = crypto.randomUUID();
    const room = roomForDoc(workspace.uuid, uuid);
    const handle = acquireRoom(room, defaultIdentity);
    pending.current?.stop();
    pending.current?.release();
    const held = { room, release: handle.release, stop: () => {}, created: false, mounted: false };
    pending.current = held;
    const attempt = (): void => {
      // Status subscriptions seed synchronously; wait until both unsubscribe
      // functions have been assigned before acting on that seed.
      queueMicrotask(() => {
        if (pending.current !== held || held.created) return;
        const status = handle.connection.status;
        if (status.storeRefused || status.protocolMismatch !== null ||
          directory.status.storeRefused || directory.status.protocolMismatch !== null) {
          pending.current = null;
          held.stop();
          held.release();
          onBackToWorkspace();
          return;
        }
        if (!status.writable || !directory.status.writable) return;
        held.created = true;
        held.stop();
        initDoc(handle.connection.ydoc, { uuid, title: "Untitled" });
        // An empty paragraph provides a place for the new page's caret.
        appendBlock(handle.connection.ydoc, { type: "paragraph", text: "" });
        const createdAt = Date.now();
        upsertDirectoryEntry(directory.ydoc, {
          uuid, title: "Untitled", ...decisionDirectoryFields(handle.connection.ydoc),
          createdAt, updatedAt: createdAt,
        });
        if (held.mounted) {
          pending.current = null;
          held.release();
        }
      });
    };
    let stopDocument = handle.connection.onStatusChange(attempt);
    let stopDirectory = directory.onStatusChange(attempt);
    held.stop = () => {
      stopDocument();
      stopDirectory();
      stopDocument = () => {};
      stopDirectory = () => {};
    };
    // Admission can still be pending when the new page opens read-only.
    onSelect(uuid);
  }, [directory, defaultIdentity, onBackToWorkspace, onSelect, workspace]);
}
