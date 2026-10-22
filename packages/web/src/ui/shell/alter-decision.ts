import { useCallback, useEffect, useRef, useState } from "react";
import { parseRoom, resolveDecisionTopics, roomForDoc } from "@uberblick/schema";
import type { DecisionTopicResolution } from "@uberblick/schema";
import { acquireRoom } from "../../collab/rooms.js";
import type { RoomConnection } from "../../collab/rooms.js";
import type { AwarenessUser } from "../../collab/identity.js";
import type { AlterDecisionSession, RecordedDecision } from "../document/AlterDecisionDialog.js";
import { docPath } from "../route.js";
import type { Navigate, Workspace } from "../route.js";

interface AlterDecisionOptions {
  doc: RoomConnection | null;
  directory: RoomConnection | null;
  catalog: RoomConnection | null;
  workspace: Workspace | null;
  topic: DecisionTopicResolution | null;
  defaultIdentity: AwarenessUser;
  navigate: Navigate;
}

/** Keep the dialog's source rooms and its result alive across page navigation. */
export function useAlterDecision({
  doc, directory, catalog, workspace, topic, defaultIdentity, navigate,
}: AlterDecisionOptions) {
  const [alterDecision, setAlterDecision] = useState<AlterDecisionSession | null>(null);
  const alteredResult = useRef<{ room: string; release(): void } | null>(null);
  useEffect(() => () => alterDecision?.release(), [alterDecision]);
  useEffect(() => () => alteredResult.current?.release(), []);
  useEffect(() => {
    const held = alteredResult.current;
    if (held === null || doc?.room !== held.room) return;
    alteredResult.current = null;
    held.release();
  }, [doc]);
  const openAlterDecision = useCallback(() => {
    if (doc === null || directory === null || catalog === null || workspace === null || topic === null ||
      !doc.status.writable || !doc.status.synced || !directory.status.writable || !directory.status.synced) return;
    const sourceUuid = parseRoom(doc.room).uuid;
    const fresh = resolveDecisionTopics(directory.ydoc).find((entry) => entry.topic === topic.topic);
    if (fresh === undefined || fresh.archived || fresh.inForce?.uuid !== sourceUuid) return;
    const sourceHandle = acquireRoom(doc.room, defaultIdentity, { presence: false });
    const directoryHandle = acquireRoom(directory.room, defaultIdentity, { presence: false });
    const catalogHandle = acquireRoom(catalog.room, defaultIdentity, { presence: false });
    const cancellation = new AbortController();
    setAlterDecision({
      source: sourceHandle.connection, directory: directoryHandle.connection,
      catalog: catalogHandle.connection, identity: defaultIdentity,
      topicPath: docPath(workspace.segment, topic.topic),
      segment: workspace.segment,
      cancellation,
      release: () => { cancellation.abort(); sourceHandle.release(); directoryHandle.release(); catalogHandle.release(); },
    });
  }, [doc, directory, catalog, workspace, topic, defaultIdentity]);
  const onDecisionRecorded = useCallback((result: RecordedDecision) => {
    if (alterDecision === null) { result.release(); return; }
    const sourceWorkspace = parseRoom(alterDecision.source.room).workspaceId;
    const target = result.rfc ?? result.decision;
    alteredResult.current?.release();
    alteredResult.current = { room: roomForDoc(sourceWorkspace, target), release: result.release };
    navigate(result.rfc === undefined ? alterDecision.topicPath : docPath(alterDecision.segment, result.rfc));
    setAlterDecision(null);
  }, [alterDecision, navigate]);
  const closeAlterDecision = useCallback(() => {
    alterDecision?.cancellation.abort();
    setAlterDecision(null);
  }, [alterDecision]);
  const onAlterDecisionOpenChange = useCallback((open: boolean) => {
    if (!open) closeAlterDecision();
  }, [closeAlterDecision]);
  return { alterDecision, openAlterDecision, onDecisionRecorded, closeAlterDecision, onAlterDecisionOpenChange };
}
