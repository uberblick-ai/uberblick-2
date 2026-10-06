import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { ensureDeviceLogin, readDeviceLogin } from "@uberblick/hub/device-login";
import type { StoredHubLogin } from "@uberblick/hub/auth-store";
import { authenticationOrigin, normalizeRemoteUrl } from "@uberblick/hub/remote-url";
import { resolveStorage } from "@uberblick/hub/storage";
import { syncWorkspace } from "@uberblick/mcp-server";
import { parseWorkspaceId } from "@uberblick/schema";
import { ManagementResponseError, manageRequest } from "./access-management.js";
import { authCommand } from "./auth.js";
import { bridgeConfig, resolveMcpConfig } from "./budget.js";
import { requireBinding, resolveConfig, writeHubAdmission } from "./config.js";
import { takeHelp } from "./help.js";
import { acquireInitLock } from "./init-lock.js";
import type { Io } from "./io.js";
import { resolveProjectBinding, writeProjectBinding } from "./project-binding.js";
import { corpusProblem, verify } from "./remote.js";
import { publishOwnerOnly } from "./safe-write.js";
import { reportWorkspacePins } from "./workspace-create.js";

export const WORKSPACE_PROMOTE_HELP = `usage: ub workspace promote <hub>

Share the selected local-only workspace on a GitHub-enabled hub. Reuse this
machine's working login, or ask for GitHub approval. Your account must currently
be a member or administrator of at least one workspace on that hub. On a fresh
hub, its first login claims the default workspace and qualifies.

The hub can be a bare host, an HTTP(S) URL or a WS(S) endpoint. Bare hosts and
HTTP(S) URLs without a path use /ws; WS(S) endpoints keep their supplied path.

examples:
  ub workspace promote https://hub.example.com
  ub workspace promote wss://hub.example.com/ws

Upload the same workspace UUID and history, including archived documents, name
and sidebar. Bind this project only after a fresh client verifies the upload.
After failure or interruption, rerun this command to resume the same attempt.
Close other clients while promoting. A workspace already bound to a hub cannot
be promoted. No host setup or separate join is needed.

options:
  -h, --help        show this help
`;

function bindingBytes(path: string): string | null {
  try { return readFileSync(path, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}

/** Saved before the first request; a lost response must not lose the attempt. */
function promotionAttempt(path: string): string {
  if (existsSync(path)) {
    let value: unknown;
    try { value = JSON.parse(readFileSync(path, "utf8")); } catch { throw new Error("cannot read saved promotion attempt"); }
    if (value === null || typeof value !== "object" || !("attemptId" in value) ||
      typeof value.attemptId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value.attemptId)) {
      throw new Error("invalid saved promotion attempt; restore its original receipt before retrying");
    }
    return value.attemptId;
  }
  const attemptId = randomUUID();
  publishOwnerOnly(path, `${JSON.stringify({ attemptId })}\n`);
  return attemptId;
}

class PromotionRefusal extends Error {}

async function reserve(origin: string, workspaceId: string, attemptId: string, login: StoredHubLogin, signal: AbortSignal): Promise<string> {
  const action = { operation: "promote-workspace", workspaceId, attemptId } as const;
  let reply: Awaited<ReturnType<typeof manageRequest>>;
  try {
    reply = await manageRequest(origin, action, login, { signal, maxResponseBytes: 4096 });
  } catch (error) {
    if (error instanceof ManagementResponseError) {
      throw new Error(`hub returned an invalid promotion response${error.updateRequired ? "; update the hub and retry" : ""}`);
    }
    throw error;
  }
  const { status, body: result } = reply;
  if (status === 401 && result.status === "sign-in-required") return "sign-in-required";
  if (status === 200 && (result.status === "created" || result.status === "resumed") &&
      result.workspaceId === workspaceId && result.attemptId === attemptId) return result.status;
  const reasons: Record<string, string> = {
    "member-required": "your GitHub account must currently belong to at least one workspace on this hub; ask a workspace administrator for access or choose another hub",
    "admin-required": "your GitHub account must already administer a workspace on this hub; ask a workspace administrator for access or choose another hub",
    "workspace-conflict": "the hub already holds this workspace UUID, or it belongs to a different promotion attempt; resume from the original machine and receipt, or create a different local workspace",
    "protocol-mismatch": "hub and client sync versions differ; update them together",
    "not-configured": "this hub does not support authenticated workspace promotion; configure GitHub sign-in and update the hub",
  };
  throw new PromotionRefusal(reasons[String(result.status)] ?? "the hub refused promotion; update the hub and retry");
}

export async function promoteWorkspaceCommand(argv: string[], io: Io): Promise<number> {
  if (takeHelp(argv, io, WORKSPACE_PROMOTE_HELP)) return 0;
  let endpoint: string;
  try {
    const { positionals } = parseArgs({ args: argv, options: {}, allowPositionals: true });
    if (positionals.length !== 1) throw new Error("expected exactly one hub");
    endpoint = normalizeRemoteUrl(positionals[0] ?? "");
  } catch (error) {
    io.err(`ub workspace promote: ${error instanceof Error ? error.message : "invalid hub"}\n`);
    return 2;
  }
  let canResume = false;
  const interrupted = new AbortController();
  const interrupt = () => interrupted.abort();
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  try {
    const resolved = resolveConfig();
    const effective = requireBinding(resolved);
    const selection = resolveProjectBinding({ env: {} });
    const selected = selection.binding;
    if (selected === null || selection.path === null) {
      throw new Error("promotion requires a project binding; select the local workspace with `ub workspace use <id> --hub local` first");
    }
    if (resolved.origins.workspace === "environment" &&
        (effective.workspaceId !== selected.workspaceId || effective.hubUrl !== selected.hubUrl)) {
      throw new Error("the environment selects a different binding; unset UB_WORKSPACE_ID and UB_HUB_URL or explicitly select that project with `ub workspace use <id> --hub local` first");
    }
    if (selected.hubUrl !== null) throw new Error("the selected workspace already has a hub; only local-only workspaces can be promoted");
    const workspaceId = parseWorkspaceId(selected.workspaceId).uuid;
    const path = selection.path;
    const before = bindingBytes(path);
    const origin = authenticationOrigin(endpoint);
    const key = createHash("sha256").update(`${origin}\n${workspaceId}`).digest("hex");
    const receipt = join(resolveStorage().configDir, `.workspace-promotion-${key}.json`);
    const lock = await acquireInitLock(process.env, { path: `${receipt}.lock`, waitMs: 0, command: "ub workspace promote" });
    try {
      const attemptId = promotionAttempt(receipt);
      const { deviceLogin: _deviceLogin, ...localConfig } = resolveMcpConfig(resolved.env);
      if (!existsSync(localConfig.databasePath)) throw new Error("this machine has no local replica of the selected workspace");
      const local = await syncWorkspace({ ...localConfig, authSecret: null });
      if (local.missing.length > 0) throw new Error("local workspace has missing document content; restore it before promotion");
      let current = readDeviceLogin(endpoint, workspaceId);
      if (current.status === "sign-in-required") {
        if (await authCommand(["login", endpoint], io) !== 0) return 1;
        current = readDeviceLogin(endpoint, workspaceId);
      }
      if (current.status !== "ready") throw new Error(current.message);
      interrupted.signal.throwIfAborted();
      canResume = true;
      let result = await reserve(origin, workspaceId, attemptId, current.login, interrupted.signal);
      if (result === "sign-in-required") {
        // A concurrently renewed key may already be in the store. Try normal
        // renewal before replacing the login through GitHub approval.
        const renewed = await ensureDeviceLogin(endpoint, current.login.credential.record.workspaces[0] ?? workspaceId,
          { rejected: current.login, signal: interrupted.signal });
        if (renewed.status === "ready") {
          result = await reserve(origin, workspaceId, attemptId, renewed.login, interrupted.signal);
        } else if (renewed.status !== "sign-in-required" && renewed.status !== "no-access") {
          throw new Error(renewed.message);
        }
        if (result === "sign-in-required") {
          if (await authCommand(["login", endpoint], io) !== 0) return 1;
          current = readDeviceLogin(endpoint, workspaceId);
          if (current.status !== "ready") throw new Error(current.message);
          result = await reserve(origin, workspaceId, attemptId, current.login, interrupted.signal);
          if (result === "sign-in-required") throw new Error("the hub refused the new login");
        }
      }
      interrupted.signal.throwIfAborted();
      // Only after the committed grant: preflight dialing the new UUID would
      // cache a no-access renewal and delay the just-authorized connection.
      const admitted = await ensureDeviceLogin(endpoint, workspaceId,
        { membershipGranted: true, signal: interrupted.signal });
      if (admitted.status !== "ready") throw new Error(admitted.message);
      const env = { ...resolved.env, WORKSPACE_ID: workspaceId, HUB_URL: endpoint, UB_HUB_URL: endpoint,
        HUB_ADMISSION: "device", HUB_AUTH_TOKEN: undefined };
      const base = bridgeConfig(resolveMcpConfig(env), env);
      io.err(`Uploading workspace ${selected.workspaceId} to ${endpoint}…\n`);
      const uploaded = await syncWorkspace(base);
      const problem = corpusProblem(endpoint, uploaded);
      if (problem !== null) throw new Error(problem.trim());
      interrupted.signal.throwIfAborted();
      const checked = await verify({ base, env, target: endpoint, io }, uploaded.entries, uploaded.workspace);
      if (checked.problem !== null) throw new Error(checked.problem.trim());
      interrupted.signal.throwIfAborted();
      const bindingLock = await acquireInitLock();
      const binding = { workspaceId: selected.workspaceId, hubUrl: endpoint };
      try {
        interrupted.signal.throwIfAborted();
        const currentProject = resolveProjectBinding({ env: {} });
        if (currentProject.path !== path || bindingBytes(path) !== before ||
            JSON.stringify(currentProject.binding) !== JSON.stringify(selected)) {
          throw new Error("project selection changed during promotion; select the local workspace and retry");
        }
        // Persist endpoint admission privately before selecting it, so logout
        // cannot make a loopback Docker route fall back to the local secret.
        const admission = writeHubAdmission(endpoint, true);
        for (const warning of admission.warnings) io.err(`ub: warning: ${warning}\n`);
        writeProjectBinding(binding, { path });
      } finally { bindingLock.release(); }
      io.out(`Promoted workspace ${selected.workspaceId} to ${endpoint}.\nProject connected; ${uploaded.entries.length} documents verified, including archived documents.\n` +
        `Join on another machine: ub workspace join ${endpoint.replace(/\/$/, "")}/${selected.workspaceId}\n`);
      reportWorkspacePins(binding, io);
      return 0;
    } finally { lock.release(); }
  } catch (error) {
    const message = interrupted.signal.aborted ? "promotion interrupted" : error instanceof Error ? error.message : "promotion failed";
    io.err(`ub workspace promote: ${message}.\nProject binding unchanged; the local workspace remains usable.\n`);
    if (canResume && !(error instanceof PromotionRefusal)) {
      io.err("After resolving the error, rerun this command on this machine to resume the same attempt.\n");
    }
    return 1;
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
  }
}
