/**
 * The URL is the only selection. A link's workspace wins over the configured
 * menu; configuration supplies only the / default. Preserve decorated
 * workspace spelling in links, but use the bare UUID in room keys and token
 * claims. Parse workspace, document, all-docs and settings addresses here.
 */

import { useCallback, useEffect, useState } from "react";
import { canonicalDocumentUuid, parseWorkspaceId } from "@uberblick/schema";
import type { DocMeta } from "@uberblick/schema";

/** The workspace an address names: the identity, and how the URL spells it. */
export interface Workspace {
  /** The bare uuid. Room keys and token claims are built from this alone. */
  uuid: string;
  /** The first path segment, as typed — decorated or not. */
  segment: string;
}

/** The destinations inside workspace settings. */
export type SettingsPage = "general" | "tags" | "access" | "hub-admins" | "hub-workspaces";

/**
 * Invalid describes link syntax, never an unseen valid document UUID.
 * Preserve a usable workspace on invalid document links. Distinguish absent
 * configuration from invalid configured workspace values because their
 * recovery steps differ.
 */
export type Route =
  | { kind: "no-workspace"; reason: "absent" }
  | { kind: "no-workspace"; reason: "invalid"; configured: string }
  | { kind: "list"; workspace: Workspace }
  | { kind: "all"; workspace: Workspace }
  | { kind: "settings"; workspace: Workspace; page: SettingsPage }
  | { kind: "doc"; workspace: Workspace; uuid: string }
  | { kind: "invalid"; reason: string; workspace: Workspace | null };

/** Reserve all for the listing; document UUIDs cannot collide with this word. */
export const ALL_SEGMENT = "all";

/** The workspace-settings mode. General keeps the mode's root address. */
export const SETTINGS_SEGMENT = "settings";

/** Child addresses inside workspace settings. */
export const TAG_SETTINGS_SEGMENT = "tags";
export const ACCESS_SETTINGS_SEGMENT = "access";

/**
 * Malformed percent escapes must return invalid-link state instead of
 * throwing and blanking the app.
 */
function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** The workspace a segment names, or null when it names none. */
function readWorkspace(segment: string): Workspace | null {
  try {
    return { uuid: parseWorkspaceId(segment).uuid, segment };
  } catch {
    return null;
  }
}

/**
 * The first configured workspace answers / only. An invalid configured value
 * yields no-workspace with its distinct cause.
 */
export function parseRoute(pathname: string, configured: string | null): Route {
  const parts = pathname.split("/");
  // Drop one benign trailing slash. Reject every other empty segment,
  // matching parseRoom, rather than constructing a malformed room key.
  if (parts.length > 1 && parts[parts.length - 1] === "") parts.pop();
  const segments = parts.slice(1).map(decodeSegment);
  if (segments.some((segment) => segment === "")) {
    return {
      kind: "invalid",
      reason: "It has an empty path segment.",
      workspace: null,
    };
  }

  // Canonicalize / to the configured workspace list; without one, no
  // workspace can open.
  if (segments.length === 0) {
    if (configured === null) return { kind: "no-workspace", reason: "absent" };
    const workspace = readWorkspace(configured);
    return workspace === null
      ? { kind: "no-workspace", reason: "invalid", configured }
      : { kind: "list", workspace };
  }

  const first = segments[0] ?? "";
  const workspace = readWorkspace(first);
  if (workspace === null) {
    return {
      kind: "invalid",
      reason: `“${first}” is not a workspace id.`,
      workspace: null,
    };
  }

  const second = segments[1];
  if (second === undefined) return { kind: "list", workspace };
  const canonical = second.toLowerCase();
  if (canonical === SETTINGS_SEGMENT) {
    const page = segments[2]?.toLowerCase();
    if (page === undefined) return { kind: "settings", workspace, page: "general" };
    if (segments.length === 3 && page === TAG_SETTINGS_SEGMENT) {
      return { kind: "settings", workspace, page: "tags" };
    }
    if (segments.length === 3 && page === ACCESS_SETTINGS_SEGMENT) {
      return { kind: "settings", workspace, page: "access" };
    }
    if (segments.length === 3 && (page === "hub-admins" || page === "hub-workspaces")) {
      return { kind: "settings", workspace, page };
    }
    return {
      kind: "invalid",
      reason: "It has more path segments than an address.",
      workspace,
    };
  }
  if (segments.length > 2) {
    return {
      kind: "invalid",
      reason: "It has more path segments than an address.",
      workspace,
    };
  }

  // Schema owns the document identity's shape and case rule. A shouted link
  // names the lowercase document, and `canonicalPath` puts that spelling in
  // the address bar. The rejection message keeps the spelling as typed: it is
  // about the link on screen.
  if (canonical === ALL_SEGMENT) return { kind: "all", workspace };
  const uuid = canonicalDocumentUuid(second);
  if (uuid === null) {
    return {
      kind: "invalid",
      reason: `“${second}” is not a document uuid.`,
      workspace,
    };
  }
  return { kind: "doc", workspace, uuid };
}

/**
 * Keep configured order, filter invalid entries and deduplicate by UUID. The
 * current address's spelling wins ties; append an unconfigured linked
 * workspace so the reader can identify it and return to configured choices.
 */
export function workspaceList(
  configured: readonly string[],
  current: Workspace | null,
): Workspace[] {
  const list: Workspace[] = [];
  const seen = new Set<string>();
  for (const entry of configured) {
    const parsed = readWorkspace(entry.trim());
    if (parsed === null || seen.has(parsed.uuid)) continue;
    seen.add(parsed.uuid);
    list.push(current !== null && current.uuid === parsed.uuid ? current : parsed);
  }
  if (current !== null && !seen.has(current.uuid)) list.push(current);
  return list;
}

/**
 * Links retain the decorated workspace spelling; roomForDoc uses only its
 * UUID.
 */
export function docPath(segment: string, uuid: string): string {
  return `/${segment}/${uuid}`;
}

/** The workspace All docs listing path. */
export function allPath(segment: string): string {
  return `/${segment}/${ALL_SEGMENT}`;
}

/** The path of one workspace-settings destination. */
export function settingsPath(
  segment: string,
  page: SettingsPage = "general",
): string {
  const root = `/${segment}/${SETTINGS_SEGMENT}`;
  return page === "general" ? root : `${root}/${page}`;
}

/**
 * Rewrite only resolvable routes. Invalid links keep their original address
 * as the evidence named by the error.
 */
export function canonicalPath(route: Route): string | null {
  switch (route.kind) {
    case "list":
      return `/${route.workspace.segment}`;
    case "all":
      return allPath(route.workspace.segment);
    case "settings":
      return settingsPath(route.workspace.segment, route.page);
    case "doc":
      return docPath(route.workspace.segment, route.uuid);
    default:
      return null;
  }
}

/**
 * Build a shareable absolute URL from the path without its leading slash,
 * preserving workspace spelling.
 */
export function shareUrl(address: string, origin: string): string {
  return `${origin}/${address}`;
}

/**
 * Require this room's meta.uuid to equal the routed UUID before mounting a
 * writable editor. Directory stubs arrive independently and cannot prove
 * hydration. A false answer waits for observed room content rather than
 * becoming a 404.
 */
export function docIsHydrated(uuid: string, meta: DocMeta | null): boolean {
  return meta !== null && meta.uuid === uuid;
}

/**
 * Null metadata is unread. Empty metadata answers only after sync, failure or
 * refusal; a newly joining empty room must not flash waiting. A completed
 * empty answer keeps waiting for this document.
 */
export function replicaHasAnswered(
  meta: DocMeta | null,
  connectionAnswered: boolean,
): boolean {
  return meta !== null && (meta.uuid !== "" || connectionAnswered);
}

/** Push a new address, or replace the current one without growing the history. */
export type Navigate = (path: string, mode?: "push" | "replace") => void;

/**
 * popstate handles browser history; Navigate updates local state for
 * pushState, which emits no popstate. Both must carry the same pathname.
 */
export function useRoutePath(): [string, Navigate] {
  const [path, setPath] = useState(() => window.location.pathname);

  useEffect(() => {
    const read = (): void => setPath(window.location.pathname);
    window.addEventListener("popstate", read);
    return () => window.removeEventListener("popstate", read);
  }, []);

  const navigate = useCallback<Navigate>((next, mode = "push") => {
    // Guarded: pushing the address we are already at would put a duplicate
    // entry in the history, so Back would appear to do nothing.
    if (next !== window.location.pathname) {
      if (mode === "replace") window.history.replaceState(null, "", next);
      else window.history.pushState(null, "", next);
    }
    setPath(next);
  }, []);

  return [path, navigate];
}
