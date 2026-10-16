import { parseWorkspaceId } from "@uberblick/schema";
import type { LocalServing } from "../../config.js";
import { useAccessReading } from "./hub-administration.js";

/** Local workspaces have no roles; hub roles and own devices are independent. */
export function useSettingsAccess(workspace: string | null, serving: LocalServing | null,
  subject: string, path: string, ready: boolean, localFallback: boolean) {
  const role = useAccessReading(workspace, serving, subject, path, "own-role");
  const devices = useAccessReading(workspace, serving, subject, path, "list-devices");
  let bound = false;
  try { bound = serving?.workspace != null && parseWorkspaceId(serving.workspace).uuid === workspace && !serving.rebound; }
  catch { /* Invalid bindings grant no settings authority. */ }
  const local = ready && ((serving === null && localFallback) || (bound && serving !== null &&
    (serving.remoteHubUrl === null || role.authority?.status === "local-only")));
  return {
    workspaceAdmin: ready && (local || (bound && role.admin)),
    workspacePending: !ready || (bound && !local && role.authority === null),
    devicesAvailable: ready && bound && devices.authority?.status === "ok",
    devices: devices.authority,
    requestDevices: devices.request,
  };
}
