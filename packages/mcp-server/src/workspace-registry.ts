/** Machine knowledge of replicas, independent of project selection and settings. */
import { lstatSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { hubIdentity, normalizeRemoteUrl } from "./remote-url.js";
import { resolveStorage } from "./storage.js";
import { parseWorkspaceId } from "@uberblick/schema";
import { acquireInitLock } from "./init-lock.js";
import { defaultWorkspaceDatabasePath } from "./config.js";
import type { ProjectBinding } from "./project-binding.js";
import { publishOwnerOnly, publishStaged, removeQuietly, writeTempBeside } from "./safe-write.js";

export function workspaceRegistryPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(resolveStorage({ env }).configDir, "workspaces.json");
}

function readRegistry(env: NodeJS.ProcessEnv): { path: string; text: string | null; hubs: Record<string, string | null> } {
  const path = workspaceRegistryPath(env);
  let text: string;
  try {
    if (!lstatSync(path).isFile()) throw new Error("not a regular file");
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { path, text: null, hubs: {} };
    throw new Error(`Cannot read workspace records at ${path}: expected a regular JSON file`);
  }
  try {
    const raw: unknown = JSON.parse(text);
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new Error("not an object");
    const hubs: Record<string, string | null> = {};
    for (const [id, hub] of Object.entries(raw)) {
      if (parseWorkspaceId(id).uuid !== id) throw new Error("not a UUID");
      if (hub !== null && (typeof hub !== "string" || hub.trim() === "")) throw new Error("not a hub");
      hubs[id] = hub === null ? null : normalizeRemoteUrl(hub as string);
    }
    return { path, text, hubs };
  } catch {
    // Parser errors can quote file contents; never expose them in diagnostics.
    throw new Error(`Invalid workspace records at ${path}: expected a UUID-to-hub map (null for local)`);
  }
}

/** Undefined means no record; callers must check for an existing replica before using a hub selection. */
export function readWorkspaceHub(id: string, env: NodeJS.ProcessEnv = process.env): string | null | undefined {
  return readRegistry(env).hubs[parseWorkspaceId(id).uuid];
}

export function recordedWorkspaceIds(env: NodeJS.ProcessEnv = process.env): string[] {
  return Object.keys(readRegistry(env).hubs);
}

export function hasWorkspaceReplica(id: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const uuid = parseWorkspaceId(id).uuid;
  const paths = [defaultWorkspaceDatabasePath(id, env)];
  if (env.UBERBLICK_DB?.trim()) paths.push(env.UBERBLICK_DB.trim());
  return paths.some(path => {
    try { lstatSync(path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
    if (path === paths[0]) return true;
    // A custom path can belong to another binding in the same publication.
    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(path, { readOnly: true });
      const row = db.prepare("SELECT value FROM meta WHERE key = 'workspace'").get();
      return row?.value === undefined || row.value === uuid;
    } catch {
      // Unreadable or unclaimed files are never evidence of an absent copy.
      return true;
    } finally { db?.close(); }
  });
}

export class WorkspaceBindingMismatch extends Error {
  readonly reason: string;
  readonly fix: string;

  constructor(binding: ProjectBinding, recorded: string | null | undefined, source: string) {
    const id = parseWorkspaceId(binding.workspaceId).uuid;
    const destination = binding.hubUrl === null ? "local" : normalizeRemoteUrl(binding.hubUrl);
    const association = recorded === undefined ? "local (existing replica with no hub record)" : recorded ?? "local";
    const origin = source === "environment" ? "UB_WORKSPACE_ID/UB_HUB_URL environment" : source;
    const reason = `Workspace ${id} belongs to ${association} on this machine, but ${origin} selects ${destination}.`;
    const clear = source === "environment" ? "env -u UB_WORKSPACE_ID -u UB_HUB_URL " : "";
    const fix = binding.hubUrl === null
      ? source === "environment"
        ? `Make this computer's copy local with ub workspace detach ${id}. To keep syncing, restore the recorded selection: unset UB_WORKSPACE_ID UB_HUB_URL`
        : `Make this computer's copy local with ub workspace detach ${id}. To keep syncing, restore the recorded selection: ub workspace use ${id}`
      : `To move this machine's copy, run:\n  ${clear}ub workspace use '${destination.replace(/'/g, "'\\''")}/${id}'\n` +
        `This destination comes from ${origin}. Moving can upload this copy's content; only move a copy you trust to a hub you trust. ` +
        "Re-fetch an untrusted copy on a clean machine instead.";
    super(`${reason} ${fix}`);
    this.reason = reason;
    this.fix = fix;
  }
}

/** Check without opening the replica; true means this read found a matching record. */
export function assertWorkspaceBinding(
  binding: ProjectBinding,
  env: NodeJS.ProcessEnv = process.env,
  source = "binding",
): boolean {
  const recorded = readWorkspaceHub(binding.workspaceId, env);
  if (recorded !== undefined) {
    const matches = recorded === null || binding.hubUrl === null
      ? recorded === binding.hubUrl : hubIdentity(recorded) === hubIdentity(binding.hubUrl);
    if (!matches) throw new WorkspaceBindingMismatch(binding, recorded, source);
    return true;
  } else if (binding.hubUrl !== null && hasWorkspaceReplica(binding.workspaceId, env)) {
    throw new WorkspaceBindingMismatch(binding, undefined, source);
  }
  return false;
}

/** Validate before opening a replica or contacting any hub; first registration is locked. */
export async function ensureWorkspaceBinding(
  binding: ProjectBinding,
  env: NodeJS.ProcessEnv = process.env,
  source = "binding",
): Promise<void> {
  if (assertWorkspaceBinding(binding, env, source)) return;
  const lock = await acquireInitLock(env);
  try {
    assertWorkspaceBinding(binding, env, source);
    rememberWorkspaceBindings([binding], env);
  } finally { lock.release(); }
}

/** Caller holds the machine init lock, including throughout replica removal. */
export function forgetWorkspace(id: string, env: NodeJS.ProcessEnv = process.env): void {
  const current = readRegistry(env);
  const uuid = parseWorkspaceId(id).uuid;
  if (!(uuid in current.hubs)) return;
  delete current.hubs[uuid];
  publishOwnerOnly(current.path, `${JSON.stringify(current.hubs, null, 2)}\n`);
}

/**
 * Caller holds the init lock. Publish records first; restore them if binding publication fails.
 * Keep the callback synchronous so publication and restoration cannot interleave.
 * Only verified promotion, fetch, completed init attach or explicit detach may replace an existing hub.
 */
export function withWorkspaceBindings<T>(
  bindings: readonly ProjectBinding[],
  action: () => T,
  env: NodeJS.ProcessEnv = process.env,
  replaceWorkspace?: string,
  source = "project binding",
): T {
  const current = readRegistry(env);
  const hubs = { ...current.hubs };
  const replace = replaceWorkspace === undefined ? undefined : parseWorkspaceId(replaceWorkspace).uuid;
  let changed = false;
  for (const binding of bindings) {
    const id = parseWorkspaceId(binding.workspaceId).uuid;
    const hub = binding.hubUrl === null ? null : normalizeRemoteUrl(binding.hubUrl);
    if (hubs[id] === undefined && id !== replace && hub !== null && hasWorkspaceReplica(id, env)) {
      throw new WorkspaceBindingMismatch(binding, undefined, source);
    }
    if (hubs[id] === undefined || id === replace) {
      changed ||= hubs[id] !== hub;
      hubs[id] = hub;
    }
  }
  if (!changed) return action();
  mkdirSync(dirname(current.path), { recursive: true, mode: 0o700 });
  // Stage restoration first: disk-full during binding publication must not prevent recovery.
  const restore = current.text === null ? null : writeTempBeside(current.path, current.text);
  try {
    publishOwnerOnly(current.path, `${JSON.stringify(hubs, null, 2)}\n`);
    try {
      return action();
    } catch (error) {
      if (restore === null) unlinkSync(current.path);
      else publishStaged(restore, current.path, "regular");
      throw error;
    }
  } finally {
    if (restore !== null) removeQuietly(restore);
  }
}

/** Caller already holds the machine init lock (create/join/promote/init). */
export function rememberWorkspaceBindings(
  bindings: readonly ProjectBinding[],
  env: NodeJS.ProcessEnv = process.env,
  replaceWorkspace?: string,
): void {
  withWorkspaceBindings(bindings, () => {}, env, replaceWorkspace);
}
