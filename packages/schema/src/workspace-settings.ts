import type * as Y from "yjs";
import { githubRepository } from "./github-reference.js";

/** A root in the workspace's _settings room, beside the tag catalog roots. */
export const WORKSPACE_SETTINGS_KEY = "workspace-settings";

// Count Unicode characters rather than UTF-16 code units.
const NAME_PATTERN = /^[^\p{Cc}\p{Cf}]{1,64}$/u;

/** Normalize before writing; an invalid answer never changes shared state. */
export function validateWorkspaceName(input: string): string {
  const name = input.trim();
  if (!NAME_PATTERN.test(name)) {
    throw new Error(
      "Workspace name must be 1–64 characters after trimming, with no control or format characters.",
    );
  }
  return name;
}

/** Missing or unreadable names remain unnamed; reads never write a default. */
export function getWorkspaceName(settings: Y.Doc): string | null {
  const value = settings.getMap<unknown>(WORKSPACE_SETTINGS_KEY).get("name");
  if (typeof value !== "string") return null;
  try {
    return validateWorkspaceName(value);
  } catch {
    return null;
  }
}

/** One replaceable string: concurrent renames converge without splicing text. */
export function setWorkspaceName(settings: Y.Doc, input: string): string {
  const name = validateWorkspaceName(input);
  settings.getMap<string>(WORKSPACE_SETTINGS_KEY).set("name", name);
  return name;
}

/** Missing or unreadable repository settings stay unset; reads write no default. */
export function getWorkspaceMainRepository(settings: Y.Doc): string | null {
  try {
    const value = settings.getMap<unknown>(WORKSPACE_SETTINGS_KEY).get("mainRepository");
    return typeof value === "string" ? githubRepository(value) : null;
  } catch {
    return null;
  }
}

/** Validate before writing one replaceable identity; an empty value clears it. */
export function setWorkspaceMainRepository(settings: Y.Doc, input: string): string | null {
  const repository = input.trim() === "" ? null : githubRepository(input);
  if (repository === null && input.trim() !== "") {
    throw new Error("Main repository must be owner/repo or a github.com repository address.");
  }
  const map = settings.getMap<string>(WORKSPACE_SETTINGS_KEY);
  if (repository === null) map.delete("mainRepository");
  else map.set("mainRepository", repository);
  return repository;
}
