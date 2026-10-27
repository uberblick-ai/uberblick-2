import { Sidebar } from "../sidebar/Sidebar.js";
import { HistorySidebar } from "../sidebar/HistorySidebar.js";
import { SIDEBAR_TOGGLE_CLASSES } from "../shadcn/sidebar.js";
import { Button } from "../shadcn/button.js";
import type { AppShell } from "./use-app-shell.js";

export function ShellSidebar({ shell }: { shell: AppShell }) {
  const { workspace, workspaceLocation, serving, account, listing, settings, route, hubAdministration, settingsAccess } = shell.environment;
  const { narrowLayout, collapsed, sidebarOpen, setSidebarOpen, setCollapsed, restoreSidebar, hideSidebar, sidebarName, sidebarCloseLabel, closeSidebarDrawer } = shell.layout;
  const { directory, sidebar } = shell.rooms;
  const { sidebarGroups, sidebarSelection } = shell.pins;
  const { workspaces, workspaceNames, setWorkspaceMenuOpen, onSwitchWorkspace, onSelect, onOpenAll, onOpenSettings, onBackToWorkspace } = shell.navigation;
  const { servingStatus, meta } = shell.readings;
  const { onCreate } = shell;
  const historyOpen = shell.history.active && !shell.rooms.deleted;
  return <>
    {(narrowLayout || collapsed) && (
      /* Pane-local and out of flow: restoring the sidebar costs no global
         row and leaves every route at the application's top edge. */
      <Button variant="plain" size="custom"
        ref={restoreSidebar}
        type="button"
        className={`${SIDEBAR_TOGGLE_CLASSES} ub-sidebar-toggle ub-sidebar-restore top-2 left-2 border-(--border) bg-(--card-accent) text-(--secondary-foreground)`}
        aria-expanded={narrowLayout ? sidebarOpen : false}
        aria-label={`Show ${sidebarName}`}
        title={`Show ${sidebarName}`}
        onClick={() => narrowLayout ? setSidebarOpen(true) : setCollapsed(false)}
      >
        »
      </Button>
    )}
    <Sidebar
      collapsed={narrowLayout ? false : collapsed}
      collapseButtonRef={hideSidebar}
      collapseLabel={sidebarCloseLabel}
      onCollapse={() => narrowLayout ? closeSidebarDrawer() : setCollapsed(true)}
      connection={directory}
      sidebar={sidebar}
      groups={sidebarGroups}
      workspaces={workspaces}
      workspace={workspace}
      workspaceNames={workspaceNames}
      workspaceLocation={workspaceLocation}
      hubAcked={serving === null ? undefined : servingStatus?.hubAcked ?? null}
      notSharedReason={servingStatus?.notSharedReason ?? null}
      onWorkspaceMenuOpenChange={setWorkspaceMenuOpen}
      onSwitchWorkspace={onSwitchWorkspace}
      account={servingStatus?.notSharedReason ? { state: "unavailable" } : account}
      selected={sidebarSelection}
      onSelect={onSelect}
      onCreate={onCreate}
      onOpenAll={onOpenAll}
      onOpenSettings={onOpenSettings}
      onBackToWorkspace={onBackToWorkspace}
      allOpen={listing}
      settingsOpen={settings}
      settingsPage={route.kind === "settings" ? route.page : null}
      hubAdmin={hubAdministration.admin}
      workspaceAdmin={settingsAccess.workspaceAdmin}
      workspaceMember={settingsAccess.workspaceMember}
      devicesAvailable={settingsAccess.devicesAvailable}
      historyPane={historyOpen ? <HistorySidebar history={shell.history} title={meta?.title ?? ""} onNow={() => {
        if (narrowLayout && sidebarOpen) closeSidebarDrawer(shell.historyBack.current);
        shell.history.now();
      }} /> : null}
    />
  </>;
}
