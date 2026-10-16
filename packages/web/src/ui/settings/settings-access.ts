import { parseWorkspaceId } from "@uberblick/schema";
import { useMemo } from "react";
import type { LocalServing } from "../../config.js";
import { createDeviceLoginClient } from "../../shell/account.js";
import { useServingAccount } from "../status/serving-account.js";
import { useAccessReading } from "./hub-administration.js";

/** Local workspaces have no roles; hub roles and own devices are independent. */
export function useSettingsAccess(workspace: string | null, serving: LocalServing | null,
  subject: string, path: string, ready: boolean, localFallback: boolean) {
  const role = useAccessReading(workspace, serving, subject, path, "own-role");
  const devices = useAccessReading(workspace, serving, subject, path, "list-devices");
  let bound = false;
  try { bound = serving?.workspace != null && parseWorkspaceId(serving.workspace).uuid === workspace && !serving.rebound; }
  catch { /* Invalid bindings grant no settings authority. */ }
  const hub = serving?.remoteHubUrl;
  const loginClient = useMemo(() => bound && hub != null && workspace !== null
    ? createDeviceLoginClient(workspace, subject) : null, [bound, hub, subject, workspace]);
  const login = useServingAccount(loginClient);
  const refusedLogin = devices.authority?.status === "sign-in-required" || devices.authority?.status === "forbidden";
  const local = ready && ((serving === null && localFallback) || (bound && serving !== null &&
    (serving.remoteHubUrl === null || role.authority?.status === "local-only")));
  return {
    workspaceAdmin: ready && (local || (bound && role.admin)),
    workspacePending: !ready || (bound && !local && role.authority === null),
    devicesAvailable: ready && bound && !local && !refusedLogin && login.state === "signed-in",
    deviceLogin: ready && bound && !local && hub != null && login.state === "signed-in"
      ? { handle: login.handle, hub } : null,
    devices: devices.authority,
    requestDevices: devices.request,
  };
}
