import { HubSettings } from "../settings/HubSettings.js";
import { PreferencesSettings } from "../settings/PreferencesSettings.js";
import { DevicesSettings } from "../settings/DevicesSettings.js";
import { WorkspaceSettings } from "../settings/WorkspaceSettings.js";
import { DocumentList } from "../../shell/DocumentList.js";
import type { Route } from "../route.js";
import { ShellDocument } from "./ShellDocument.js";
import type { AppShell } from "./use-app-shell.js";

function SettingsContent({ shell, route }: { shell: AppShell; route: Extract<Route, { kind: "settings" }> }) {
  const { hubAdministration, identity, serving, settingsAccess, workspaceLocation, account, endpoint } = shell.environment;
  const { directory, catalog } = shell.rooms;
  const { agentSessions } = shell.readings;
  return (
  (route.page === "hub-admins" || route.page === "hub-workspaces") ? (
    <HubSettings key={`${route.workspace.uuid}:${route.page}`} page={route.page} administration={hubAdministration} />
  ) : route.page === "preferences" ? (
    <PreferencesSettings identity={identity} />
  ) : route.page === "devices" ? (
    <DevicesSettings key={`${route.workspace.uuid}:${serving?.remoteHubUrl ?? "local"}:${serving?.rebound === true}`}
      request={settingsAccess.requestDevices} initial={settingsAccess.devices} login={settingsAccess.deviceLogin} />
  ) : (
    <WorkspaceSettings
      admin={settingsAccess.workspaceAdmin}
      member={settingsAccess.workspaceMember}
      local={settingsAccess.local}
      key={route.workspace.uuid}
      page={route.page}
      workspace={route.workspace}
      workspaceLocation={workspaceLocation}
      serving={serving}
      subject={identity.name}
      verifiedHandle={account.state === "signed-in" ? account.handle : null}
      endpoint={endpoint}
      connection={directory}
      catalogConnection={catalog}
      agentSessions={agentSessions}
    />
  )
  );
}

function ListingContent({ shell }: { shell: AppShell }) {
  const { workspace, documentSearch } = shell.environment;
  const { directory, catalog, allEntries, sidebarStatus } = shell.rooms;
  const { sidebarGroups, onTogglePinDoc } = shell.pins;
  const { onSelect } = shell.navigation;
  const { documentListState, onDocumentListStateChange } = shell;
  return (
    /*
     * Shell state survives opening a topic and returning to the list.
     */
    <DocumentList
      key={workspace?.uuid}
      connection={directory}
      catalog={catalog}
      searchClient={documentSearch ?? null}
      entries={allEntries}
      groups={sidebarGroups}
      onSelect={onSelect}
      state={documentListState}
      onStateChange={onDocumentListStateChange}
      onTogglePin={
        sidebarStatus.writable && sidebarStatus.synced
          ? onTogglePinDoc
          : null
      }
    />
  );
}

export function ShellContent({ shell }: { shell: AppShell }) {
  const { route, listing } = shell.environment;
  if (route.kind === "settings") return <SettingsContent shell={shell} route={route} />;
  if (listing) return <ListingContent shell={shell} />;
  return <ShellDocument shell={shell} />;
}
