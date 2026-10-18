import { parseWorkspaceId } from "@uberblick/schema";
import { useEffect, useMemo, useState } from "react";
import type { LocalServing } from "../../config.js";
import { createDeviceLoginClient } from "../../shell/account.js";
import { useServingAccount } from "../status/serving-account.js";
import { useAccessReading } from "./hub-administration.js";

/** Local workspaces have no roles; hub roles and own devices are independent. */
export function useSettingsAccess(workspace: string | null, serving: LocalServing | null,
  subject: string, path: string, ready: boolean, localFallback: boolean) {
  const devices = useAccessReading(workspace, serving, subject, path, "list-devices");
  let bound = false;
  try { bound = serving?.workspace != null && parseWorkspaceId(serving.workspace).uuid === workspace && !serving.rebound; }
  catch { /* Invalid bindings grant no settings authority. */ }
  const hub = serving?.remoteHubUrl;
  const loginClient = useMemo(() => bound && hub != null && workspace !== null
    ? createDeviceLoginClient(workspace, subject) : null, [bound, hub, subject, workspace]);
  const login = useServingAccount(loginClient);
  const handle = login.state === "signed-in" ? login.handle : null;
  const role = useAccessReading(workspace, serving, subject, path, "own-role", handle);
  const refusedLogin = devices.authority?.status === "sign-in-required" || devices.authority?.status === "forbidden";
  const cacheKey = bound && hub != null && handle !== null
    ? `uberblick:settings-admin:${JSON.stringify([hub, workspace, handle.toLowerCase()])}` : null;
  const storedAdmin = useMemo(() => {
    try { return cacheKey !== null && localStorage.getItem(cacheKey) === "true"; }
    catch { return false; }
  }, [cacheKey]);
  const [confirmed, setConfirmed] = useState<{ key: string; admin: boolean } | null>(null);
  useEffect(() => {
    if (cacheKey === null || (!refusedLogin && (role.authority === null || role.authority.status === "hub-down"))) return;
    const admin = role.admin && !refusedLogin;
    setConfirmed({ key: cacheKey, admin });
    try {
      if (admin) localStorage.setItem(cacheKey, "true");
      else localStorage.removeItem(cacheKey);
    } catch { /* A confirmed role remains available for this page without browser storage. */ }
  }, [cacheKey, refusedLogin, role.admin, role.authority]);
  const lastAdmin = confirmed?.key === cacheKey ? confirmed.admin : storedAdmin;
  const offlineAdmin = role.authority?.status === "hub-down" && !refusedLogin && lastAdmin;
  const local = ready && ((serving === null && localFallback) || (bound && serving !== null &&
    (serving.remoteHubUrl === null || role.authority?.status === "local-only")));
  return {
    local,
    workspaceAdmin: ready && (local || (bound && (role.admin || (handle !== null && offlineAdmin)))),
    workspacePending: !ready || (bound && !local && (role.authority === null ||
      (role.authority.status === "hub-down" && login.state === "unavailable"))),
    devicesAvailable: ready && bound && !local && !refusedLogin && login.state === "signed-in",
    deviceLogin: ready && bound && !local && hub != null && login.state === "signed-in"
      ? { handle: login.handle, hub } : null,
    devices: devices.authority,
    requestDevices: devices.request,
  };
}
