import { useEffect, useMemo } from "react";
import { directoryRoom, getDirectoryEntry, isDirectoryEntryDeleted, decisionCurrentRecord, migrateRetiredTagCatalogEntries, resolveDecisionTopics, roomForDoc, settingsRoom, sidebarRoom } from "@uberblick/schema";
import type { DecisionTopicResolution } from "@uberblick/schema";
import type { RoomConnection } from "../../collab/rooms.js";
import { useDirectory, useRoom, useRoomStatus } from "../hooks.js";
import type { Route } from "../route.js";
import type { ShellEnvironment } from "./environment.js";

function resolveSelection(route: Route, topics: DecisionTopicResolution[], directory: RoomConnection | null, routedSelection: string | null) {
  const topic = route.kind === "decision"
    ? topics.find((candidate) => candidate.topic === route.topic) ?? null
    : route.kind === "doc"
      ? topics.find((candidate) => candidate.allRecords.some((record) => record.uuid === route.uuid)) ?? null
      : null;
  const candidateSelection = directory === null ? null : topic === null ? (route.kind === "decision" ? null : routedSelection)
    : route.kind === "decision"
      ? topic.allRecords.find((record) => record.uuid === route.record)?.uuid ?? null
      : route.kind === "doc" && route.uuid !== topic.topic && topic.archivedRecords.some((record) => record.uuid === route.uuid)
        ? route.uuid : decisionCurrentRecord(topic)?.uuid ?? null;
  const selected = directory !== null && candidateSelection !== null &&
    isDirectoryEntryDeleted(directory.ydoc, candidateSelection)
    ? null : candidateSelection;
  return { topic, selected };
}

function resolveTitle(route: Route, topic: DecisionTopicResolution | null, directory: RoomConnection | null) {
  if (directory === null) return null;
  const routedTitleUuid = route.kind === "decision" ? route.topic : route.kind === "doc" ? route.uuid : null;
  if (directory !== null && routedTitleUuid !== null && isDirectoryEntryDeleted(directory.ydoc, routedTitleUuid)) return null;
  const routedTitleEntry = directory === null || routedTitleUuid === null ? null : getDirectoryEntry(directory.ydoc, routedTitleUuid);
  const titleUuid = topic?.topic ?? (routedTitleEntry === null || routedTitleEntry.kind === "decision" ? routedTitleUuid : null);
  return titleUuid;
}

export function useShellRooms({ roomReady, workspace, defaultIdentity, route, serving }: ShellEnvironment) {
  const routedSelection = route.kind === "doc" ? route.uuid : route.kind === "decision" ? route.record : null;
  const directory = useRoom(
    roomReady && workspace !== null ? directoryRoom(workspace.uuid) : null,
    defaultIdentity,
  );
  const allEntries = useDirectory(directory, true);
  // The observer can lag a newly acquired directory by one effect. Resolve
  // its synchronous seed too, so a known record link joins only the answer.
  const topics = useMemo(() => resolveDecisionTopics(
    allEntries.length === 0 && directory !== null ? directory.ydoc : allEntries,
  ), [allEntries, directory]);
  const { topic, selected } = resolveSelection(route, topics, directory, routedSelection);
  const doc = useRoom(
    roomReady && workspace !== null && selected !== null
      ? roomForDoc(workspace.uuid, selected)
      : null,
    defaultIdentity,
  );
  // Keep the first room alive across directory arrival and answer selection;
  // switching its title/answer holders must not detach and immediately rejoin it.
  const titleUuid = resolveTitle(route, topic, directory);
  const topicTitleRoom = useRoom(
    roomReady && workspace !== null && titleUuid !== null ? roomForDoc(workspace.uuid, titleUuid) : null,
    defaultIdentity,
    false,
  );
  const sidebar = useRoom(
    roomReady && workspace !== null ? sidebarRoom(workspace.uuid) : null,
    defaultIdentity,
  );
  const catalog = useRoom(
    roomReady &&
      workspace !== null
      ? settingsRoom(workspace.uuid)
      : null,
    defaultIdentity,
  );
  const directoryStatus = useRoomStatus(directory);
  const docStatus = useRoomStatus(doc);
  const sidebarStatus = useRoomStatus(sidebar);
  const catalogStatus = useRoomStatus(catalog);
  useEffect(() => {
    // A locally served browser has only the engine's cache; the engine waits
    // for its upstream catalog before migrating. Direct hub admission owns
    // this browser's settings authority and initial-state boundary.
    if (serving === null && catalog !== null && catalogStatus.writable && catalogStatus.hasReceivedServerState) {
      migrateRetiredTagCatalogEntries(catalog.ydoc);
    }
  }, [serving, catalog, catalogStatus.writable, catalogStatus.hasReceivedServerState]);
  const deleted = docStatus.deleted === true || (directory !== null && routedSelection !== null &&
    isDirectoryEntryDeleted(directory.ydoc, routedSelection));
  return { directory, allEntries, topics, topic, selected, routedSelection, doc, topicTitleRoom,
    sidebar, catalog, directoryStatus, docStatus, sidebarStatus, deleted };
}
export type ShellRooms = ReturnType<typeof useShellRooms>;
