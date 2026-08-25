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
 * 3. **That waiting resolves.** The unsynced state is derived from two
 *    observed witnesses, so it clears itself when either arrives — no polling,
 *    no retry, no reload.
 *
 * Deliberately not here: that Vite serves index.html for a deep URL, and that a
 * fresh browser with an empty IndexedDB lands on the right document. Both are
 * claims about a real server and a real browser profile — `e2e/deep-link.spec.ts`.
 */

import { describe, expect, it, beforeEach } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { ReactElement } from "react";
import * as Y from "yjs";
import type { DirectoryEntry, DocMeta } from "@uberblick/schema";
import { RoutePane } from "../src/ui/App.js";
import { StatusLine } from "../src/ui/EditorPane.js";
import {
  canonicalPath,
  docIsPresent,
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

  it("normalises a shouted uuid instead of rejecting it", () => {
    const shouted = `/main/${UUID.toUpperCase()}`;
    expect(route(shouted)).toEqual({ kind: "doc", uuid: UUID });
    // Which is what puts the canonical spelling in the address bar.
    expect(canonicalPath(route(shouted), "main")).toBe(`/main/${UUID}`);
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

function stub(uuid: string): DirectoryEntry {
  return { uuid, title: "Annotations", tags: [] };
}

describe("a link whose document has not synced yet is a wait, not a 404", () => {
  it("resolves as soon as either witness lands — the stub or the document", () => {
    expect(docIsPresent(UUID, null, [])).toBe(false);
    // Empty meta is what an un-hydrated room reads as; it is not an answer.
    expect(docIsPresent(UUID, meta(""), [])).toBe(false);
    expect(docIsPresent(UUID, meta(""), [stub(OTHER)])).toBe(false);
    // Nor is the *previous* document's meta, which is still on screen for one
    // effect after the address changes.
    expect(docIsPresent(UUID, meta(OTHER), [])).toBe(false);

    // The directory stub arrives over sync…
    expect(docIsPresent(UUID, meta(""), [stub(UUID)])).toBe(true);
    // …or the document's own room hydrates first, directory or no directory.
    expect(docIsPresent(UUID, meta(UUID), [])).toBe(true);
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

/** The text `RoutePane` shows for a route, whitespace collapsed. */
function paneText(target: Route, present: boolean): string {
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
        present={present}
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
    const text = paneText({ kind: "doc", uuid: UUID }, false);
    expect(text).toContain("Waiting for sync");
    expect(text).toContain(UUID);
    // Never the word for a document that does not exist: it may yet arrive.
    expect(text).not.toContain("not found");
  });

  it("stops waiting once the document is here", () => {
    // The editor pane takes over, so the notice is gone entirely.
    expect(paneText({ kind: "doc", uuid: UUID }, true)).toBe("");
  });

  it("names an unknown workspace explicitly, and the one it is configured for", () => {
    const text = paneText({ kind: "unknown-workspace", workspaceId: "elsewhere" }, false);
    expect(text).toContain("Unknown workspace");
    expect(text).toContain("elsewhere");
    expect(text).toContain("main");
  });

  it("tells a malformed link apart from a missing one", () => {
    const text = paneText({ kind: "invalid", reason: "“nope” is not a document uuid." }, false);
    expect(text).toContain("Not a document link");
    expect(text).toContain("nope");
  });
});

describe("the room key copies the document's canonical link", () => {
  it("copies the address a fresh browser would open, not the bare room key", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
      true;
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

    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => root.render(<StatusLine connection={stubConnection(`main/${UUID}`)} />));

    const button = host.querySelector<HTMLButtonElement>(".ub-room");
    // The affordance is the line that already named the document — no new chrome.
    expect(button?.textContent).toBe(`main/${UUID}`);

    await act(async () => {
      button?.click();
    });
    // Exactly what `parseRoute` resolves back to this document.
    expect(written).toEqual([`${window.location.origin}/main/${UUID}`]);
    expect(route(new URL(written[0] as string).pathname)).toEqual({
      kind: "doc",
      uuid: UUID,
    });
    expect(host.querySelector(".ub-copied")?.textContent).toBe("link copied");

    act(() => root.unmount());
    host.remove();
  });
});
