import { useCallback } from "react";
import { readSidebar, unpinDoc } from "@uberblick/schema";
import { useSidebar } from "../hooks.js";
import { togglePin } from "../sidebar/Sidebar.js";
import type { ShellRooms } from "./rooms.js";

export function usePinToggles({ sidebar, topic, selected, routedSelection, topics }: ShellRooms) {
  /** Read the same synced sidebar document used by browser and MCP readers. */
  const sidebarGroups = useSidebar(sidebar);
  const pinTargets = topic === null ? (selected === null ? [] : [selected])
    : [topic.topic, ...topic.records.map((record) => record.uuid)];
  const pinnedRecords = sidebarGroups.flatMap((group) => group.docs).filter((uuid) => pinTargets.includes(uuid));
  const pinned = pinnedRecords.length > 0;
  const sidebarSelection = topic === null || (routedSelection !== null && pinnedRecords.includes(routedSelection))
    ? routedSelection
    : pinnedRecords[0] ?? topic.topic;
  /**
   * Pin membership is shared by header and listing actions; dragging owns
   * group and position. Recheck the synced writable sidebar at click time so
   * unseen groups or unpin levels cannot produce a wrong pin.
   */
  const onTogglePinDoc = useCallback(
    (uuid: string) => {
      if (
        sidebar === null ||
        !sidebar.status.writable ||
        !sidebar.status.synced
      ) {
        return;
      }
      const target = topics.find((candidate) => candidate.topic === uuid);
      const pins = readSidebar(sidebar.ydoc).flatMap((group) => group.docs)
        .filter((pinnedUuid) => target?.topic === pinnedUuid || target?.records.some((record) => record.uuid === pinnedUuid));
      if (pins.length === 0) togglePin(sidebar.ydoc, uuid);
      else sidebar.ydoc.transact(() => {
        for (const pinnedUuid of pins) unpinDoc(sidebar.ydoc, pinnedUuid);
      });
    },
    [sidebar, topics],
  );
  /** Header pinning follows the topic while its displayed answer changes. */
  const onTogglePin = useCallback(() => {
    if (topic === null) {
      if (selected !== null) onTogglePinDoc(selected);
      return;
    }
    onTogglePinDoc(topic.topic);
  }, [onTogglePinDoc, selected, topic]);

  return { sidebarGroups, pinned, sidebarSelection, onTogglePinDoc, onTogglePin };
}
