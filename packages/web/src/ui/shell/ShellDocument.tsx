import { Popover, PopoverContent } from "../shadcn/popover.js";
import { SyncPanel } from "../status/SyncPanel.js";
import { documentPaneState, RoutePane } from "./RoutePane.js";
import type { AppShell } from "./use-app-shell.js";
import { HistoryControls, RevisionPane } from "../document/RevisionPane.js";

function documentActions(shell: AppShell) {
  const { selected, topic, sidebarStatus, directoryStatus, doc } = shell.rooms;
  const { selectedDirectoryEntry, archived } = shell.readings;
  const { pinned, onTogglePin } = shell.pins;
  const { onArchive, onRestore, onDelete, onArchiveConfirmationFocusChange, restoreFocusRoom, archiveConfirmationFocusRoom, onRestoreFocused } = shell.archive;
  return {
    pinned,
    onTogglePin: sidebarStatus.writable && sidebarStatus.synced && selected !== null ? onTogglePin : null,
    onArchive: selectedDirectoryEntry != null && !archived && directoryStatus.writable && sidebarStatus.writable && sidebarStatus.synced ? onArchive : null,
    showArchiveRecord: topic !== null && topic.records.length >= 2,
    archiveRecordUnavailable: topic?.inForce?.uuid === selected
      ? "Archive this record unavailable — it is the decision in force"
      : topic?.conflicts.some((record) => record.uuid === selected)
        ? "Archive this record unavailable — it is a conflicting answer" : null,
    onArchiveRecord: !archived && directoryStatus.writable && sidebarStatus.writable && sidebarStatus.synced ? () => onArchive(true) : null,
    onArchiveConfirmationFocusChange,
    focusRestore: doc !== null && (restoreFocusRoom.current === doc.room || archiveConfirmationFocusRoom.current === doc.room),
    onRestoreFocused,
    onRestore: directoryStatus.writable ? onRestore : null,
    onDelete: directoryStatus.writable ? onDelete : null,
  };
}

export function ShellDocument({ shell }: { shell: AppShell }) {
  const { route, hubReady, statusEndpoint, serving, identity } = shell.environment;
  const { topic, selected, directory, doc, docStatus, topicTitleRoom, catalog, deleted } = shell.rooms;
  const { openAlterDecision } = shell.alter;
  const { relatedTopics, titlePresence, servingStatus, meta, archived, selectedDirectoryEntry, chromeRoom } = shell.readings;
  const { navigate } = shell;
  const { docLinks } = shell.navigation;
  const { onFocusThread, threads, threadsOpen, onToggleThreads } = shell.threads;
  const { syncOpen, setSyncOpen } = shell.sync;
  const lastUpdated = !deleted && documentPaneState({
    route, connection: doc, meta, topic, selectedUuid: selected, navigate,
  }, docStatus.hasAnswered) === "shown" ? selectedDirectoryEntry?.updatedAt : undefined;
  return (
    <Popover open={syncOpen} onOpenChange={setSyncOpen}>
      <div className={shell.history.active ? "hidden" : "contents"} inert={shell.history.active}>
      <RoutePane
        route={route}
        topic={topic}
        selectedUuid={selected}
        navigate={navigate}
        directoryConnection={directory}
        titleConnection={topic?.topic === selected ? doc : topicTitleRoom}
        onAlterDecision={openAlterDecision}
        relatedTopics={relatedTopics}
        configured={hubReady}
        connection={doc}
        presence={titlePresence}
        syncReading={{
          endpoint: statusEndpoint,
          hubAcked: serving === null ? undefined : servingStatus?.hubAcked ?? null,
          rawHubAcked: serving === null ? undefined : servingStatus?.rawHubAcked ?? null,
          sampledAt: servingStatus?.sampledAt,
          notSharedReason: servingStatus?.notSharedReason ?? null,
          syncDetails: true,
        }}
        meta={meta}
        author={identity.name}
        catalogConnection={catalog}
        archived={archived}
        deleted={deleted}
        updatedAt={selectedDirectoryEntry?.updatedAt}
        docLinks={docLinks}
        actions={documentActions(shell)}
        onSelectThread={onFocusThread}
        threads={threads}
        threadsOpen={threadsOpen}
        onToggleThreads={onToggleThreads}
        historyControl={<HistoryControls history={shell.history} />}
        historyActive={shell.history.active}
      />
      </div>
      {!deleted && shell.history.active && <RevisionPane history={shell.history} docLinks={docLinks} workspaceSettings={catalog?.ydoc ?? null} />}
      {!deleted && !shell.history.active && (route.kind === "doc" || route.kind === "decision") && (
        <PopoverContent
          align="start"
          collisionPadding={8}
          aria-label="Sync details"
          className="ub-sync-panel w-[min(22rem,calc(100vw_-_1rem))]! max-h-[min(calc(100dvh_-_1rem),var(--radix-popover-content-available-height))] overflow-y-auto"
        >
          <SyncPanel
            connection={chromeRoom}
            endpoint={statusEndpoint}
            hubAcked={serving === null ? undefined : servingStatus?.hubAcked ?? null}
            notSharedReason={servingStatus?.notSharedReason ?? null}
            lastUpdated={lastUpdated}
          />
        </PopoverContent>
      )}
    </Popover>
  );
}
