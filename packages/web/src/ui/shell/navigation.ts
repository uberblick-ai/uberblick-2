import { useCallback, useEffect, useMemo, useState } from "react";
import { servedWorkspaceNames } from "../../config.js";
import { createDocLinkContext } from "../../editor/doc-links.js";
import type { DocLinkContext } from "../../editor/doc-links.js";
import { allPath, canonicalPath, decisionRecordPath, docPath, parseRoute, settingsPath, workspaceList } from "../route.js";
import type { Navigate, SettingsPage } from "../route.js";
import { useWorkspaceNames } from "../workspace-names.js";
import type { ShellEnvironment } from "./environment.js";
import type { ShellRooms } from "./rooms.js";

export function useShellNavigation(env: ShellEnvironment, rooms: ShellRooms, navigate: Navigate, closeSidebarDrawer: () => void) {
  const { path, defaultWorkspace, configured, workspace, workspaceUuid, defaultIdentity, hubReady, route, settingsAccess } = env;
  const { topic, catalog, directory } = rooms;
  /**
   * Canonicalize the default route, trailing slash and document UUID case
   * while preserving the workspace spelling. Use replace so normalization
   * adds no Back entry.
   */
  useEffect(() => {
    const canonical = canonicalPath(parseRoute(path, defaultWorkspace));
    if (canonical !== null && canonical !== path) navigate(canonical, "replace");
  }, [path, navigate, defaultWorkspace]);

  // An archived answer keeps its explicit selection when it is restored.
  useEffect(() => {
    if (route.kind !== "doc" || topic === null || route.uuid === topic.topic ||
      !topic.archivedRecords.some((record) => record.uuid === route.uuid)) return;
    navigate(decisionRecordPath(route.workspace.segment, topic.topic, route.uuid), "replace");
  }, [route, topic, navigate]);

  /**
   * parseRoute rebuilds workspace each render; splitting its short segment
   * here avoids a memo with an always-changing dependency.
   */
  const workspaces = workspaceList(configured, workspace);
  const [workspaceMenuOpen, setWorkspaceMenuOpen] = useState(false);
  const workspaceNames = useWorkspaceNames(workspaces, workspaceUuid, catalog, defaultIdentity, workspaceMenuOpen,
    hubReady ? servedWorkspaceNames() : null);
  const onSwitchWorkspace = useCallback(
    // A workspace's list, not a document: two corpora share no uuid, so
    // carrying the open document across would be a link to nowhere.
    (segment: string) => {
      closeSidebarDrawer();
      navigate(`/${segment}`);
    },
    [closeSidebarDrawer, navigate],
  );

  /** Opening a document is navigating to it. There is nothing else to update. */
  const segment = workspace?.segment ?? null;
  const onSelect = useCallback(
    (uuid: string) => {
      closeSidebarDrawer();
      if (segment !== null) navigate(docPath(segment, uuid));
    },
    [closeSidebarDrawer, navigate, segment],
  );

  /**
   * References derive addresses from the current workspace, titles and
   * lifecycle from the directory, and navigation from onSelect without
   * joining target rooms. Keep this object stable: replacing it rebinds the
   * editor under the caret.
   */
  const docLinks = useMemo<DocLinkContext | null>(
    () =>
      segment === null
        ? null
        : createDocLinkContext({
            directory: directory?.ydoc ?? null,
            href: (uuid) => docPath(segment, uuid),
            open: onSelect,
          }),
    [directory, onSelect, segment],
  );

  /** Going to the listing is navigating to it, like opening a document. */
  const onOpenAll = useCallback(() => {
    closeSidebarDrawer();
    if (segment !== null) navigate(allPath(segment));
  }, [closeSidebarDrawer, navigate, segment]);

  /** Enter settings, or leave it for the workspace's fixed list address. */
  const onOpenSettings = useCallback((page: SettingsPage) => {
    closeSidebarDrawer();
    if (segment !== null) navigate(settingsPath(segment, page));
  }, [closeSidebarDrawer, navigate, segment]);
  const onBackToWorkspace = useCallback(() => {
    closeSidebarDrawer();
    if (segment !== null) navigate(`/${segment}`);
  }, [closeSidebarDrawer, navigate, segment]);

  const workspaceSettingsPage = route.kind === "settings" &&
    (route.page === "general" || route.page === "tags" || route.page === "members");
  useEffect(() => {
    if (workspaceSettingsPage && !settingsAccess.workspacePending && !settingsAccess.workspaceAdmin && segment !== null) {
      navigate(settingsPath(segment, "preferences"), "replace");
    }
  }, [navigate, segment, settingsAccess.workspaceAdmin, settingsAccess.workspacePending, workspaceSettingsPage]);

  return { workspaces, workspaceNames, setWorkspaceMenuOpen, onSwitchWorkspace, onSelect, docLinks, onOpenAll, onOpenSettings, onBackToWorkspace };
}
