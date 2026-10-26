import { ThreadsPane } from "../comments/ThreadsPane.js";
import type { AppShell } from "./use-app-shell.js";
import { isDirectoryEntryArchived, parseRoom } from "@uberblick/schema";

export function ShellThreads({ shell }: { shell: AppShell }) {
  const { doc, docStatus, topic, catalog, directory, deleted } = shell.rooms;
  const { archived, meta } = shell.readings;
  const { identity, account } = shell.environment;
  const { narrowLayout } = shell.layout;
  const { threads, focusedThread, threadsOpen, onFocusThread, setThreadsOpen, restoreThreadsFocus } = shell.threads;
  return <>
    {/* Every open document keeps its threads column, before the first comment too. */}
    {doc !== null && !deleted && (
      <div
        inert={shell.history.active}
        style={shell.history.active ? { display: "none" } : undefined}
        className="ub-document-rail flex min-h-0 w-[var(--document-rail-width)] flex-none flex-col border-l border-border me-[var(--pane-trailing-space)] max-xl:absolute max-xl:inset-x-0 max-xl:top-0 max-xl:w-auto max-xl:border-0 max-xl:me-0 max-xl:pointer-events-none"
      >
        {/* Draft state survives the sheet's unmount and resize. */}
        <ThreadsPane
          connection={doc}
          catalogConnection={catalog}
          canCleanupTags={() => directory !== null && doc.status.writable && !isDirectoryEntryArchived(directory.ydoc, parseRoom(doc.room).uuid)}
          threads={threads}
          focused={focusedThread}
          author={identity.name}
          account={account}
          docLinks={shell.navigation.docLinks}
          openDocId={parseRoom(doc.room).uuid}
          readOnly={archived || !docStatus.writable || (meta?.kind === "decision" && (topic === null || topic.first === null))}
          onFocus={onFocusThread}
          narrow={narrowLayout}
          open={threadsOpen}
          hidden={shell.history.active}
          onOpenChange={setThreadsOpen}
          onCloseAutoFocus={restoreThreadsFocus}
        />
      </div>
    )}
  </>;
}
