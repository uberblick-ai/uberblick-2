/** Machine knowledge of replicas, independent of project selection and settings. */
import { lstatSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { normalizeRemoteUrl } from "./remote-url.js";
import { resolveStorage } from "./storage.js";
import { parseWorkspaceId } from "@uberblick/schema";
import { acquireInitLock } from "./init-lock.js";
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

/** Undefined means unknown; it must never be interpreted as local. */
export function readWorkspaceHub(id: string, env: NodeJS.ProcessEnv = process.env): string | null | undefined {
  return readRegistry(env).hubs[parseWorkspaceId(id).uuid];
}

export function recordedWorkspaceIds(env: NodeJS.ProcessEnv = process.env): string[] {
  return Object.keys(readRegistry(env).hubs);
}

/**
 * Caller holds the machine init lock. Publish records before replacing a binding,
 * restoring the prior records if that publication fails. The callback is synchronous
 * so another writer cannot enter between publication and restoration.
 * Only verified promotion, fetch or completed init attach may replace an existing workspace's hub.
 */
export function withWorkspaceBindings<T>(
  bindings: readonly ProjectBinding[],
  action: () => T,
  env: NodeJS.ProcessEnv = process.env,
  replaceWorkspace?: string,
): T {
  const current = readRegistry(env);
  const hubs = { ...current.hubs };
  const replace = replaceWorkspace === undefined ? undefined : parseWorkspaceId(replaceWorkspace).uuid;
  let changed = false;
  for (const binding of bindings) {
    const id = parseWorkspaceId(binding.workspaceId).uuid;
    const hub = binding.hubUrl === null ? null : normalizeRemoteUrl(binding.hubUrl);
    if (hubs[id] === undefined || id === replace) {
      changed ||= hubs[id] !== hub;
      hubs[id] = hub;
    }
  }
  if (!changed) return action();
  mkdirSync(dirname(current.path), { recursive: true, mode: 0o700 });
  // Prepare restoration before publication, so a later disk-full error while
  // writing the project file does not require writing the old map again.
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

/** Serving paths hold no binding lock, so serialize their first registration here. */
export async function rememberWorkspaceBinding(binding: ProjectBinding, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  // Passive serving preserves every existing record, including a differing hub.
  // An atomic registry publication makes this read safe without taking the lock.
  if (readWorkspaceHub(binding.workspaceId, env) !== undefined) return;
  const lock = await acquireInitLock(env);
  try { rememberWorkspaceBindings([binding], env); }
  finally { lock.release(); }
}
