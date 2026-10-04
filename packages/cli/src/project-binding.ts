import { lstatSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { normalizeRemoteUrl } from "@uberblick/hub/remote-url";
import { parseWorkspaceId } from "@uberblick/schema";
import { publishOwnerOnly } from "./safe-write.js";

export const PROJECT_CONFIG_FILE = ".uberblick.json";
export const LOCAL_HUB = "local";

export interface ProjectBinding {
  workspaceId: string;
  hubUrl: string | null;
}

export interface BindingOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

export interface ResolvedBinding {
  binding: ProjectBinding | null;
  origin: "environment" | "project config" | null;
  path: string | null;
}

export const NO_BINDING = "No workspace selected. Add a .uberblick.json binding, run `ub init` for a local workspace, " +
  "`ub remote join <workspace-url>` to join a hub, or set both UB_WORKSPACE_ID and UB_HUB_URL (local for local-only).";

/** Find the nearest entry, including a broken symlink: invalid files must fail. */
export function findProjectConfig(cwd = process.cwd()): string | null {
  let directory = resolve(cwd);
  for (;;) {
    const path = join(directory, PROJECT_CONFIG_FILE);
    try {
      lstatSync(path);
      return path;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new Error(`Cannot inspect project binding at ${path}`);
      }
    }
    const parent = dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}

/** Validate the whole pair before returning either value. Never echo input. */
export function validateProjectBinding(value: unknown, source: string): ProjectBinding {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${source}: expected an object with workspaceId and hubUrl`);
  }
  const raw = value as Record<string, unknown>;
  if (typeof raw.workspaceId !== "string" || raw.workspaceId.trim() === "") {
    throw new Error(`${source}: workspaceId must be a non-empty workspace ID`);
  }
  const workspaceId = raw.workspaceId.trim();
  parseWorkspaceId(workspaceId, `${source}: workspaceId`);
  if (raw.hubUrl === null) return { workspaceId, hubUrl: null };
  if (typeof raw.hubUrl !== "string" || raw.hubUrl.trim() === "") {
    throw new Error(`${source}: hubUrl must be a hub URL or null for local-only`);
  }
  if (raw.hubUrl.trim().toLowerCase() === LOCAL_HUB) {
    throw new Error(`${source}: use JSON null for local operation on this computer, not the string "local"`);
  }
  return { workspaceId, hubUrl: normalizeRemoteUrl(raw.hubUrl) };
}

function readProject(path: string): Record<string, unknown> {
  let value: unknown;
  try {
    // Reject symlinks so writes and reads agree on which project owns the file.
    if (!lstatSync(path).isFile()) throw new Error("not a regular file");
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(`Cannot read ${path}: expected a regular file containing valid JSON`);
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path}: expected a JSON object`);
  }
  return value as Record<string, unknown>;
}

export function resolveProjectBinding(options: BindingOptions = {}): ResolvedBinding {
  const env = options.env ?? process.env;
  if (env.UB_WORKSPACE_ID !== undefined || env.UB_HUB_URL !== undefined) {
    if (!env.UB_WORKSPACE_ID?.trim() || !env.UB_HUB_URL?.trim()) {
      throw new Error("Set both UB_WORKSPACE_ID and UB_HUB_URL; incomplete environment bindings cannot use values from a project or machine configuration. Use UB_HUB_URL=local for local-only.");
    }
    return {
      binding: validateProjectBinding({
        workspaceId: env.UB_WORKSPACE_ID,
        hubUrl: env.UB_HUB_URL.trim() === LOCAL_HUB ? null : env.UB_HUB_URL,
      }, "environment binding"),
      origin: "environment",
      path: null,
    };
  }
  // Old named MCP entries pinned WORKSPACE_ID only. Ignoring that pin while
  // adopting a project file would silently send that entry to another corpus.
  if (env.WORKSPACE_ID?.trim() || env.HUB_URL?.trim()) {
    throw new Error("Legacy WORKSPACE_ID / HUB_URL selection is no longer supported. Replace it with a complete UB_WORKSPACE_ID and UB_HUB_URL pair, or remove both legacy variables and explicitly select a .uberblick.json binding. No workspace was opened.");
  }
  const path = findProjectConfig(options.cwd);
  if (path === null) return { binding: null, origin: null, path: null };
  return {
    binding: validateProjectBinding(readProject(path), path),
    origin: "project config",
    path,
  };
}

/** Persist a complete selection in the nearest project file, or the current folder. */
export function writeProjectBinding(
  value: ProjectBinding,
  options: BindingOptions & { path?: string } = {},
): string {
  const binding = validateProjectBinding(value, "project binding");
  const path = options.path ?? findProjectConfig(options.cwd) ?? join(options.cwd ?? process.cwd(), PROJECT_CONFIG_FILE);
  let existing: Record<string, unknown> = {};
  try {
    lstatSync(path);
    existing = readProject(path);
    validateProjectBinding(existing, path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  publishOwnerOnly(path, `${JSON.stringify({ ...existing, ...binding }, null, 2)}\n`);
  return path;
}
