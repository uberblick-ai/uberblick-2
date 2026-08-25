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

function route(pathname: string): Route {
  return parseRoute(pathname, "main");
}

describe("an address names a document, the list, or neither", () => {
  it("reads /<workspace>/<uuid> as that document", () => {
    expect(route(`/main/${UUID}`)).toEqual({ kind: "doc", uuid: UUID });
  });

  it("reads / and /<workspace> as the list, and canonicalises / to the workspace", () => {
    expect(route("/")).toEqual({ kind: "list" });
    expect(route("/main")).toEqual({ kind: "list" });
    expect(route("/main/")).toEqual({ kind: "list" });
    expect(canonicalPath(route("/"), "main")).toBe("/main");
  });

  it("names a workspace it is not configured for, rather than guessing", () => {
    expect(route(`/other/${UUID}`)).toEqual({
      kind: "unknown-workspace",
      workspaceId: "other",
    });
    expect(route("/other")).toEqual({
      kind: "unknown-workspace",
      workspaceId: "other",
    });
  });

  it("calls a malformed uuid an invalid link — the one case that is not a document", () => {
    // The distinction the whole feature turns on: these can never arrive by
    // sync, so waiting for them would be waiting forever.
    for (const bad of ["not-a-uuid", "1234", `${UUID}x`, "%zz"]) {
      expect(route(`/main/${bad}`).kind).toBe("invalid");
    }
    expect(route(`/main/${UUID}/blocks`).kind).toBe("invalid");
  });

  it("rejects an empty path segment rather than quietly closing the gap", () => {
    // `/main//<uuid>` names no room. Skipping the hole would make a link that
    // is wrong look like one that works, and `parseRoom` rejects empty segments
    // too — the two agree on what a well-formed address is.
    expect(route(`/main//${UUID}`).kind).toBe("invalid");
    expect(route("/main//").kind).toBe("invalid");
    expect(route(`//main/${UUID}`).kind).toBe("invalid");
    expect(route(`/main/${UUID}//`).kind).toBe("invalid");

    // One trailing slash is the same address, not a malformed one, and is
    // normalised out of the address bar.
    expect(route(`/main/${UUID}/`)).toEqual({ kind: "doc", uuid: UUID });
    expect(canonicalPath(route(`/main/${UUID}/`), "main")).toBe(`/main/${UUID}`);
    expect(route("/main/")).toEqual({ kind: "list" });
  });

  it("accepts an upper-case uuid and round-trips it byte for byte", () => {
    // The shape is checked case-insensitively; the identity is opaque. Folding
    // the case would aim the link at a room nobody stored under that name —
    // room keys, directory keys and `meta.uuid` are all case-sensitive, and the
    // importer does not normalise them — so the document would wait forever.
    const shouted = UUID.toUpperCase();
    expect(route(`/main/${shouted}`)).toEqual({ kind: "doc", uuid: shouted });
    // URL → room → URL, unchanged at every hop.
    expect(canonicalPath(route(`/main/${shouted}`), "main")).toBe(`/main/${shouted}`);
    expect(docPath("main", shouted)).toBe(`/main/${shouted}`);
    expect(roomForDoc("main", shouted)).toBe(`main/${shouted}`);
    // And it is the same document to the hydration gate, which compares exactly.
    expect(docIsHydrated(shouted, meta(shouted))).toBe(true);
    expect(docIsHydrated(shouted, meta(UUID))).toBe(false);
  });

  it("leaves an address it cannot resolve exactly as it was opened", () => {
    // Rewriting a bad link would erase the evidence the message is about.
    expect(canonicalPath(route("/other/x"), "main")).toBeNull();
    expect(canonicalPath(route("/main/nope"), "main")).toBeNull();
  });

  it("builds the same string the room key uses, so a link is the room", () => {
    expect(docPath("main", UUID)).toBe(`/main/${UUID}`);
    expect(shareUrl(`main/${UUID}`, "https://uberblick.test")).toBe(
      `https://uberblick.test/main/${UUID}`,
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
    window.history.replaceState(null, "", "/main");
  });

  it("pushes on navigation, and follows Back and Forward out of the history", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    const probe = (): HTMLButtonElement =>
      host.querySelector<HTMLButtonElement>(".probe") as HTMLButtonElement;
    const shown = (): string => probe().textContent ?? "";

    act(() => root.render(<Probe to={`/main/${UUID}`} />));
    expect(shown()).toBe("/main");

    // Our own navigation. The browser does not announce a pushState, so the
    // hook has to write both the history and its own state.
    act(() => probe().click());
    expect(window.location.pathname).toBe(`/main/${UUID}`);
    expect(shown()).toBe(`/main/${UUID}`);

    act(() => root.render(<Probe to={`/main/${OTHER}`} />));
    act(() => probe().click());
    expect(shown()).toBe(`/main/${OTHER}`);

    // Back and Forward: the browser announces these, and the hook reads the
    // answer out of `location` rather than trusting a remembered stack.
    await act(async () => {
      window.history.back();
      await waitForPop();
    });
    expect(shown()).toBe(`/main/${UUID}`);
    expect(route(shown())).toEqual({ kind: "doc", uuid: UUID });

    await act(async () => {
      window.history.forward();
      await waitForPop();
    });
    expect(shown()).toBe(`/main/${OTHER}`);

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
      route={{ kind: "doc", uuid }}
      connection={connection}
      meta={docMeta}
      author="tester"
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
      root.render(<LinkedPane connection={liveConnection(local, `main/${UUID}`)} uuid={UUID} />),
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
 * An offline connection to an empty document. A real Y.Doc, because the
 * resolved branch mounts the editor against it — the point of that assertion is
 * that the waiting screen gets out of the way, which is only worth checking if
 * what replaces it actually renders.
 */
function stubConnection(room: string): RoomConnection {
  const status: RoomStatus = {
    connected: false,
    synced: false,
    unsyncedChanges: 0,
    localReplicaLoaded: false,
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
        connection={target.kind === "doc" ? stubConnection(`main/${UUID}`) : null}
        meta={docMeta}
        author="tester"
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
    const text = paneText({ kind: "doc", uuid: UUID }, meta(""));
    expect(text).toContain("Waiting for sync");
    expect(text).toContain(UUID);
    // Never the word for a document that does not exist: it may yet arrive.
    expect(text).not.toContain("not found");
  });

  it("says nothing at all until the replica has answered", () => {
    // The quiet render between a navigation and the room's first read. Drawing
    // the waiting screen from ignorance is what makes switching documents flash.
    expect(paneText({ kind: "doc", uuid: UUID }, null)).toBe("");
  });

  it("stops waiting once the document is here", () => {
    // The editor pane takes over, so the notice is gone entirely.
    expect(paneText({ kind: "doc", uuid: UUID }, meta(UUID))).toBe("");
  });

  it("names an unknown workspace explicitly, and the one it is configured for", () => {
    const text = paneText({ kind: "unknown-workspace", workspaceId: "elsewhere" }, null);
    expect(text).toContain("Unknown workspace");
    expect(text).toContain("elsewhere");
    expect(text).toContain("main");
  });

  it("tells a malformed link apart from a missing one", () => {
    const text = paneText({ kind: "invalid", reason: "“nope” is not a document uuid." }, null);
    expect(text).toContain("Not a document link");
    expect(text).toContain("nope");
  });
});

/** Click the room key on a mounted status line and return what it then says. */
async function clickCopy(): Promise<{ label: string; ariaLabel: string; said: string }> {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(<StatusLine connection={stubConnection(`main/${UUID}`)} />));

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
    expect(label).toBe(`main/${UUID}`);
    // …but the visible label names the document, not the action, so the
    // accessible name has to carry both. `title` is not reliably announced.
    expect(ariaLabel).toBe(`Copy link to main/${UUID}`);

    // Exactly what `parseRoute` resolves back to this document.
    expect(written).toEqual([`${window.location.origin}/main/${UUID}`]);
    expect(route(new URL(written[0] as string).pathname)).toEqual({
      kind: "doc",
      uuid: UUID,
    });
    expect(said).toBe("link copied");
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

    expect(copied).toEqual([`${window.location.origin}/main/${UUID}`]);
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
