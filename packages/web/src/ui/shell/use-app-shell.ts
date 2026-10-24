import { useRef } from "react";
import { INITIAL_DOCUMENT_LIST_STATE } from "../../shell/DocumentList.js";
import type { DocumentListState } from "../../shell/DocumentList.js";
import { useRoutePath } from "../route.js";
import { useShellEnvironment } from "./environment.js";
import { useShellLayout } from "./layout.js";
import { useShellRooms } from "./rooms.js";
import { useAlterDecision } from "./alter-decision.js";
import { usePinToggles } from "./pins.js";
import { useArchive } from "./archive.js";
import { useThreadsRail } from "./threads.js";
import { useDocumentStubRepair, useShellReadings, useSyncDetails } from "./readings.js";
import { useShellNavigation } from "./navigation.js";
import { useCreateDocument } from "./create-document.js";
import { useDocumentHistory } from "../document/document-history.js";
import { rememberRevisionHeader } from "../document/revision-motion.js";

export function useAppShell() {
  const [path, navigate, documentList, onDocumentListStateChange] = useRoutePath<DocumentListState>();
  const environment = useShellEnvironment(path);
  const layout = useShellLayout(environment.settings);
  const sync = useSyncDetails(environment.route.kind);
  const rooms = useShellRooms(environment);
  const readings = useShellReadings(environment, rooms);
  const decisionPage = environment.route.kind === "decision" || rooms.topic !== null || readings.meta?.kind === "decision";
  const history = useDocumentHistory(decisionPage ? null : environment.documentRevisions, rooms.selected, path);
  const historyBack = useRef<HTMLButtonElement | null>(null);
  const alter = useAlterDecision({ ...rooms, ...environment, navigate });
  const pins = usePinToggles(rooms);
  const archive = useArchive({ ...rooms, ...environment, navigate });
  const threads = useThreadsRail(rooms.doc);
  const navigation = useShellNavigation(environment, rooms, navigate, layout.closeSidebarDrawer);
  const onCreate = useCreateDocument({ ...rooms, ...environment, ...navigation });
  useDocumentStubRepair(rooms);
  const documentListState = documentList ?? INITIAL_DOCUMENT_LIST_STATE;
  const displayedHistory = { ...history, now: () => { rememberRevisionHeader(historyBack.current); history.now(); } };
  return { environment, layout, sync, rooms, history: displayedHistory, historyBack, alter, pins, archive, threads, readings,
    navigation, onCreate, navigate, documentListState, onDocumentListStateChange };
}
export type AppShell = ReturnType<typeof useAppShell>;
