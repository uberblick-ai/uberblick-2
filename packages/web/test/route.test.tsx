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
 * fresh browser lands on the right document. Both are claims about a real
 * server and a real browser profile — `e2e/deep-link.spec.ts`.
 */

import { act, render } from "./react-render.js";
import { within } from "@testing-library/react";
import { afterEach, describe, expect, it, beforeEach } from "vitest";
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
import { DocMetaLine } from "../src/ui/DocChrome.js";
import { useDocMeta } from "../src/ui/hooks.js";
import {
  canonicalPath,
  docIsHydrated,
  docPath,
  parseRoute,
  settingsPath,
  shareUrl,
  useRoutePath,
} from "../src/ui/route.js";
import type { Route } from "../src/ui/route.js";
import type { RoomConnection, RoomStatus } from "../src/collab/rooms.js";
import type { RemotePresence } from "../src/ui/doc-chrome.js";

/** Nobody else in the room: these cases are about addresses, not the strip. */
const NOBODY: readonly RemotePresence[] = [];

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

describe("an address names a document, a workspace mode, or neither", () => {
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

  it("reserves General, Tags and Access as the workspace-settings address set", () => {
    expect(route(`/${WS}/settings`)).toEqual({
      kind: "settings",
      workspace,
      page: "general",
    });
    expect(route(`/${WS}/settings/`)).toEqual({
      kind: "settings",
      workspace,
      page: "general",
    });
    expect(route(`/${WS}/settings/tags`)).toEqual({
      kind: "settings",
      workspace,
      page: "tags",
    });
    expect(settingsPath(WS)).toBe(`/${WS}/settings`);
    expect(settingsPath(WS, "tags")).toBe(`/${WS}/settings/tags`);
    expect(route(`/${WS}/settings/access`)).toEqual({ kind: "settings", workspace, page: "access" });
    expect(settingsPath(WS, "access")).toBe(`/${WS}/settings/access`);
    expect(canonicalPath(route(`/${WS}/SETTINGS/ACCESS/`))).toBe(`/${WS}/settings/access`);
    expect(canonicalPath(route(`/${WS}/settings/`))).toBe(`/${WS}/settings`);
    expect(canonicalPath(route(`/${WS}/settings/TAGS/`))).toBe(
      `/${WS}/settings/tags`,
    );
    expect(canonicalPath(route(`/${WS}/SETTINGS/TAGS`))).toBe(`/${WS}/settings/tags`);

    for (const invalid of ["general", "unknown", "tags/more", "access/more"]) {
      const nested = route(`/${WS}/settings/${invalid}`);
      expect(nested.kind).toBe("invalid");
      expect(nested.kind === "invalid" && nested.workspace).toEqual(workspace);
    }
  });

  it("folds the reserved corpus-list segment before checking document identity", () => {
    expect(route(`/${WS}/ALL`)).toEqual({ kind: "all", workspace });
    expect(canonicalPath(route(`/${WS}/ALL`))).toBe(`/${WS}/all`);
  });

  it("says so when nothing names a workspace, rather than guessing one", () => {
    // A build with no `WORKSPACE_ID` has no `/`: this client cannot enumerate
    // workspaces, and inventing one would open a corpus nobody chose.
    expect(parseRoute("/", null)).toEqual({ kind: "no-workspace", reason: "absent" });
    // A build whose value is not a workspace id has none either — and says so,
    // because "carries none" and "carries a rejected one" have different fixes.
    expect(parseRoute("/", "main")).toEqual({
      kind: "no-workspace",
      reason: "invalid",
      configured: "main",
    });
  });

  it("calls a first segment that is not a workspace id an invalid link", () => {
    // `WS.toUpperCase()` is there because the case rule is the same one the
    // document segment now answers to: a workspace id is lowercase, and a
    // shouted one is not a workspace this client can fold into an id it knows.
    for (const bad of ["other", "main", `${WS}x`, `foo--${WS}`, WS.toUpperCase()]) {
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
    for (const bad of ["not-a-uuid", "1234", `${UUID}x`, "%zz", "NOT-A-UUID"]) {
      const parsed = route(`/${WS}/${bad}`);
      expect(parsed.kind).toBe("invalid");
      // The workspace survives a mistyped document, so the sidebar does not
      // empty itself over a bad link.
      expect(parsed.kind === "invalid" && parsed.workspace).toEqual(workspace);
      expect(parsed.kind === "invalid" && parsed.reason).toBe(
        `“${bad}” is not a document uuid.`,
      );
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

  it("folds a shouted document uuid to the document it names, and says so in the address bar", () => {
    // One case rule for both uuids in an address (#196): the workspace segment
    // is lowercase-only, and the document segment now is too. Rejecting the
    // shouted spelling would break links that predate the rule, so it resolves
    // — document uuids are generated lowercase, so an upper-case one is a
    // mis-spelling of a lowercase identity, not an identity of its own.
    const shouted = UUID.toUpperCase();
    expect(route(`/${WS}/${shouted}`)).toEqual({ kind: "doc", workspace, uuid: UUID });
    // The redirect: `canonicalPath` hands back the folded address, which the app
    // replaces the URL with — the same treatment a trailing slash gets.
    expect(canonicalPath(route(`/${WS}/${shouted}`))).toBe(`/${WS}/${UUID}`);
    // And the room that address opens is the one the document was stored under,
    // which is the whole reason the fold happens before the room key is built.
    expect(roomForDoc(WS, UUID)).toBe(`${WS}/${UUID}`);
    expect(docIsHydrated(UUID, meta(UUID))).toBe(true);
  });

  it("accepts document identities without restricting version or variant nibbles", () => {
    const external = "FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF";
    const canonical = external.toLowerCase();
    expect(route(`/${WS}/${external}`)).toEqual({
      kind: "doc",
      workspace,
      uuid: canonical,
    });
    expect(canonicalPath(route(`/${WS}/${external}`))).toBe(`/${WS}/${canonical}`);
  });

  it("leaves an address it cannot resolve exactly as it was opened", () => {
    // Rewriting a bad link would erase the evidence the message is about.
    expect(canonicalPath(route("/other/x"))).toBeNull();
    expect(canonicalPath(route(`/${WS}/nope`))).toBeNull();
    expect(canonicalPath({ kind: "no-workspace", reason: "absent" })).toBeNull();
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
    window.history.replaceState(null, "", `/${WS}`);
  });

  it("pushes on navigation, and follows Back and Forward out of the history", async () => {
    const view = render(<Probe to={`/${WS}/${UUID}`} />);
    const host = view.container;
    const probe = (): HTMLButtonElement =>
      within(host).getByRole<HTMLButtonElement>("button", { name: /^\// });
    const shown = (): string => probe().textContent ?? "";

    expect(shown()).toBe(`/${WS}`);

    // Our own navigation. The browser does not announce a pushState, so the
    // hook has to write both the history and its own state.
    act(() => probe().click());
    expect(window.location.pathname).toBe(`/${WS}/${UUID}`);
    expect(shown()).toBe(`/${WS}/${UUID}`);

    view.rerender(<Probe to={`/${WS}/${OTHER}`} />);
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
  });
});

/** jsdom queues `popstate` rather than firing it inline, like a browser does. */
function waitForPop(): Promise<void> {
  return new Promise((resolve) => {
    window.addEventListener("popstate", () => setTimeout(resolve, 0), { once: true });
  });
}

function meta(uuid: string): DocMeta {
  return { uuid, title: "", tags: [], description: null, links: [] };
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
      presence={NOBODY}
      meta={docMeta}
      author="tester"
      archived={false}
      docLinks={null}
      onRestore={() => {}}
      onSelectThread={() => {}}
    />
  );
}

describe("a fresh deep link does not open a writable empty replica", () => {
  it("keeps waiting while only the directory knows the uuid, and opens on the merge", () => {
    // The ordering a fresh link actually hits: the directory doc is small and
    // syncs first, so the workspace knows this uuid before the document's own
    // room has delivered a single byte.
    const directory = new Y.Doc();
    upsertDirectoryEntry(directory, { uuid: UUID, title: "Annotations" });
    expect(listDirectory(directory).map((entry) => entry.uuid)).toEqual([UUID]);

    const local = new Y.Doc();
    const view = render(<LinkedPane connection={liveConnection(local, `${WS}/${UUID}`)} uuid={UUID} />);
    const host = view.container;

    // The stub is not a licence to edit: binding here would put blocks and
    // metadata into a replica the real document is about to merge into.
    expect(notice(host)?.textContent).toContain("Waiting for sync");
    expect(within(host).queryByRole("textbox", { name: "Document content" })).toBeNull();

    // AC3 is about the document page, and this screen is one — it is this
    // document's address, showing why it is not here yet. The control moved to
    // the identity line, which this screen does not draw, so it is rendered
    // here too; a link is *more* worth sending from a document that has not
    // arrived, and the address bar is not a keyboard-reachable control
    // (Codex round 1).
    const copy = within(host).getByRole("button", { name: `Copy link — copies the canonical document URL for ${WS}/${UUID}` });
    expect(copy?.textContent).toBe("Copy link");
    expect(copy?.getAttribute("aria-label")).toBe(
      `Copy link — copies the canonical document URL for ${WS}/${UUID}`,
    );

    // Now the document's own room delivers, exactly as sync would.
    const remote = new Y.Doc();
    initDoc(remote, { uuid: UUID, title: "Annotations" });
    act(() => {
      Y.applyUpdate(local, Y.encodeStateAsUpdate(remote));
    });

    // Resolved live, with nothing polled and nothing reloaded.
    expect(notice(host)).toBeNull();
    expect(within(host).queryByRole("textbox", { name: "Document content" })).not.toBeNull();
  });
});

/**
 * A room that has just been opened: an empty Y.Doc, before its server has
 * answered. `answer` is that response arriving — content first, then the
 * status announcement, like the real provider's sync event.
 */
function openingConnection(room: string): {
  connection: RoomConnection;
  answer: (from?: Y.Doc) => void;
} {
  const ydoc = new Y.Doc();
  const status: RoomStatus = {
    connected: false,
    synced: false,
    hasReceivedServerState: false,
    writable: true,
    storeRefused: false,
    unsyncedChanges: 0,
    hasAnswered: false,
    protocolMismatch: null,
    authFailed: false,
    tokenMissing: false,
  };
  const listeners = new Set<(next: RoomStatus) => void>();
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
  } as unknown as RoomConnection;
  return {
    connection,
    answer: (from?: Y.Doc) => {
      if (from !== undefined) {
        Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(from));
      }
      status.hasAnswered = true;
      for (const listener of listeners) listener({ ...status });
    },
  };
}

/** Mount `LinkedPane` on `connection` and return its host. */
function mountLinked(
  connection: RoomConnection,
  uuid: string,
): { host: HTMLElement } {
  const view = render(<LinkedPane connection={connection} uuid={uuid} />);
  const host = view.container;
  return {
    host,
  };
}

describe("a room that has not answered is not a different document (#161)", () => {
  it("says nothing while the room it just re-opened is awaiting the server", () => {
    // Navigating away releases the room and its Y.Doc. Navigating back re-opens
    // from nothing, so `getMeta` answers `uuid: ""` for a document the server
    // holds — and reading that as "answered, and not this document" flashes the
    // waiting screen across the pane for a frame.
    const { connection, answer } = openingConnection(`${WS}/${UUID}`);
    const { host } = mountLinked(connection, UUID);

    expect(notice(host)).toBeNull();
    expect(within(host).queryByRole("textbox", { name: "Document content" })).toBeNull();

    // The server answers with the document that was there all along.
    const stored = new Y.Doc();
    initDoc(stored, { uuid: UUID, title: "Annotations" });
    act(() => answer(stored));

    expect(notice(host)).toBeNull();
    expect(within(host).queryByRole("textbox", { name: "Document content" })).not.toBeNull();
  });

  it("waits once the server has answered and the document is not in the room", () => {
    // The other half, and the reason the gate is `hasAnswered` rather than
    // "empty means unknown": a deep link whose room is empty must keep its
    // waiting screen.
    const { connection, answer } = openingConnection(`${WS}/${UUID}`);
    const { host } = mountLinked(connection, UUID);

    expect(notice(host)).toBeNull();

    act(() => answer());

    expect(notice(host)?.textContent).toContain(
      "Waiting for sync",
    );
    expect(within(host).queryByRole("textbox", { name: "Document content" })).toBeNull();
  });
});

/**
 * An offline connection to an empty document whose server has already answered.
 * A real Y.Doc, because the resolved branch mounts the editor against it — the
 * point of that assertion is that the waiting screen gets out of the way, which
 * is only worth checking if what replaces it actually renders.
 *
 * `hasAnswered: true` is the load-bearing half: it makes the empty document an
 * *answer*. A room still awaiting its server says nothing — see the re-opened
 * room tests above.
 */
function stubConnection(room: string): RoomConnection {
  const status: RoomStatus = {
    connected: false,
    synced: false,
    hasReceivedServerState: true,
    writable: true,
    storeRefused: false,
    unsyncedChanges: 0,
    hasAnswered: true,
    protocolMismatch: null,
    authFailed: false,
    tokenMissing: false,
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
  } as unknown as RoomConnection;
}

/** Find the notice through its visible lead, then read the complete sentence. */
function notice(host: HTMLElement): HTMLElement | null {
  return within(host).queryByText(/^(Waiting for sync\.|No workspace\.|Not a document link\.)$/)?.parentElement ?? null;
}

/**
 * The text `RoutePane` shows for a route, whitespace collapsed.
 *
 * `docMeta` is the replica's answer about the routed room: `null` for "has not
 * answered yet", a `DocMeta` for an answer — whose `uuid` is `""` when the room
 * is genuinely empty.
 */
function paneText(target: Route, docMeta: DocMeta | null): string {
  const view = render(
    <RoutePane
      route={target}
      connection={target.kind === "doc" ? stubConnection(`${WS}/${UUID}`) : null}
      presence={NOBODY}
      meta={docMeta}
      author="tester"
      archived={false}
      docLinks={null}
      onRestore={() => {}}
      onSelectThread={() => {}}
    />,
  );
  const host = view.container;
  const text = notice(host)?.textContent ?? "";

  return text.replace(/\s+/g, " ").trim();
}

describe("an address that resolves to no document says which one, and why", () => {
  it("waits on a document it does not have, naming the id", () => {
    const text = paneText({ kind: "doc", workspace, uuid: UUID }, meta(""));
    expect(text).toContain("Waiting for sync");
    expect(text).toContain(UUID);
    expect(text).toContain("has not reached this page yet");
    expect(text).not.toContain("replica");
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

  it("says where to find a workspace id when the client is configured with none", () => {
    const text = paneText({ kind: "no-workspace", reason: "absent" }, null);
    expect(text).toContain("No workspace");
    // Web cannot enumerate workspaces, so it names the command that can.
    expect(text).toContain("ub status");
    expect(text).toContain("configured with none to fall back to");
  });

  it("names the rejected value when the configured one is not an id", () => {
    // The misconfigured client — a stale `WORKSPACE_ID=main`. Saying it carries
    // none would send the developer looking for a value that is there.
    const text = paneText(
      { kind: "no-workspace", reason: "invalid", configured: "main" },
      null,
    );
    expect(text).toContain("configured with main, which is not a workspace id");
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
 * Click the copy control on a mounted identity line and return what it says.
 *
 * `segment` is the workspace as the address spells it, which is what the app
 * hands the line — the room key is always the bare uuid.
 */
async function clickCopy(
  segment = WS,
): Promise<{
  label: string;
  ariaLabel: string;
  said: string;
  revisionIsInsideControl: boolean;
}> {
  const view = render(
    <DocMetaLine
      connection={stubConnection(`${WS}/${UUID}`)}
      segment={segment}
      meta={meta(UUID)}
      archived={false}
    />,
  );
  const host = view.container;

  const button = within(host).getByRole<HTMLButtonElement>("button", { name: `uuid ${UUID.slice(0, 8)} — copies the canonical document URL for ${segment}/${UUID}` });
  const label = button?.textContent ?? "";
  const ariaLabel = button?.getAttribute("aria-label") ?? "";
  const revisionIsInsideControl =
    button.contains(within(host).getByText(/· rev /));
  await act(async () => {
    button?.click();
  });
  const said = within(button.parentElement!).getByRole("status").textContent ?? "";

  return { label, ariaLabel, said, revisionIsInsideControl };
}

describe("the copy control hands back the document's canonical link", () => {
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

    const { label, ariaLabel, said, revisionIsInsideControl } = await clickCopy();

    // The short uuid is the action now; the revision remains outside it.
    expect(label).toBe(`uuid ${UUID.slice(0, 8)}`);
    expect(revisionIsInsideControl).toBe(false);
    // The accessible name adds the part a reader cannot see — the address that
    // lands on the clipboard. `title` is not reliably announced.
    expect(ariaLabel).toBe(
      `uuid ${UUID.slice(0, 8)} — copies the canonical document URL for ${WS}/${UUID}`,
    );

    // Exactly what `parseRoute` resolves back to this document.
    expect(written).toEqual([`${window.location.origin}/${WS}/${UUID}`]);
    expect(route(new URL(written[0] as string).pathname)).toEqual({
      kind: "doc",
      workspace,
      uuid: UUID,
    });
    expect(said).toBe("URL copied to clipboard");
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

    const { label, ariaLabel } = await clickCopy(DECORATED);

    expect(written).toEqual([`${window.location.origin}/${DECORATED}/${UUID}`]);
    expect(label).toBe(`uuid ${UUID.slice(0, 8)}`);
    // The accessible name announces what the click actually produces, so it
    // follows the address rather than the room key the button no longer shows.
    expect(ariaLabel).toBe(
      `uuid ${UUID.slice(0, 8)} — copies the canonical document URL for ${DECORATED}/${UUID}`,
    );
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
    expect(said).toBe("URL copied to clipboard");
  });

  it("says so when the copy fails, rather than looking like it worked", async () => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: undefined,
    });
    (document as unknown as { execCommand: unknown }).execCommand = (): boolean => false;

    expect((await clickCopy()).said).toBe("Copy failed");
  });
});
