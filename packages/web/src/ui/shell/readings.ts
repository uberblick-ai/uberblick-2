import { useCallback, useEffect, useState } from "react";
import { getDirectoryEntry, relatedDecisionTopics, parseRoom } from "@uberblick/schema";
import { watchDocumentStub } from "../../collab/directory-stub.js";
import { useAgentSessions, useArchived, useDocMeta, useTitlePresence } from "../hooks.js";
import { docIsHydrated } from "../route.js";
import { useServingRoomStatus } from "../status/serving-status.js";
import type { ShellEnvironment } from "./environment.js";
import type { ShellRooms } from "./rooms.js";

export function useShellReadings({ route, documentSearch }: ShellEnvironment, { directory, doc, topics, selected }: ShellRooms) {
  const meta = useDocMeta(doc);
  const relatedTopics = route.kind === "doc" && meta !== null && docIsHydrated(route.uuid, meta)
    ? relatedDecisionTopics(topics, meta)
    : [];
  const archived = useArchived(directory, selected);
  // Read the selected stub directly while its directory observer catches up.
  const selectedDirectoryEntry =
    directory === null || selected === null
      ? undefined
      : getDirectoryEntry(directory.ydoc, selected);
  /**
   * Sync details describe the open document room; routes without a document
   * have no replacement room.
   */
  const chromeRoom = selected === null ? null : doc;
  // Read the timestamp segment the status line actually displays, preserving
  // its existing initial settle window and clearing stale reports by room.
  const [shownLastUpdated, setShownLastUpdated] = useState<{
    room: string;
    value: number;
  } | null>(null);
  const onLastUpdatedChange = useCallback(
    (room: string, value: number | undefined) => {
      setShownLastUpdated((previous) => {
        if (value === undefined) return previous?.room === room ? null : previous;
        return previous?.room === room && previous.value === value
          ? previous
          : { room, value };
      });
    },
    [],
  );
  const servingStatus = useServingRoomStatus(
    documentSearch,
    chromeRoom?.room ?? directory?.room ?? null,
    chromeRoom ?? directory,
  );
  /**
   * The title retains departed agents exactly while their named editor
   * cursors remain visible.
   */
  const titlePresence = useTitlePresence(chromeRoom);
  /**
   * Count workspace agent sessions in the directory room, which every session
   * joins.
   */
  const agentSessions = useAgentSessions(directory);

  return { meta, relatedTopics, archived, selectedDirectoryEntry, chromeRoom, shownLastUpdated, onLastUpdatedChange, servingStatus, titlePresence, agentSessions };
}

export function useDocumentStubRepair({ doc, topicTitleRoom, directory }: ShellRooms) {
  /**
   * Document meta.title is authoritative; repair the directory cache while
   * open and stamp local edits. Wait for current directory state so an unseen
   * tombstone cannot race repair. See collab/directory-stub.ts.
   */
  useEffect(() => {
    if (directory === null) return;
    const stops = [doc, topicTitleRoom].flatMap((connection) => connection === null ? [] : [
      watchDocumentStub(connection.ydoc, directory.ydoc, parseRoom(connection.room).uuid, {
        writable: () => directory.status.writable,
        synchronized: () => directory.status.synced,
        subscribe: (listener) => directory.onStatusChange(() => listener()),
      }),
    ]);
    return () => { for (const stop of stops) stop(); };
  }, [doc, topicTitleRoom, directory]);

}

export function useSyncDetails(kind: ShellEnvironment["route"]["kind"]) {
  const [syncOpen, setSyncOpen] = useState(false);
  useEffect(() => {
    if (kind !== "doc" && kind !== "decision" && syncOpen) setSyncOpen(false);
  }, [kind, syncOpen]);
  return { syncOpen, setSyncOpen };
}
