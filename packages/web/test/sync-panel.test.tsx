/**
 * The sync detail panel (#72): what a reader is told when they ask about sync.
 *
 * Everything the panel draws is client-held state, so the test supplies exactly
 * that and nothing else — a Y.Doc with blocks, a real Awareness carrying two
 * foreign sessions, a connection that only reports status, and the endpoint the
 * shell resolved. No hub, no provider, no socket: a panel that needed one to
 * say whether it was connected would have nothing to show in the outage it
 * exists for.
 *
 * What is worth pinning is the truthfulness: the endpoint and the room it
 * actually names, the backlog in the unit the status line uses, and a
 * present-now list that follows awareness in both directions.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import type { ReactElement } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import * as Y from "yjs";
import { Awareness, removeAwarenessStates } from "y-protocols/awareness";
import { appendBlock, getBlocksFragment, initDoc, insertBlock } from "@uberblick/schema";
import { SyncPanel } from "../src/ui/SyncPanel.js";
import { usePresence } from "../src/ui/hooks.js";
import type { HubEndpoint } from "../src/config.js";
import type { RoomConnection, RoomStatus } from "../src/collab/rooms.js";
import { TOKEN_MISSING } from "../src/ui/status-reading.js";
import { AUTH_REJECTED } from "@uberblick/hub/protocol";

/** A workspace id is a uuid. */
const WORKSPACE = "6f4c8a51-2b7d-4e39-9a06-c81d3f572be4";
const DOC_UUID = "9f3c1a2b-0000-4000-8000-0123456789ab";
const ROOM = `${WORKSPACE}/${DOC_UUID}`;

/** The endpoint the shell resolved — never a hardcoded address in the panel. */
const ENDPOINT: HubEndpoint = { url: "ws://hub.example:1234", source: "document" };

/** The foreign client ids standing in for an agent and a second browser tab. */
const AGENT_CLIENT = 424_242;
const HUMAN_CLIENT = 515_151;

/** The `client` markers each of them publishes (#494) — the wire values. */
const AGENT_MARKER = "agent";
const WEB_MARKER = "web";

interface Fixture {
  ydoc: Y.Doc;
  awareness: Awareness;
  connection: RoomConnection;
}

function fixture(status: Partial<RoomStatus> = {}): Fixture {
  const ydoc = new Y.Doc();
  initDoc(ydoc, { uuid: DOC_UUID, title: "Sync and offline" });
  appendBlock(ydoc, { type: "paragraph", text: "first block" });
  appendBlock(ydoc, { type: "paragraph", text: "second block" });
  const awareness = new Awareness(ydoc);
  const full: RoomStatus = {
    connected: true,
    synced: true,
    unsyncedChanges: 0,
    localReplicaLoaded: true,
    hasLocalCache: false,
    protocolMismatch: null,
    authFailed: false,
    tokenMissing: false,
    ...status,
  };
  const connection = {
    room: ROOM,
    ydoc,
    provider: { awareness },
    status: full,
    onStatusChange: (listener: (next: RoomStatus) => void) => {
      listener(full);
      return () => {};
    },
  } as unknown as RoomConnection;
  return { ydoc, awareness, connection };
}

/** The Y.XmlText of one block — what a caret is anchored in. */
function blockText(ydoc: Y.Doc, index: number): Y.XmlText {
  const element = getBlocksFragment(ydoc).get(index);
  if (!(element instanceof Y.XmlElement)) throw new Error("no such block");
  const text = element.firstChild;
  if (!(text instanceof Y.XmlText)) throw new Error("block has no text");
  return text;
}

/**
 * Publish a foreign session, in the wire format an MCP session uses:
 * relative-position JSON under `cursor`, `user` beside it, and the session's own
 * `client` marker (#494) beside both. `blockIndex` null is a session publishing
 * presence with no caret — a tab that has not been clicked into, which the list
 * still has to name.
 */
function publish(
  fix: Fixture,
  clientId: number,
  user: { name: string; color: string },
  blockIndex: number | null,
  client: string = AGENT_MARKER,
): void {
  const cursor =
    blockIndex === null
      ? null
      : (() => {
          const anchor = Y.relativePositionToJSON(
            Y.createRelativePositionFromTypeIndex(
              blockText(fix.ydoc, blockIndex),
              3,
            ),
          );
          return { anchor, head: anchor };
        })();
  fix.awareness.states.set(
    clientId,
    JSON.parse(JSON.stringify({ user, client, cursor })) as Record<string, unknown>,
  );
}

/**
 * What the app does around the panel, in miniature: read the room's presence
 * once and hand it down. The subscription lives in the shell rather than in the
 * panel, so the pill and this list are two views of one snapshot — the test
 * supplies it the way `App` does, and the list still follows awareness live.
 */
function Panel({
  fix,
  endpoint = ENDPOINT,
  docPresent = true,
  onClose = () => {},
}: {
  fix: Fixture;
  endpoint?: HubEndpoint | null;
  docPresent?: boolean;
  onClose?: () => void;
}): ReactElement {
  const presence = usePresence(fix.connection);
  return (
    <SyncPanel
      connection={fix.connection}
      presence={presence}
      endpoint={endpoint}
      docPresent={docPresent}
      onClose={onClose}
    />
  );
}

function mount(
  fix: Fixture,
  endpoint: HubEndpoint | null = ENDPOINT,
  docPresent = true,
): { host: HTMLElement; root: Root } {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() =>
    root.render(<Panel fix={fix} endpoint={endpoint} docPresent={docPresent} />),
  );
  // Past every settle window, so the state word is what a reader sees rather
  // than the "offline" every mount starts from.
  act(() => void vi.advanceTimersByTime(5_000));
  return { host, root };
}

/** The panel's facts, label → value. */
function facts(host: HTMLElement): Record<string, string> {
  const read: Record<string, string> = {};
  for (const row of host.querySelectorAll(".ub-sync-fact")) {
    const label = row.querySelector("dt")?.textContent ?? "";
    read[label] = (row.querySelector("dd")?.textContent ?? "")
      .replace(/\s+/g, " ")
      .trim();
  }
  return read;
}

/**
 * The present-now list, one line per session: the name, and where the caret is
 * when the row says. The two spans are read separately because the gap between
 * them is CSS — `textContent` alone would run them together.
 */
function presentNow(host: HTMLElement): string[] {
  return [...host.querySelectorAll(".ub-presence-row")].map((row) =>
    [".ub-presence-name", ".ub-muted"]
      .map((selector) => row.querySelector(selector)?.textContent ?? "")
      .filter((part) => part !== "")
      .join(" "),
  );
}

describe("the sync panel renders the state this client holds", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("makes no room-status claim while the requested connection is absent", () => {
    vi.useFakeTimers();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
      true;
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() =>
      root.render(
        <SyncPanel
          connection={null}
          presence={[]}
          endpoint={ENDPOINT}
          docPresent={false}
          onClose={() => {}}
        />,
      ),
    );
    try {
      expect(facts(host)).toEqual({
        Hub: ENDPOINT.url,
        Source: "served /uberblick-config.json",
        Room: "—",
        State: "—",
        Backlog: "—",
        "Local copy": "—",
      });
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  });

  it("keeps current raw facts available while the state word settles", () => {
    vi.useFakeTimers();
    const fix = fixture({ unsyncedChanges: 3 });
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => root.render(<Panel fix={fix} />));
    try {
      expect(facts(host)).toEqual({
        Hub: ENDPOINT.url,
        Source: "served /uberblick-config.json",
        Room: ROOM,
        State: "—",
        Backlog: "3 sync messages unacked",
        "Local copy": "unavailable",
      });
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  });

  it("names the endpoint, the room, the state and the backlog's unit", () => {
    vi.useFakeTimers();
    const fix = fixture({ connected: true, synced: true, unsyncedChanges: 4 });
    const { host, root } = mount(fix);
    try {
      expect(facts(host)).toEqual({
        Hub: ENDPOINT.url,
        // Which hub this "synced" is about, and who decided it (#362).
        Source: "served /uberblick-config.json",
        Room: ROOM,
        // A backlog is what stops the state being `synced` — the provider's own
        // flag never comes back down once the handshake raised it.
        State: "syncing…",
        // The status line's wording, from the one place both read it.
        Backlog: "4 sync messages unacked",
        // The local read is over and found nothing — this fixture's browser has
        // no IndexedDB. An answer, not a silence: the status line only says this
        // during an outage, so the panel is where it is always readable (#535).
        "Local copy": "unavailable",
      });
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  });

  it("says offline the moment the hub goes away, with the backlog still named", () => {
    vi.useFakeTimers();
    const fix = fixture({ connected: false, synced: false, unsyncedChanges: 1 });
    const { host, root } = mount(fix);
    try {
      expect(facts(host).State).toBe("offline");
      expect(facts(host).Backlog).toBe("1 sync message unacked");
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  });

  /**
   * The quiet state — and, in the same breath, that no two states read alike.
   *
   * `synced` with an empty backlog is the reading the two cases above leave
   * out, and it is the one a reader opens the panel *not* expecting to be told
   * about: both rows have to say so in words, because a Backlog row that went
   * silent at zero would leave "nothing waiting" and "not reported" looking the
   * same.
   *
   * The three are then compared pairwise rather than counted. One state
   * collapsing into another is how this panel stops being worth opening, and
   * that is what this catches; the *number* of readings is not a contract —
   * #96 adds an auth-failure one — so a test that pinned it would fail the day
   * a fourth earns its place.
   */
  it("says synced with nothing unacked, and no two states read the same", () => {
    vi.useFakeTimers();
    const reading = (status: Partial<RoomStatus>): Record<string, string> => {
      const { host, root } = mount(fixture(status));
      try {
        return facts(host);
      } finally {
        act(() => root.unmount());
        host.remove();
      }
    };
    const offline = reading({ connected: false, synced: false, unsyncedChanges: 0 });
    const busy = reading({ connected: true, synced: true, unsyncedChanges: 4 });
    const quiet = reading({ connected: true, synced: true, unsyncedChanges: 0 });

    expect(quiet.State).toBe("synced");
    expect(quiet.Backlog).toBe("0 sync messages unacked");

    const words = [offline.State, busy.State, quiet.State];
    expect(new Set(words).size).toBe(words.length);
  });

  it("keeps the local-copy row in every state, unknown until the read settles", () => {
    vi.useFakeTimers();
    const localCopy = (status: Partial<RoomStatus>): string | undefined => {
      const { host, root } = mount(fixture(status));
      try {
        return facts(host)["Local copy"];
      } finally {
        act(() => root.unmount());
        host.remove();
      }
    };
    // `hasLocalCache: false` is two different things — a read that found
    // nothing, and a read still running — and the panel must not spell them the
    // same way. `localReplicaLoaded` is what tells them apart.
    expect(localCopy({ localReplicaLoaded: false, hasLocalCache: false })).toBe("—");
    expect(localCopy({ localReplicaLoaded: true, hasLocalCache: false })).toBe(
      "unavailable",
    );
    expect(localCopy({ localReplicaLoaded: true, hasLocalCache: true })).toBe(
      "available",
    );
    // Including where the reader is least able to check for themselves.
    expect(
      localCopy({
        protocolMismatch: { hub: 2, client: 1 },
        localReplicaLoaded: true,
        hasLocalCache: true,
      }),
    ).toBe("available");
  });

  it("knows nothing about a document that has not reached this replica", () => {
    // The panel opens over the waiting screen too. A checkpoint can prove the
    // room was cached, but not that the deep-linked document now on the route
    // is the content this replica actually holds (#601). Unknown, in the
    // panel's own word for it, rather than a promise.
    vi.useFakeTimers();
    const { host, root } = mount(
      fixture({ localReplicaLoaded: true, hasLocalCache: true }),
      ENDPOINT,
      false,
    );
    try {
      expect(facts(host)["Local copy"]).toBe("—");
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  });

  /**
   * #448: the `State` row used to read the calm word for a refused page too,
   * so the panel someone opens *because* sync is broken agreed with the pill
   * that everything was merely busy. The word now comes from the shared
   * derivation, and the sentence it carries gets a row of its own — drawn only
   * under a refusal, which is why the whole-fact-map test above still holds.
   */
  it("names a refusal in State, and why in a Reason row", () => {
    vi.useFakeTimers();
    const refused: Array<[string, string, Partial<RoomStatus>]> = [
      [
        "update required",
        "the hub is older than this app — update the hub (app 2, hub 1)",
        { protocolMismatch: { hub: 1, client: 2 } },
      ],
      ["no hub token", TOKEN_MISSING, { tokenMissing: true }],
      ["not authorized", AUTH_REJECTED, { authFailed: true }],
    ];
    for (const [word, reason, status] of refused) {
      const { host, root } = mount(fixture(status));
      try {
        expect(facts(host).State).toBe(word);
        expect(facts(host).Reason).toBe(reason);
      } finally {
        act(() => root.unmount());
        host.remove();
      }
    }
  });

  it("lists both sessions, with the caret's block only where there is one", () => {
    vi.useFakeTimers();
    const fix = fixture();
    publish(fix, AGENT_CLIENT, { name: "Claude · demo agent", color: "#7b5ec7" }, 1);
    publish(
      fix,
      HUMAN_CLIENT,
      { name: "loitering otter", color: "#0c853d" },
      null,
      WEB_MARKER,
    );
    const { host, root } = mount(fix);
    try {
      // Sorted by client id, so the list does not reorder itself under a reader.
      expect(presentNow(host)).toEqual([
        "Claude · demo agent block 2",
        // No cursor published: the row is still drawn, and says nothing about
        // where — a block number nobody could point at would be an invention.
        "loitering otter",
      ]);
      // Avatar plus name, each in its own presence colour — the one its cursor
      // carries in the prose (#494).
      const avatars = [...host.querySelectorAll<HTMLElement>(".ub-avatar")];
      expect(
        avatars.map((avatar) => [avatar.textContent, avatar.style.borderColor]),
      ).toEqual([
        ["C🤖", "rgb(123, 94, 199)"],
        ["L", "rgb(12, 133, 61)"],
      ]);
      // Announced once: the visible name is the row's accessible name, and the
      // avatar in front of it is decoration. A labelled avatar here would make
      // a screen reader read every session twice.
      for (const avatar of avatars) {
        expect(avatar.getAttribute("aria-hidden")).toBe("true");
        expect(avatar.getAttribute("aria-label")).toBeNull();
        expect(avatar.getAttribute("title")).toBeNull();
      }
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  });

  it("renumbers an idle caret when blocks move above it", () => {
    vi.useFakeTimers();
    const fix = fixture();
    publish(
      fix,
      AGENT_CLIENT,
      { name: "Claude · demo agent", color: "#7b5ec7" },
      1,
    );
    const { host, root } = mount(fix);
    try {
      expect(presentNow(host)).toEqual(["Claude · demo agent block 2"]);
      act(() => {
        insertBlock(fix.ydoc, null, { type: "paragraph", text: "a new first" });
      });
      expect(presentNow(host)).toEqual(["Claude · demo agent block 3"]);
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  });

  it("drops a session when its awareness state goes away", () => {
    vi.useFakeTimers();
    const fix = fixture();
    publish(fix, AGENT_CLIENT, { name: "Claude · demo agent", color: "#7b5ec7" }, 0);
    const { host, root } = mount(fix);
    try {
      expect(presentNow(host)).toEqual(["Claude · demo agent block 1"]);
      act(() => {
        removeAwarenessStates(fix.awareness, [AGENT_CLIENT], "test");
      });
      expect(presentNow(host)).toEqual([]);
      expect(host.querySelector(".ub-presence")).toBeNull();
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  });

  it("consumes the Escape that closes it, so one keypress closes one thing", () => {
    vi.useFakeTimers();
    const fix = fixture();
    // The threads drawer's listener, as `App` registers it (#101): bubble phase
    // on window, skipping an Escape somebody else has already handled. It is
    // registered *first*, the way it would be with the drawer opened first —
    // which is exactly the order that used to close both panels at once.
    let drawerClosed = false;
    const drawer = (event: KeyboardEvent): void => {
      if (event.key === "Escape" && !event.defaultPrevented) drawerClosed = true;
    };
    window.addEventListener("keydown", drawer);
    const closed = vi.fn();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
      true;
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => root.render(<Panel fix={fix} onClose={closed} />));
    try {
      act(() => {
        document.body.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "Escape",
            bubbles: true,
            cancelable: true,
          }),
        );
      });
      expect(closed).toHaveBeenCalledTimes(1);
      // The panel is the topmost layer, so the drawer under it keeps its state:
      // the reader made one gesture and dismissed one thing.
      expect(drawerClosed).toBe(false);
    } finally {
      window.removeEventListener("keydown", drawer);
      act(() => root.unmount());
      host.remove();
    }
  });

  /**
   * #362's fallback path: the served document did not decide this endpoint.
   * Falling back to compiled values is exactly how a tab ends up on the wrong
   * hub while still reading "synced", so the panel says so in words rather
   * than leaving the address to be recognised.
   */
  it("says outright when the endpoint came from compiled values, not the document", () => {
    vi.useFakeTimers();
    const fix = fixture();
    const { host, root } = mount(fix, {
      url: "ws://localhost:1234",
      source: "define",
    });
    try {
      expect(facts(host).Hub).toBe("ws://localhost:1234");
      expect(facts(host).Source).toBe(
        "compiled default, /uberblick-config.json not used",
      );
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  });

  it("says the same of a build that carried no endpoint of its own", () => {
    vi.useFakeTimers();
    const fix = fixture();
    const { host, root } = mount(fix, {
      url: "ws://localhost:1234",
      source: "fallback",
    });
    try {
      expect(facts(host).Source).toBe(
        "in-code default, /uberblick-config.json not used",
      );
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  });

  it("says so rather than guessing while the endpoint is still resolving", () => {
    vi.useFakeTimers();
    const fix = fixture();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
      true;
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => root.render(<Panel fix={fix} endpoint={null} />));
    try {
      // Never a fallback address: the panel exists to say which hub this client
      // dialled, and a plausible guess is the one answer it must not give.
      expect(facts(host).Hub).toBe("—");
      expect(facts(host).Source).toBe("—");
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  });
});
