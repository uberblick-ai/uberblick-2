import { useMemo } from "react";
import { browserSignInRequired, configuredWorkspaces, defaultPresenceName, endpointLabel, hubEndpoint, localServing, servedWorkspaceNames } from "../../config.js";
import type { HubEndpoint } from "../../config.js";
import { randomIdentity } from "../../collab/identity.js";
import { createAccountClient } from "../../shell/account.js";
import { createDocumentSearchClient } from "../../shell/document-search.js";
import { createDocumentRevisionsClient } from "../../shell/document-revisions.js";
import { useHubEndpoint, useIdentity, useLocalSessionMissing, useSetting } from "../hooks.js";
import { parseRoute } from "../route.js";
import { useServingAccount } from "../status/serving-account.js";
import { useHubAdministration } from "../settings/hub-administration.js";
import { useSettingsAccess } from "../settings/settings-access.js";

export function useShellEnvironment(path: string) {
  // Wait for configuration before acquiring rooms: the first room fixes the
  // shared socket endpoint for the session, and this read also supplies the
  // workspace list.
  const hubReady = useHubEndpoint();
  // Rooms retain the default identity so clearing an override restores it,
  // without rebuilding their providers when the browser's name changes.
  const defaultIdentity = useIdentity(randomIdentity, hubReady ? defaultPresenceName() : null);
  const chosenName = useSetting("presenceName");
  const identity = useMemo(() => ({ ...defaultIdentity, name: chosenName ?? defaultIdentity.name }), [defaultIdentity, chosenName]);
  const configured = hubReady ? configuredWorkspaces() : [];
  const startupServing = hubReady ? localServing() : null;
  /** The one that answers `/`, the address that names no workspace. */
  const defaultWorkspace = configured[0] ?? null;
  const route = parseRoute(path, defaultWorkspace);
  const workspace = route.kind === "no-workspace" ? null : route.workspace;
  const workspaceUuid = workspace?.uuid ?? null;
  const serving = hubReady && workspaceUuid !== null ? localServing(workspaceUuid) : null;
  const remoteSignIn = hubReady && browserSignInRequired();
  const sessionMissing = useLocalSessionMissing(hubReady && servedWorkspaceNames() !== null);
  const roomReady = hubReady && !remoteSignIn;
  /** Which hub the room providers dial. */
  const endpoint = hubReady ? hubEndpoint() : null;
  /**
   * Which hub the document chrome names. A locally served page dials `ub open`
   * but reports the upstream named by the same configuration document; a
   * direct page keeps naming the endpoint it dials.
   */
  const statusEndpoint = useMemo<HubEndpoint | null>(
    () =>
      !hubReady
        ? null
        : serving === null
          ? endpoint
          : { url: serving.remoteHubUrl === null ? "local" : endpointLabel(serving.remoteHubUrl), source: "document" },
    [endpoint, hubReady, serving],
  );
  // The URL selects its workspace independently of the configured menu.
  // Document search needs ub open serving and a usable workspace.
  const documentSearch = useMemo(
    () =>
      !hubReady
        ? undefined
        : serving === null || workspaceUuid === null
          ? null
          : createDocumentSearchClient(workspaceUuid, identity.name),
    [hubReady, identity.name, serving, workspaceUuid],
  );
  const accountClient = useMemo(
    () => serving === null || workspaceUuid === null
      ? null
      : createAccountClient(workspaceUuid, identity.name),
    [identity.name, serving, workspaceUuid],
  );
  const account = useServingAccount(accountClient);
  const hubAdministration = useHubAdministration(workspaceUuid, serving, identity.name, path);
  const historyAvailable = hubAdministration.authority !== null && hubAdministration.authority.status !== "local-only";
  const documentRevisions = useMemo(
    () => serving === null || serving.remoteHubUrl === null || workspaceUuid === null || !historyAvailable
      ? null : createDocumentRevisionsClient(workspaceUuid, identity.name),
    [historyAvailable, identity.name, serving, workspaceUuid],
  );
  const settingsAccess = useSettingsAccess(workspaceUuid, serving, identity.name, path,
    hubReady && !remoteSignIn, startupServing === null);
  // Startup configuration may name an implicit loopback hub for a local-only
  // binding. The existing access reading distinguishes it from an upstream.
  let workspaceLocation: string | null = null;
  if (serving === null) {
    if (startupServing === null) workspaceLocation = endpoint?.url ?? null;
  } else if (serving.remoteHubUrl === null) {
    workspaceLocation = "local";
  } else if (!serving.rebound) {
    const authority = hubAdministration.authority;
    if (authority?.status === "local-only") workspaceLocation = "local";
    else if (authority?.hub != null) workspaceLocation = statusEndpoint?.url ?? null;
  }
  const settings = route.kind === "settings";
  const listing = route.kind === "all" || route.kind === "list";
  return { path, hubReady, defaultIdentity, identity, configured, startupServing, defaultWorkspace,
    route, workspace, workspaceUuid, serving, remoteSignIn, sessionMissing, roomReady, endpoint,
    statusEndpoint, documentSearch, documentRevisions, account, hubAdministration, settingsAccess, workspaceLocation, settings, listing };
}
export type ShellEnvironment = ReturnType<typeof useShellEnvironment>;
