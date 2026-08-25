/**
 * Deep links: every document is addressable at `/<workspaceId>/<docUuid>`.
 *
 * The first segment *is* the workspace — this client is not configured for one
 * and cannot enumerate them. A link carries the workspace it belongs to, which
 * is what makes a pasted link from somebody else's workspace open that
 * workspace rather than the wrong document in this one. The build-time
 * `WORKSPACE_ID` (mise `[env]` in dev) only answers the one address that names
 * no workspace, `/`. `WORKSPACES` is a menu of places to go (see
 * {@link workspaceList}) and no more: an address outside the list still opens
 * its own workspace, and an address inside it is read exactly like any other.
 *
 * The segment may be decorated — `uberblick-<uuid>` — and is kept exactly as
 * typed: the slug is display, so nothing here rewrites somebody's spelling of
 * their own workspace. Only {@link Workspace.uuid} reaches a room key.
 *
 * Hand-rolled on purpose (#68). There are two routes; a router library would be
 * a new runtime dependency buying nothing but indirection.
 *
 * The address bar is the selection. Nothing else stores "which document is
 * open": the sidebar navigates, Back navigates, a pasted link navigates, and
 * all three arrive at the same `parseRoute`.
 */

import { useCallback, useEffect, useState } from "react";
import { parseWorkspaceId } from "@uberblick/schema";
import type { DocMeta } from "@uberblick/schema";

/** The workspace an address names: the identity, and how the URL spells it. */
export interface Workspace {
  /** The bare uuid. Room keys and token claims are built from this alone. */
  uuid: string;
  /** The first path segment, as typed — decorated or not. */
  segment: string;
}

/**
 * What an address resolves to.
 *
 * `invalid` is a statement about the *link*, never about the corpus: a
 * well-formed uuid this replica has not heard of is a `doc` route that has not
 * arrived yet, not a 404. See {@link docIsHydrated}. It still carries the
 * workspace when the address named a usable one, so a mistyped document uuid
 * does not also empty the sidebar.
 */
export type Route =
  | { kind: "no-workspace" }
  | { kind: "list"; workspace: Workspace }
  | { kind: "doc"; workspace: Workspace; uuid: string }
  | { kind: "invalid"; reason: string; workspace: Workspace | null };

/**
 * Canonical UUID shape. Matched case-insensitively — a *shape* check only.
 *
 * The version and variant nibbles are left unconstrained so a document whose
 * uuid came from somewhere other than `crypto.randomUUID` still opens. This is
 * the *document* segment; the workspace segment has its own rule, and schema
 * owns it.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * One path segment, percent-decoding tolerated.
 *
 * A malformed escape (`/<workspace>/%zz`) makes `decodeURIComponent` throw, and
 * an uncaught throw here would blank the app instead of showing the
 * invalid-link state that such a URL has earned.
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
 * Resolve a pathname.
 *
 * `configured` is the build-time workspace, or null when the build carries
 * none — it answers `/` and nothing else. A value that is not a workspace id is
 * treated as no workspace at all, which is what a misconfigured build has.
 */
export function parseRoute(pathname: string, configured: string | null): Route {
  const parts = pathname.split("/");
  // A pathname always starts with "/", so the head is always an empty string;
  // one trailing slash is a benign spelling of the same address and is dropped
  // (`canonicalPath` then takes it out of the address bar). Every *other* empty
  // segment is a malformed link — `/<workspace>//<uuid>` names no room, and
  // `parseRoom` rejects empty segments too, so the two agree about what a
  // well-formed `<workspace>/<uuid>` is.
  if (parts.length > 1 && parts[parts.length - 1] === "") parts.pop();
  const segments = parts.slice(1).map(decodeSegment);
  if (segments.some((segment) => segment === "")) {
    return {
      kind: "invalid",
      reason: "It has an empty path segment.",
      workspace: null,
    };
  }

  // `/` — the app with no workspace named. Canonicalised to the build's
  // workspace by `canonicalPath`, so the doc list has an address of its own;
  // with no build-time workspace there is nothing to open, and saying so is the
  // whole answer.
  if (segments.length === 0) {
    const workspace = configured === null ? null : readWorkspace(configured);
    return workspace === null ? { kind: "no-workspace" } : { kind: "list", workspace };
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

  const uuid = segments[1];
  if (uuid === undefined) return { kind: "list", workspace };
  if (segments.length > 2) {
    return {
      kind: "invalid",
      reason: "It has more path segments than an address.",
      workspace,
    };
  }

  // Case-preserving on purpose. Only the *shape* is normalised away; the uuid
  // itself is an opaque identity. Room names, directory keys and `meta.uuid`
  // are all case-sensitive, and nothing on the way in — the importer included —
  // lower-cases them, so folding the case here would point an upper-case
  // document's link at a room that does not exist, where it would wait for a
  // sync that can never arrive.
  if (!UUID.test(uuid)) {
    return {
      kind: "invalid",
      reason: `“${uuid}” is not a document uuid.`,
      workspace,
    };
  }
  return { kind: "doc", workspace, uuid };
}

/**
 * The workspaces to offer, in the order they were configured, with the one the
 * address names always among them.
 *
 * `configured` is the raw `WORKSPACES` value — decorated ids separated by
 * commas. An entry that is not a workspace id is dropped rather than shown: a
 * typo in a config list is not somewhere anyone can go, and offering it would
 * put the invalid-link screen behind a menu item.
 *
 * Deduplicated by uuid, because `<slug>-<uuid>` and `<uuid>` are one workspace
 * and a second entry would be another way to sit where you already are.
 * `current` wins that tie: the switcher shows the address bar's own spelling,
 * not a config file's opinion of it.
 *
 * A workspace the address names but the list omits is appended, so a reader who
 * arrived by a link can see where they are — and get back to a configured one.
 */
export function workspaceList(
  configured: string,
  current: Workspace | null,
): Workspace[] {
  const list: Workspace[] = [];
  const seen = new Set<string>();
  for (const entry of configured.split(",")) {
    const parsed = readWorkspace(entry.trim());
    if (parsed === null || seen.has(parsed.uuid)) continue;
    seen.add(parsed.uuid);
    list.push(current !== null && current.uuid === parsed.uuid ? current : parsed);
  }
  if (current !== null && !seen.has(current.uuid)) list.push(current);
  return list;
}

/**
 * The path of one document, under the workspace as the address spells it.
 *
 * Not `roomForDoc`: the room key carries the bare uuid, while a link keeps the
 * decorated spelling it was written with. For an undecorated workspace the two
 * strings are the same, which is why {@link shareUrl} can take a room key.
 */
export function docPath(segment: string, uuid: string): string {
  return `/${segment}/${uuid}`;
}

/**
 * The address `route` should be shown at, or `null` to leave the URL alone.
 *
 * Only routes that resolve get rewritten. A bad link keeps the address it was
 * opened with: correcting it would erase the evidence the error message is
 * about, and would put a working address behind a screen that says something is
 * wrong.
 */
export function canonicalPath(route: Route): string | null {
  switch (route.kind) {
    case "list":
      return `/${route.workspace.segment}`;
    case "doc":
      return docPath(route.workspace.segment, route.uuid);
    default:
      return null;
  }
}

/**
 * The absolute link to an address, for sharing.
 *
 * `address` is the path without its leading slash — `<workspace>/<uuid>`, with
 * the workspace spelled the way the address bar spells it. For an undecorated
 * workspace that is also the room key, which is why one function serves both.
 */
export function shareUrl(address: string, origin: string): string {
  return `${origin}/${address}`;
}

/**
 * Whether this replica actually holds the document a link names — the gate on
 * mounting a *writable* editor over it.
 *
 * One witness, and it is the document's own `meta.uuid`. A directory stub is
 * deliberately not enough. The stub is a cache that travels in its own room, so
 * "the directory knows this uuid, the document's room has not hydrated" is a
 * real state — and on a fresh deep link it is the *common* state, because the
 * small directory doc usually syncs before the document does. Unlocking on the
 * stub would bind the editor to a Y.Doc with no meta and no blocks, where a
 * keystroke writes blocks and metadata into a replica the real document is
 * about to merge into.
 *
 * Compared against `uuid` rather than tested for non-emptiness, because the
 * meta on screen belongs to whichever room is mounted and that can lag the
 * address by one effect.
 *
 * False is a "not yet", not a "no": `meta` is observed, so the waiting screen
 * resolves into the document the moment its content merges — nothing polls and
 * nothing retries.
 */
export function docIsHydrated(uuid: string, meta: DocMeta | null): boolean {
  return meta !== null && meta.uuid === uuid;
}

/**
 * Whether the replica has *answered* about the routed room yet.
 *
 * `meta` being null is one kind of silence — nothing has been read. An empty
 * `meta` is a second kind, and it looks identical: `getMeta` on a Y.Doc that
 * holds nothing returns `uuid: ""`, and a room that has just been opened holds
 * nothing until its IndexedDB replica is applied. Reading that as "answered,
 * and not this document" is what put "waiting for sync" on screen for a frame
 * when a reader navigates away from a document and back (#161) — the room is
 * released and re-opened from nothing, and the local read can slip past a
 * React commit.
 *
 * So the empty answer only counts once `localReplicaLoaded` says the local read
 * is done. After that an empty room *is* an answer: a deep link to a uuid this
 * replica does not hold keeps its waiting screen, which is the whole point of
 * that screen.
 */
export function replicaHasAnswered(
  meta: DocMeta | null,
  localReplicaLoaded: boolean,
): boolean {
  return meta !== null && (meta.uuid !== "" || localReplicaLoaded);
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
