/**
 * Deep links: every document is addressable at `/<workspaceId>/<docUuid>`.
 *
 * The path *is* the room key. `roomForDoc` already builds `main/<uuid>`, so a
 * link is that string with a slash in front of it and there is no second naming
 * scheme to keep in step — which is also why {@link shareUrl} can be one line.
 *
 * Hand-rolled on purpose (#68). There are two routes; a router library would be
 * a new runtime dependency buying nothing but indirection.
 *
 * The address bar is the selection. Nothing else stores "which document is
 * open": the sidebar navigates, Back navigates, a pasted link navigates, and
 * all three arrive at the same `parseRoute`.
 */

import { useCallback, useEffect, useState } from "react";
import { roomForDoc } from "@uberblick/schema";
import type { DirectoryEntry, DocMeta } from "@uberblick/schema";

/**
 * What an address resolves to.
 *
 * `invalid` is a statement about the *link*, never about the corpus: a
 * well-formed uuid this replica has not heard of is a `doc` route that has not
 * arrived yet, not a 404. See {@link docIsPresent}.
 */
export type Route =
  | { kind: "list" }
  | { kind: "doc"; uuid: string }
  | { kind: "unknown-workspace"; workspaceId: string }
  | { kind: "invalid"; reason: string };

/**
 * Canonical UUID shape, case-insensitive.
 *
 * Deliberately not `parseRoom`'s validation, which only rejects empty segments
 * and stray slashes: under that rule every typo is a document that might still
 * sync, and the "waiting for sync" state could never be told apart from a
 * mistyped link. The version and variant nibbles are left unconstrained so a
 * document whose uuid came from somewhere other than `crypto.randomUUID` still
 * opens.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * One path segment, percent-decoding tolerated.
 *
 * A malformed escape (`/main/%zz`) makes `decodeURIComponent` throw, and an
 * uncaught throw here would blank the app instead of showing the invalid-link
 * state that such a URL has earned.
 */
function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** Resolve a pathname against the workspace this client is configured for. */
export function parseRoute(pathname: string, workspace: string): Route {
  const segments = pathname
    .split("/")
    .filter((segment) => segment !== "")
    .map(decodeSegment);

  // `/` — the app with nothing open. Canonicalised to `/<workspace>` by
  // `canonicalPath`, so the doc list has an address of its own.
  if (segments.length === 0) return { kind: "list" };

  const workspaceId = segments[0] ?? "";
  if (workspaceId !== workspace) return { kind: "unknown-workspace", workspaceId };

  const uuid = segments[1];
  if (uuid === undefined) return { kind: "list" };
  if (segments.length > 2) {
    return { kind: "invalid", reason: "It has more path segments than an address." };
  }

  // Lowercased so a link that arrived shouting still matches a directory key,
  // and so `canonicalPath` normalises the address bar on the way in.
  const normalised = uuid.toLowerCase();
  if (!UUID.test(normalised)) {
    return { kind: "invalid", reason: `“${uuid}” is not a document uuid.` };
  }
  return { kind: "doc", uuid: normalised };
}

/** The path of one document. Same string as its room key, with a leading slash. */
export function docPath(workspaceId: string, uuid: string): string {
  return `/${roomForDoc(workspaceId, uuid)}`;
}

/**
 * The address `route` should be shown at, or `null` to leave the URL alone.
 *
 * Only routes that resolve get rewritten. A bad link keeps the address it was
 * opened with: correcting `/typo/x` to `/main` would erase the evidence the
 * error message is about, and would put a working address behind a screen that
 * says something is wrong.
 */
export function canonicalPath(route: Route, workspace: string): string | null {
  switch (route.kind) {
    case "list":
      return `/${workspace}`;
    case "doc":
      return docPath(workspace, route.uuid);
    default:
      return null;
  }
}

/** The absolute link to a room, for sharing. */
export function shareUrl(room: string, origin: string): string {
  return `${origin}/${room}`;
}

/**
 * Whether this replica can show the document a link names.
 *
 * Two independent witnesses, because either can arrive first and either alone
 * is enough: the document's own `meta.uuid`, which `initDoc` writes (so a
 * document restored from IndexedDB opens before the directory has synced), and
 * the directory stub (so a link opens off the directory while the document's
 * own room is still hydrating).
 *
 * The first witness is checked against `uuid` rather than for mere non-emptiness
 * — the meta on screen belongs to whichever room is currently mounted, and that
 * lags the address by one effect. Reading "some document is loaded" as "this
 * document is loaded" would show the previous document's content under the new
 * document's URL for a frame.
 *
 * False is a "not yet", not a "no". It is the honest reading of an empty local
 * replica, and it stops being false of its own accord the moment either witness
 * lands — both are observed, so the waiting screen resolves into the document
 * with nothing to poll and nothing to retry.
 */
export function docIsPresent(
  uuid: string,
  meta: DocMeta | null,
  entries: DirectoryEntry[],
): boolean {
  if (meta !== null && meta.uuid === uuid) return true;
  return entries.some((entry) => entry.uuid === uuid);
}

/** Push a new address, or replace the current one without growing the history. */
export type Navigate = (path: string, mode?: "push" | "replace") => void;

/**
 * The current pathname, two-way bound to the History API.
 *
 * `popstate` covers Back and Forward; the browser does not fire it for our own
 * `pushState`, so {@link Navigate} sets the state itself. Both ends write the
 * same value, which is what keeps the address bar and the app from disagreeing.
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
