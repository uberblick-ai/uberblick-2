/** Live access management for the one workspace this `ub open` serves. */
import type { IncomingMessage } from "node:http";
import { readDeviceLogin, ensureDeviceLogin } from "@uberblick/hub/device-login";
import { ManagementResponseError, manageRequest, sanitizeManagementReply, type ManagementAction } from "@uberblick/hub/management-client";
import { authenticationOrigin } from "@uberblick/hub/remote-url";
import { readRequestAction } from "@uberblick/hub/token";

const MAX_INPUT_BYTES = 4096;
const INPUT_TIMEOUT_MS = 10_000;

export interface AccessBinding {
  workspaceId: string;
  /** Null is the project's local-only binding, not its implicit loopback hub. */
  hubUrl: string | null;
  env: NodeJS.ProcessEnv;
}

function readInput(request: IncomingMessage): Promise<string | null> {
  return new Promise(resolve => {
    const chunks: Buffer[] = [];
    let size = 0;
    const finish = (value: string | null) => {
      clearTimeout(timer);
      request.off("data", data);
      request.off("end", end);
      request.off("aborted", refused);
      request.off("error", refused);
      request.pause();
      resolve(value);
    };
    const data = (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_INPUT_BYTES) finish(null);
      else chunks.push(chunk);
    };
    const end = () => finish(Buffer.concat(chunks).toString("utf8"));
    const refused = () => finish(null);
    const timer = setTimeout(refused, INPUT_TIMEOUT_MS);
    timer.unref();
    request.on("data", data);
    request.once("end", end);
    request.once("aborted", refused);
    request.once("error", refused);
  });
}

/** Reuse the hub's target rules, with an exact and smaller local operation set. */
export async function readAccessAction(request: IncomingMessage): Promise<ManagementAction | null> {
  if (request.headers["content-type"]?.split(";")[0] !== "application/json") return null;
  if (Number(request.headers["content-length"] ?? 0) > MAX_INPUT_BYTES) return null;
  try {
    const input = await readInput(request);
    if (input === null) return null;
    const body: unknown = JSON.parse(input);
    if (body === null || typeof body !== "object" || Array.isArray(body)) return null;
    const fields = body as Record<string, unknown>;
    const action = readRequestAction(fields);
    if (action === null || action.operation === "renew-credential" || action.operation === "promote-workspace" ||
      Object.keys(fields).some(field => !Object.hasOwn(action, field))) return null;
    return action;
  } catch {
    return null;
  }
}

/** No access data is read from or written to the collaborative local store. */
export async function requestAccess(
  binding: AccessBinding,
  action: ManagementAction,
  signal: AbortSignal,
): Promise<{ status: number; body: Record<string, unknown> }> {
  // Check before selecting or contacting any upstream, even for local-only.
  if ("workspaceId" in action && action.workspaceId !== binding.workspaceId) {
    return { status: 403, body: { status: "workspace-mismatch" } };
  }
  if (binding.hubUrl === null) return { status: 200, body: { status: "local-only", hub: null } };
  const endpoint = binding.hubUrl;
  const origin = authenticationOrigin(endpoint);
  const reply = (status: number, body: Record<string, unknown>) => ({ status, body: { ...body, hub: origin } });
  const failure = (status: string) => reply(status === "update-required" ? 409 : status === "sign-in-required" ? 401 : 503, { status });
  try {
    let current = readDeviceLogin(endpoint, binding.workspaceId, binding.env);
    let login = current.status === "ready" ? current.login : null;
    // With no login, an empty proof performs no change and asks this bound hub
    // to distinguish missing sign-in, missing GitHub configuration and skew.
    let result = await manageRequest(origin, action, login, { signal });
    const rejected = result.status === 401 && result.body.status === "sign-in-required";
    const missingScope = result.status === 403 && result.body.status === "forbidden" &&
      login !== null && "workspaceId" in action && !login.credential.record.workspaces.includes(binding.workspaceId);
    if (login !== null && (rejected || missingScope)) {
      const ensured = await ensureDeviceLogin(endpoint, binding.workspaceId, {
        env: binding.env, ...(rejected ? { rejected: login } : {}), signal,
      });
      // A renewal may retain a valid account-scoped credential with no workspace.
      // Its cached failures are never a substitute for the live hub answer above.
      if (ensured.status === "ready" || ensured.status === "no-access") {
        current = readDeviceLogin(endpoint, binding.workspaceId, binding.env);
        if (current.status !== "ready") return failure(current.status);
        login = current.login;
        result = await manageRequest(origin, action, login, { signal });
      }
    }
    const safe = sanitizeManagementReply(action, result, login ?? undefined);
    return reply(safe.status, safe.body);
  } catch (error) {
    // Provider and JSON errors may hold proofs or credentials. Project only a
    // fixed outcome, including when the browser abandoned the request.
    return failure(error instanceof ManagementResponseError && error.updateRequired ? "update-required" : "hub-down");
  }
}
