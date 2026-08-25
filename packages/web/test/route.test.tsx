/**
 * Deep-link routing (#68).
 *
 * Three contracts, and nothing else. The address bar is the selection, so
 * pinning them is pinning the feature:
 *
 * 1. **What an address means.** Which pathnames are documents, which are the
 *    list, and — the load-bearing one — where the line falls between "a link
 *    this replica has not synced yet" and "not a link at all". Getting that
 *    line wrong turns an unsynced document into a 404, which is the failure
 *    this feature exists to avoid.
 * 2. **That the URL and the app move together**, in both directions: our own
 *    navigation writes the history, and Back/Forward are read out of it. The
 *    browser fires `popstate` for one direction only, so the two halves are
 *    genuinely separate code and genuinely separate risk.
 * 3. **That waiting is gated on the document itself, and resolves.** The one
 *    witness is the document's own metadata — a directory stub is a name, not
 *    content, and opening on it would hand back a writable empty replica. It is
 *    observed, so it clears itself when the content merges: no poll, no reload.
 *
 * Deliberately not here: that Vite serves index.html for a deep URL, and that a
 * fresh browser with an empty IndexedDB lands on the right document. Both are
 * claims about a real server and a real browser profile — `e2e/deep-link.spec.ts`.
 */

import { afterEach, describe, expect, it, beforeEach } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { ReactElement } from "react";
import * as Y from "yjs";
import {
  initDoc,
  listDirectory,
  roomForDoc,
  upsertDirectoryEntry,
} from "@uberblick/schema";
import type { DocMeta } from "@uberblick/schema";
import { RoutePane } from "../src/ui/App.js";
import { StatusLine } from "../src/ui/EditorPane.js";
import { useDocMeta } from "../src/ui/hooks.js";
import {
  canonicalPath,
  docIsHydrated,
  docPath,
  parseRoute,
  shareUrl,
  useRoutePath,
} from "../src/ui/route.js";
import type { Route } from "../src/ui/route.js";
import type { RoomConnection, RoomStatus } from "../src/collab/rooms.js";

const UUID = "3231bff4-2f1c-4a49-9f0a-6f8b2c1d7e55";
const OTHER = "8c9a1b20-77de-4d31-bd2e-1f0f3a5c6b90";

/** The workspace the addresses below name. A workspace id is a uuid. */
const WS = "6f4c8a51-2b7d-4e39-9a06-c81d3f572be4";
/** The same workspace, spelled with a display slug. */
const DECORATED = `uberblick-${WS}`;
/** What the build's `WORKSPACE_ID` supplies, for the one address without one. */
const CONFIGURED = DECORATED;

const workspace = { uuid: WS, segment: WS };

function route(pathname: string): Route {
  return parseRoute(pathname, CONFIGURED);
}

describe("an address names a document, the list, or neither", () => {
  it("reads /<workspace>/<uuid> as that document", () => {
    expect(route(`/${WS}/${UUID}`)).toEqual({ kind: "doc", workspace, uuid: UUID });
  });

  it("opens the same document whether or not the workspace carries a slug", () => {
    // The slug is display. Both addresses name one workspace, so both name one
    // room — and the URL keeps the spelling it was written with.
    const decorated = route(`/${DECORATED}/${UUID}`);
    expect(decorated).toEqual({
      kind: "doc",
      workspace: { uuid: WS, segment: DECORATED },
      uuid: UUID,
    });
    expect(decorated.kind === "doc" && decorated.workspace.uuid).toBe(
      route(`/${WS}/${UUID}`).kind === "doc" ? WS : null,
    );
    expect(roomForDoc(DECORATED, UUID)).toBe(roomForDoc(WS, UUID));
    // Kept as typed: canonicalisation against a workspace's own name is a
    // later question, and rewriting it here would break a shared link.
    expect(canonicalPath(decorated)).toBe(`/${DECORATED}/${UUID}`);
  });

  it("reads / as the build's workspace, and /<workspace> as its list", () => {
    expect(route("/")).toEqual({
      kind: "list",
      workspace: { uuid: WS, segment: CONFIGURED },
    });
    expect(route(`/${WS}`)).toEqual({ kind: "list", workspace });
    expect(route(`/${WS}/`)).toEqual({ kind: "list", workspace });
    expect(canonicalPath(route("/"))).toBe(`/${CONFIGURED}`);
  });

  it("says so when nothing names a workspace, rather than guessing one", () => {
    // A build with no `WORKSPACE_ID` has no `/`: this client cannot enumerate
    // workspaces, and inventing one would open a corpus nobody chose.
    expect(parseRoute("/", null)).toEqual({ kind: "no-workspace" });
    // A build whose value is not a workspace id has none either.
    expect(parseRoute("/", "main")).toEqual({ kind: "no-workspace" });
  });

  it("calls a first segment that is not a workspace id an invalid link", () => {
    for (const bad of ["other", "main", `${WS}x`, `foo--${WS}`]) {
      const parsed = parseRoute(`/${bad}/${UUID}`, CONFIGURED);
      expect(parsed.kind).toBe("invalid");
      expect(parsed.kind === "invalid" && parsed.reason).toContain(bad);
      // No workspace to fall back on: the link named one, and it is not one.
      expect(parsed.kind === "invalid" && parsed.workspace).toBeNull();
    }
  });

  it("calls a malformed uuid an invalid link — the one case that is not a document", () => {
    // The distinction the whole feature turns on: these can never arrive by
    // sync, so waiting for them would be waiting forever.
    for (const bad of ["not-a-uuid", "1234", `${UUID}x`, "%zz"]) {
      const parsed = route(`/${WS}/${bad}`);
      expect(parsed.kind).toBe("invalid");
      // The workspace survives a mistyped document, so the sidebar does not
      // empty itself over a bad link.
      expect(parsed.kind === "invalid" && parsed.workspace).toEqual(workspace);
    }
    expect(route(`/${WS}/${UUID}/blocks`).kind).toBe("invalid");
  });

  it("rejects an empty path segment rather than quietly closing the gap", () => {
    // `/<workspace>//<uuid>` names no room. Skipping the hole would make a link that
    // is wrong look like one that works, and `parseRoom` rejects empty segments
    // too — the two agree on what a well-formed address is.
    expect(route(`/${WS}//${UUID}`).kind).toBe("invalid");
    expect(route(`/${WS}//`).kind).toBe("invalid");
    expect(route(`//${WS}/${UUID}`).kind).toBe("invalid");
    expect(route(`/${WS}/${UUID}//`).kind).toBe("invalid");

    // One trailing slash is the same address, not a malformed one, and is
    // normalised out of the address bar.
    expect(route(`/${WS}/${UUID}/`)).toEqual({ kind: "doc", workspace, uuid: UUID });
    expect(canonicalPath(route(`/${WS}/${UUID}/`))).toBe(`/${WS}/${UUID}`);
    expect(route(`/${WS}/`)).toEqual({ kind: "list", workspace });
  });

  it("accepts an upper-case uuid and round-trips it byte for byte", () => {
    // The shape is checked case-insensitively; the identity is opaque. Folding
    // the case would aim the link at a room nobody stored under that name —
    // room keys, directory keys and `meta.uuid` are all case-sensitive, and the
    // importer does not normalise them — so the document would wait forever.
    const shouted = UUID.toUpperCase();
    expect(route(`/${WS}/${shouted}`)).toEqual({
      kind: "doc",
      workspace,
      uuid: shouted,
    });
    // URL → room → URL, unchanged at every hop.
    expect(canonicalPath(route(`/${WS}/${shouted}`))).toBe(`/${WS}/${shouted}`);
    expect(docPath(WS, shouted)).toBe(`/${WS}/${shouted}`);
    expect(roomForDoc(WS, shouted)).toBe(`${WS}/${shouted}`);
    // And it is the same document to the hydration gate, which compares exactly.
    expect(docIsHydrated(shouted, meta(shouted))).toBe(true);
    expect(docIsHydrated(shouted, meta(UUID))).toBe(false);
  });

  it("leaves an address it cannot resolve exactly as it was opened", () => {
    // Rewriting a bad link would erase the evidence the message is about.
    expect(canonicalPath(route("/other/x"))).toBeNull();
    expect(canonicalPath(route(`/${WS}/nope`))).toBeNull();
    expect(canonicalPath({ kind: "no-workspace" })).toBeNull();
  });

  it("builds the same string the room key uses, so a link is the room", () => {
    expect(docPath(WS, UUID)).toBe(`/${WS}/${UUID}`);
    expect(shareUrl(`${WS}/${UUID}`, "https://uberblick.test")).toBe(
      `https://uberblick.test/${WS}/${UUID}`,
    );
  });
});

/**
 * A stand-in for the sidebar: it shows the path the hook reports, and its
 * button navigates to `to` — the same call `onSelect` makes in the app.
 */
function Probe({ to }: { to: string }): ReactElement {
  const [path, navigate] = useRoutePath();
  return (
    <button type="button" className="probe" onClick={() => navigate(to)}>
      {path}
    </button>
  );
}

describe("the URL and the app are two-way bound", () => {
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
      true;
    window.history.replaceState(null, "", `/${WS}`);
  });

  it("pushes on navigation, and follows Back and Forward out of the history", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    const probe = (): HTMLButtonElement =>
      host.querySelector<HTMLButtonElement>(".probe") as HTMLButtonElement;
    const shown = (): string => probe().textContent ?? "";

    act(() => root.render(<Probe to={`/${WS}/${UUID}`} />));
    expect(shown()).toBe(`/${WS}`);

    // Our own navigation. The browser does not announce a pushState, so the
    // hook has to write both the history and its own state.
    act(() => probe().click());
    expect(window.location.pathname).toBe(`/${WS}/${UUID}`);
    expect(shown()).toBe(`/${WS}/${UUID}`);

    act(() => root.render(<Probe to={`/${WS}/${OTHER}`} />));
    act(() => probe().click());
    expect(shown()).toBe(`/${WS}/${OTHER}`);

    // Back and Forward: the browser announces these, and the hook reads the
    // answer out of `location` rather than trusting a remembered stack.
    await act(async () => {
      window.history.back();
      await waitForPop();
    });
    expect(shown()).toBe(`/${WS}/${UUID}`);
    expect(route(shown())).toEqual({ kind: "doc", workspace, uuid: UUID });

    await act(async () => {
      window.history.forward();
      await waitForPop();
    });
    expect(shown()).toBe(`/${WS}/${OTHER}`);

    act(() => root.unmount());
    host.remove();
  });
});

/** jsdom queues `popstate` rather than firing it inline, like a browser does. */
function waitForPop(): Promise<void> {
  return new Promise((resolve) => {
    window.addEventListener("popstate", () => setTimeout(resolve, 0), { once: true });
  });
}

function meta(uuid: string): DocMeta {
  return { uuid, title: "", tags: [], links: [] };
}

describe("a link whose document has not synced yet is a wait, not a 404", () => {
  it("waits until the document's own content is here, not merely its name", () => {
    expect(docIsHydrated(UUID, null)).toBe(false);
    // An un-hydrated room reads as empty meta. That is not an answer.
    expect(docIsHydrated(UUID, meta(""))).toBe(false);
    // Nor is the *previous* document's meta, still on screen for one effect
    // after the address changes.
    expect(docIsHydrated(UUID, meta(OTHER))).toBe(false);
    // Only the document itself.
    expect(docIsHydrated(UUID, meta(UUID))).toBe(true);
  });
});

/** A connection whose Y.Doc is real, so a merge into it drives the UI. */
function liveConnection(ydoc: Y.Doc, room: string): RoomConnection {
  const base = stubConnection(room) as unknown as Record<string, unknown>;
  return { ...base, ydoc } as unknown as RoomConnection;
}

/** App's wiring for one document: observe its meta, gate the pane on it. */
function LinkedPane({
  connection,
  uuid,
}: {
  connection: RoomConnection;
  uuid: string;
}): ReactElement {
  const docMeta = useDocMeta(connection);
  return (
    <RoutePane
      route={{ kind: "doc", workspace, uuid }}
      connection={connection}
      meta={docMeta}
      author="tester"
      archived={false}
      onRestore={() => {}}
      onSelectThread={() => {}}
    />
  );
}

describe("a fresh deep link does not open a writable empty replica", () => {
  it("keeps waiting while only the directory knows the uuid, and opens on the merge", () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
      true;

    // The ordering a fresh link actually hits: the directory doc is small and
    // syncs first, so the workspace knows this uuid before the document's own
    // room has delivered a single byte.
    const directory = new Y.Doc();
    upsertDirectoryEntry(directory, { uuid: UUID, title: "Annotations" });
    expect(listDirectory(directory).map((entry) => entry.uuid)).toEqual([UUID]);

    const local = new Y.Doc();
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() =>
      root.render(<LinkedPane connection={liveConnection(local, `${WS}/${UUID}`)} uuid={UUID} />),
    );

    // The stub is not a licence to edit: binding here would put blocks and
    // metadata into a replica the real document is about to merge into.
    expect(host.querySelector(".ub-notice")?.textContent).toContain("Waiting for sync");
    expect(host.querySelector(".ub-editor")).toBeNull();

    // Now the document's own room delivers, exactly as sync would.
    const remote = new Y.Doc();
    initDoc(remote, { uuid: UUID, title: "Annotations" });
    act(() => {
      Y.applyUpdate(local, Y.encodeStateAsUpdate(remote));
    });

    // Resolved live, with nothing polled and nothing reloaded.
    expect(host.querySelector(".ub-notice")).toBeNull();
    expect(host.querySelector(".ub-editor")).not.toBeNull();

    act(() => root.unmount());
    host.remove();
  });
});

/**
 * A room that has just been opened: an empty Y.Doc, and an IndexedDB replica
 * that has not been read yet. `load` is that read arriving — content first,
 * then the announcement, which is the order `IndexeddbPersistence` uses.
 */
function openingConnection(room: string): {
  connection: RoomConnection;
  load: (from?: Y.Doc) => void;
} {
  const ydoc = new Y.Doc();
  const status: RoomStatus = {
    connected: false,
    synced: false,
    unsyncedChanges: 0,
    localReplicaLoaded: false,
    hasLocalCache: false,
  };
  const listeners = new Set<(next: RoomStatus) => void>();
  // Deferred, so the promise and the flag say the same thing: both are the
  // local read, and `load` is the only thing that completes it.
  let localReplicaLoaded: () => void = () => {};
  const whenLocalReplicaLoaded = new Promise<void>((resolve) => {
    localReplicaLoaded = resolve;
  });
  const connection = {
    room,
    ydoc,
    provider: { awareness: null },
    status,
    onStatusChange: (listener: (next: RoomStatus) => void) => {
      listeners.add(listener);
      listener({ ...status });
      return () => listeners.delete(listener);
    },
    whenLocalReplicaLoaded,
  } as unknown as RoomConnection;
  return {
    connection,
    load: (from?: Y.Doc) => {
      // Content means there was a cache to read; `load()` with none means the
      // read finished and found nothing. Both end the read.
      if (from !== undefined) {
        Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(from));
        status.hasLocalCache = true;
      }
      status.localReplicaLoaded = true;
      localReplicaLoaded();
      for (const listener of listeners) listener({ ...status });
    },
  };
}

/** Mount `LinkedPane` on `connection` and return the host plus a teardown. */
function mountLinked(
  connection: RoomConnection,
  uuid: string,
): { host: HTMLElement; done: () => void } {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(<LinkedPane connection={connection} uuid={uuid} />));
  return {
    host,
    done: () => {
      act(() => root.unmount());
      host.remove();
    },
  };
}

describe("an unread replica is not a different document (#161)", () => {
  it("says nothing while the room it just re-opened is still reading its replica", () => {
    // Navigating away releases the room: the provider, the IndexedDB
    // persistence and the Y.Doc are all destroyed. Navigating back re-opens
    // from nothing, so `getMeta` answers `uuid: ""` for a document this replica
    // fully holds — and reading that as "answered, and not this document" is
    // what flashed the waiting screen across the pane for a frame.
    const { connection, load } = openingConnection(`main/${UUID}`);
    const { host, done } = mountLinked(connection, UUID);

    expect(host.querySelector(".ub-notice")).toBeNull();
    expect(host.querySelector(".ub-editor")).toBeNull();

    // IndexedDB answers with the document that was there all along.
    const stored = new Y.Doc();
    initDoc(stored, { uuid: UUID, title: "Annotations" });
    act(() => load(stored));

    expect(host.querySelector(".ub-notice")).toBeNull();
    expect(host.querySelector(".ub-editor")).not.toBeNull();
    done();
  });

  it("still waits once the replica has answered and the document is not in it", () => {
    // The other half, and the reason the gate is `localReplicaLoaded` rather
    // than "empty means unknown": a deep link to a uuid this replica does not
    // hold must keep its waiting screen.
    const { connection, load } = openingConnection(`main/${UUID}`);
    const { host, done } = mountLinked(connection, UUID);

    expect(host.querySelector(".ub-notice")).toBeNull();

    act(() => load());

    expect(host.querySelector(".ub-notice")?.textContent).toContain(
      "Waiting for sync",
    );
    expect(host.querySelector(".ub-editor")).toBeNull();
    done();
  });
});

/**
 * An offline connection to an empty document, whose local replica has already
 * been read. A real Y.Doc, because the resolved branch mounts the editor against
 * it — the point of that assertion is that the waiting screen gets out of the
 * way, which is only worth checking if what replaces it actually renders.
 *
 * `localReplicaLoaded: true` is the load-bearing half: it is what makes the
 * empty document an *answer*. A room still reading its replica says nothing —
 * see the re-opened-room tests below.
 */
function stubConnection(room: string): RoomConnection {
  const status: RoomStatus = {
    connected: false,
    synced: false,
    unsyncedChanges: 0,
    localReplicaLoaded: true,
    hasLocalCache: false,
  };
  return {
    room,
    ydoc: new Y.Doc(),
    provider: { awareness: null },
    status,
    onStatusChange: (listener: (next: RoomStatus) => void) => {
      listener(status);
      return () => {};
    },
    whenLocalReplicaLoaded: Promise.resolve(),
  } as unknown as RoomConnection;
}

/**
 * The text `RoutePane` shows for a route, whitespace collapsed.
 *
 * `docMeta` is the replica's answer about the routed room: `null` for "has not
 * answered yet", a `DocMeta` for an answer — whose `uuid` is `""` when the room
 * is genuinely empty.
 */
function paneText(target: Route, docMeta: DocMeta | null): string {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() =>
    root.render(
      <RoutePane
        route={target}
        connection={target.kind === "doc" ? stubConnection(`${WS}/${UUID}`) : null}
        meta={docMeta}
        author="tester"
        archived={false}
        onRestore={() => {}}
        onSelectThread={() => {}}
      />,
    ),
  );
  const text = host.querySelector(".ub-notice")?.textContent ?? "";
  act(() => root.unmount());
  host.remove();
  return text.replace(/\s+/g, " ").trim();
}

describe("an address that resolves to no document says which one, and why", () => {
  it("waits on a document it does not have, naming the id", () => {
    const text = paneText({ kind: "doc", workspace, uuid: UUID }, meta(""));
    expect(text).toContain("Waiting for sync");
    expect(text).toContain(UUID);
    // Never the word for a document that does not exist: it may yet arrive.
    expect(text).not.toContain("not found");
  });

  it("says nothing at all until the replica has answered", () => {
    // The quiet render between a navigation and the room's first read. Drawing
    // the waiting screen from ignorance is what makes switching documents flash.
    expect(paneText({ kind: "doc", workspace, uuid: UUID }, null)).toBe("");
  });

  it("stops waiting once the document is here", () => {
    // The editor pane takes over, so the notice is gone entirely.
    expect(paneText({ kind: "doc", workspace, uuid: UUID }, meta(UUID))).toBe("");
  });

  it("says where to find a workspace id when the address names none", () => {
    const text = paneText({ kind: "no-workspace" }, null);
    expect(text).toContain("No workspace");
    // Web cannot enumerate workspaces, so it names the command that can.
    expect(text).toContain("ub status");
  });

  it("tells a malformed link apart from a missing one", () => {
    const text = paneText(
      { kind: "invalid", reason: "“nope” is not a document uuid.", workspace },
      null,
    );
    expect(text).toContain("Not a document link");
    expect(text).toContain("nope");
  });
});

/**
 * Click the room key on a mounted status line and return what it then says.
 *
 * `segment` is the workspace as the address spells it, which is what the app
 * hands the line — the room key is always the bare uuid.
 */
async function clickCopy(
  segment = WS,
): Promise<{ label: string; ariaLabel: string; said: string }> {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() =>
    root.render(
      <StatusLine connection={stubConnection(`${WS}/${UUID}`)} segment={segment} />,
    ),
  );

  const button = host.querySelector<HTMLButtonElement>(".ub-room");
  const label = button?.textContent ?? "";
  const ariaLabel = button?.getAttribute("aria-label") ?? "";
  await act(async () => {
    button?.click();
  });
  const said = host.querySelector(".ub-copied")?.textContent ?? "";

  act(() => root.unmount());
  host.remove();
  return { label, ariaLabel, said };
}

describe("the room key copies the document's canonical link", () => {
  const realExecCommand = (document as unknown as { execCommand?: unknown }).execCommand;

  afterEach(() => {
    Reflect.deleteProperty(navigator, "clipboard");
    (document as unknown as { execCommand?: unknown }).execCommand = realExecCommand;
  });

  it("copies the address a fresh browser would open, not the bare room key", async () => {
    const written: string[] = [];
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: (text: string) => {
          written.push(text);
          return Promise.resolve();
        },
      },
    });

    const { label, ariaLabel, said } = await clickCopy();

    // The affordance is the line that already named the document — no new chrome.
    expect(label).toBe(`${WS}/${UUID}`);
    // …but the visible label names the document, not the action, so the
    // accessible name has to carry both. `title` is not reliably announced.
    expect(ariaLabel).toBe(`Copy link to ${WS}/${UUID}`);

    // Exactly what `parseRoute` resolves back to this document.
    expect(written).toEqual([`${window.location.origin}/${WS}/${UUID}`]);
    expect(route(new URL(written[0] as string).pathname)).toEqual({
      kind: "doc",
      workspace,
      uuid: UUID,
    });
    expect(said).toBe("link copied");
  });

  it("copies the workspace as the address spells it, slug and all", async () => {
    // Opened at `/<slug>-<uuid>/<doc>`, the copy has to hand back that link.
    // Building it from the room key would silently undecorate somebody's URL on
    // its way out of their own address bar — and the room key, which is what
    // the line is labelled with, keeps carrying the bare uuid either way.
    const written: string[] = [];
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: (text: string) => {
          written.push(text);
          return Promise.resolve();
        },
      },
    });

    const { label } = await clickCopy(DECORATED);

    expect(written).toEqual([`${window.location.origin}/${DECORATED}/${UUID}`]);
    expect(label).toBe(`${WS}/${UUID}`);
    // And it is a link that resolves back to this document.
    expect(route(new URL(written[0] as string).pathname)).toEqual({
      kind: "doc",
      workspace: { uuid: WS, segment: DECORATED },
      uuid: UUID,
    });
  });

  it("still copies where navigator.clipboard does not exist", async () => {
    // The supported plain-http tailnet deployment (REMOTE.md). `navigator
    // .clipboard` is secure-context only, so the whole affordance rides on the
    // shared helper's `execCommand` fallback — a button that is silently dead
    // there is worse than no button.
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: undefined,
    });
    const copied: string[] = [];
    (document as unknown as { execCommand: unknown }).execCommand = (
      command: string,
    ): boolean => {
      if (command !== "copy") return false;
      // What the fallback actually copies is the selection, so read it back
      // from the element it selected rather than trusting the call.
      const active = document.activeElement;
      if (active instanceof HTMLTextAreaElement) copied.push(active.value);
      return true;
    };

    const { said } = await clickCopy();

    expect(copied).toEqual([`${window.location.origin}/${WS}/${UUID}`]);
    expect(said).toBe("link copied");
  });

  it("says so when the copy fails, rather than looking like it worked", async () => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: undefined,
    });
    (document as unknown as { execCommand: unknown }).execCommand = (): boolean => false;

    expect((await clickCopy()).said).toBe("copy failed");
  });
});
