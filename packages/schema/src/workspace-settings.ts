import type * as Y from "yjs";

/** A root in the workspace's _settings room, beside the tag catalog roots. */
export const WORKSPACE_SETTINGS_KEY = "workspace-settings";
export const MAX_WORKSPACE_NAME_LENGTH = 64;

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
