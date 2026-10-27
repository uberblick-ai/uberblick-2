import { CommandPalette } from "../CommandPalette.js";
import { SidebarProvider } from "../shadcn/sidebar.js";
import { REPLICA_UNAVAILABLE_DETAIL, ReboundNotice, UpdateNotice } from "./ShellNotices.js";
import { ShellSidebar } from "./ShellSidebar.js";
import { ShellContent } from "./ShellContent.js";
import { ShellThreads } from "./ShellThreads.js";
import type { AppShell } from "./use-app-shell.js";

export function ShellFrame({ shell }: { shell: AppShell }) {
  const { workspace, startupServing } = shell.environment;
  const { allEntries, directoryStatus } = shell.rooms;
  const { documentSearch } = shell.environment;
  const { onSelect } = shell.navigation;
  const { onCreate } = shell;
  const { servingStatus } = shell.readings;
  const { collapsed, narrowLayout, sidebarOpen, setSidebarOpen, restoreSidebarFocus, sidebarHidden } = shell.layout;
  return (
    <main className="ub-app flex h-dvh flex-col">
      {workspace !== null && <CommandPalette key={workspace.uuid} entries={allEntries} searchClient={documentSearch ?? null}
        writable={directoryStatus.writable} onSelect={onSelect} onCreate={onCreate} />}
      <ReboundNotice serving={startupServing} />
      <UpdateNotice client={documentSearch} />
      {servingStatus?.replicaUnavailable && (
        <p className="ub-replica-unavailable" role="status">
          {REPLICA_UNAVAILABLE_DETAIL[servingStatus.replicaUnavailable]}
        </p>
      )}
      <SidebarProvider
        open={!collapsed}
        narrow={narrowLayout}
        openMobile={sidebarOpen}
        onOpenMobileChange={setSidebarOpen}
        onCloseAutoFocus={restoreSidebarFocus}
        className="ub-body"
        data-sidebar-collapsed={sidebarHidden}
      >
        <ShellSidebar shell={shell} />
        <ShellContent shell={shell} />
        <ShellThreads shell={shell} />
      </SidebarProvider>
    </main>
  );
}
