/** Hub authority is read live, independently of the open workspace's membership. */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { parseWorkspaceId } from "@uberblick/schema";
import type { LocalServing } from "../../config.js";
import { createWorkspaceAccessClient } from "../../shell/workspace-access.js";
import type { AccessAction, AccessAnswer } from "../../shell/workspace-access.js";
import { SERVING_STATUS_POLL_MS, SERVING_STATUS_TIMEOUT_MS } from "../status/serving-status.js";

export interface HubAdministration {
  authority: AccessAnswer | null;
  admin: boolean;
  request: (action: AccessAction, signal: AbortSignal) => Promise<AccessAnswer>;
}

function boundWorkspace(serving: LocalServing | null): string | null {
  if (serving?.workspace === null || serving?.workspace === undefined ||
    serving.remoteHubUrl === null || serving.rebound) return null;
  try { return parseWorkspaceId(serving.workspace).uuid; }
  catch { return null; }
}

/** Independent live readings share lifecycle mechanics, never permission results. */
export function useAccessReading(workspace: string | null, serving: LocalServing | null,
  subject: string, path: string, operation: "own-hub-role" | "own-role" | "list-devices", account: string | null = null): HubAdministration {
  const available = workspace !== null && boundWorkspace(serving) === workspace;
  const binding = serving?.remoteHubUrl;
  const client = useMemo(() => available && workspace !== null
    ? { send: createWorkspaceAccessClient(workspace, subject), binding, account } : null, [available, binding, subject, workspace, account]);
  const revision = useRef(0);
  const [answer, setAnswer] = useState<{ client: NonNullable<typeof client>; authority: AccessAnswer } | null>(null);
  const request = useCallback(async (action: AccessAction, signal: AbortSignal): Promise<AccessAnswer> => {
    if (action.operation !== operation) revision.current += 1;
    let result: AccessAnswer;
    try { result = client === null ? { status: "local-only", hub: null } : await client.send(action, signal); }
    catch { result = { status: "hub-down", hub: null }; }
    if (action.operation !== operation) revision.current += 1;
    if (!signal.aborted && client !== null && action.operation !== operation &&
      result.status !== "ok" && ["forbidden", "sign-in-required", "local-only"].includes(result.status)) {
      setAnswer({ client, authority: result });
    }
    return result;
  }, [client, operation]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: Navigation rereads current hub authority even when the bound client stays the same.
  useEffect(() => {
    if (client === null || workspace === null) return;
    let active = true;
    let controller: AbortController | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = async (): Promise<void> => {
      if (timer !== undefined) clearTimeout(timer);
      controller?.abort();
      const currentController = new AbortController();
      controller = currentController;
      const signal = currentController.signal;
      const currentRevision = ++revision.current;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      let timedOut = false;
      let authority: AccessAnswer;
      try {
        const expired = new Promise<AccessAnswer>((resolve) => {
          timeout = setTimeout(() => {
            timedOut = true;
            currentController.abort();
            resolve({ status: "hub-down", hub: null });
          }, SERVING_STATUS_TIMEOUT_MS);
        });
        const action: AccessAction = operation === "own-role"
          ? { operation, workspaceId: workspace } : { operation };
        authority = await Promise.race([request(action, signal), expired]);
      } finally { if (timeout !== undefined) clearTimeout(timeout); }
      if (active && (!signal.aborted || timedOut) && revision.current === currentRevision) {
        // A later outage cannot make a known revoked login signed in again.
        setAnswer(previous => ({ client, authority: operation === "list-devices" && authority.status !== "ok" &&
          previous?.client === client && ["sign-in-required", "forbidden"].includes(previous.authority.status)
          ? previous.authority : authority }));
      }
      if (active && controller === currentController) timer = setTimeout(() => { void read(); }, SERVING_STATUS_POLL_MS);
    };
    const onFocus = (): void => { void read(); };
    const onVisibility = (): void => { if (document.visibilityState === "visible") void read(); };
    void read();
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      active = false;
      if (timer !== undefined) clearTimeout(timer);
      controller?.abort();
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [client, operation, path, request, workspace]);

  const authority: AccessAnswer | null = client === null ? { status: "local-only", hub: null }
    : answer?.client === client ? answer.authority : null;
  return { authority, admin: authority?.status === "ok" && authority.role === "admin", request };
}

export function useHubAdministration(workspace: string | null, serving: LocalServing | null,
  subject: string, path: string): HubAdministration {
  return useAccessReading(workspace, serving, subject, path, "own-hub-role");
}
