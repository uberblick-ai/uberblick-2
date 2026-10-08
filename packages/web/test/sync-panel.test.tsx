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

import { act, render, type RenderResult } from "./react-render.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useCallback, useState } from "react";
import type { ReactElement } from "react";
import * as Y from "yjs";
import { Awareness, removeAwarenessStates } from "y-protocols/awareness";
import { appendBlock, getBlocksFragment, initDoc, insertBlock } from "@uberblick/schema";
import { SyncPanel } from "../src/ui/SyncPanel.js";
import { StatusLine } from "../src/ui/EditorPane.js";
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
    hasReceivedServerState: true,
    writable: true,
    storeRefused: false,
    unsyncedChanges: 0,
    hasAnswered: true,
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
  hubAcked,
  notSharedReason = null,
  lastUpdated,
}: {
  fix: Fixture;
  endpoint?: HubEndpoint | null;
  hubAcked?: boolean | null | undefined;
  notSharedReason?: "no-hub-credentials" | null;
  lastUpdated?: number | undefined;
}): ReactElement {
  const presence = usePresence(fix.connection);
  return (
    <SyncPanel
      connection={fix.connection}
      presence={presence}
      endpoint={endpoint}
      hubAcked={hubAcked}
      notSharedReason={notSharedReason}
      lastUpdated={lastUpdated}
    />
  );
}

function mount(
  fix: Fixture,
  endpoint: HubEndpoint | null = ENDPOINT,
  hubAcked?: boolean | null | undefined,
  lastUpdated?: number | undefined,
  notSharedReason: "no-hub-credentials" | null = null,
): { host: HTMLElement; view: RenderResult } {
  const view = render(
    <Panel
      fix={fix}
      endpoint={endpoint}
      hubAcked={hubAcked}
      lastUpdated={lastUpdated}
      notSharedReason={notSharedReason}
    />,
  );
  const host = view.container;
  // Past every settle window, so the state word is what a reader sees rather
  // than the "offline" every mount starts from.
  act(() => void vi.advanceTimersByTime(5_000));
  return { host, view };
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

/** The room-paired stamp output the shell connects to the details panel. */
function TimestampSurfaces({
  connection,
  stamp,
  open,
}: {
  connection: RoomConnection;
  stamp: number | undefined;
  open: boolean;
}): ReactElement {
  const [shown, setShown] = useState<{
    room: string;
    value: number | undefined;
  } | null>(null);
  const report = useCallback((room: string, value: number | undefined) => {
    setShown({ room, value });
  }, []);
  return (
    <>
      <StatusLine
        connection={connection}
        presence={[]}
        lastUpdated={stamp}
        onLastUpdatedChange={report}
      />
      {open && (
        <SyncPanel
          connection={connection}
          presence={[]}
          endpoint={ENDPOINT}
          lastUpdated={shown?.room === connection.room ? shown.value : undefined}
        />
      )}
    </>
  );
}

describe("the sync panel renders the state this client holds", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("gives the status line's edit stamp an exact local time at every age", () => {
    vi.useFakeTimers();
    const exact = new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    });
    for (const stamp of [
      Date.now() - 20 * 60_000,
      Date.now() - 90 * 24 * 60 * 60_000,
    ]) {
      const { host, view } = mount(fixture(), ENDPOINT, undefined, stamp);
      try {
        expect(facts(host)["Last updated"]).toBe(exact.format(stamp));
        expect(
          host.querySelector(".ub-sync-facts time")?.getAttribute("datetime"),
        ).toBe(new Date(stamp).toISOString());
      } finally {
        view.unmount();
      }
    }
  });

  it("has no Last updated row without a usable displayed stamp", () => {
    vi.useFakeTimers();
    for (const stamp of [undefined, Number.NaN, Infinity, Number.MAX_VALUE]) {
      const { host, view } = mount(fixture(), ENDPOINT, undefined, stamp);
      try {
        expect(facts(host)["Last updated"]).toBeUndefined();
      } finally {
        view.unmount();
      }
    }
  });

  it("mirrors the shown age immediately on panel open and clears it on room change", () => {
    vi.useFakeTimers();

    const first = fixture();
    const second = fixture();
    second.connection = {
      ...second.connection,
      room: `${WORKSPACE}/another-document`,
    };
    const stamp = Date.now() - 20 * 60_000;
    const tree = (
      connection: RoomConnection,
      open: boolean,
      value: number | undefined = stamp,
    ) => (
      <TimestampSurfaces connection={connection} stamp={value} open={open} />
    );
    const view = render(tree(first.connection, true));
    const host = view.container;
    const draw = (
      connection: RoomConnection,
      open: boolean,
      value: number | undefined = stamp,
    ): void => {
      view.rerender(tree(connection, open, value));
    };
    expect(host.querySelector(".ub-last-updated")).toBeNull();
    expect(facts(host)["Last updated"]).toBeUndefined();
    act(() => void vi.advanceTimersByTime(300));
    expect(facts(host)["Last updated"]).toBe(
      host.querySelector(".ub-last-updated time")?.getAttribute("title"),
    );
    draw(first.connection, false);
    draw(first.connection, true);
    // The panel's own sync word has a fresh settle window, but the age
    // already visible in the status line remains available immediately.
    expect(facts(host).State).toBe("—");
    expect(facts(host)["Last updated"]).toBe(
      host.querySelector(".ub-last-updated time")?.getAttribute("title"),
    );
    draw(second.connection, true);
    expect(host.querySelector(".ub-last-updated")).toBeNull();
    expect(facts(host)["Last updated"]).toBeUndefined();
    act(() => void vi.advanceTimersByTime(300));
    expect(facts(host)["Last updated"]).toBeDefined();
    draw(second.connection, true, Number.NaN);
    expect(host.querySelector(".ub-last-updated")).toBeNull();
    expect(facts(host)["Last updated"]).toBeUndefined();
  });

  it("makes no room-status claim while the requested connection is absent", () => {
    vi.useFakeTimers();
    const view = render(
      <SyncPanel
        connection={null}
        presence={[]}
        endpoint={ENDPOINT}
      />,
    );
    const host = view.container;
    expect(facts(host)).toEqual({
      Hub: ENDPOINT.url,
      Source: "served /uberblick-config.json",
      Room: "—",
      State: "—",
      Backlog: "—",
    });
  });

  it("keeps current raw facts available while the state word settles", () => {
    vi.useFakeTimers();
    const fix = fixture({ unsyncedChanges: 3 });
    const view = render(<Panel fix={fix} />);
    const host = view.container;
    expect(facts(host)).toEqual({
      Hub: ENDPOINT.url,
      Source: "served /uberblick-config.json",
      Room: ROOM,
      State: "—",
      Backlog: "3 sync messages unacked",
    });
  });

  it("names the endpoint, the room, the state and the backlog's unit", () => {
    vi.useFakeTimers();
    const fix = fixture({ connected: true, synced: true, unsyncedChanges: 4 });
    const { host } = mount(fix);
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
    });
  });

  it("says offline the moment the hub goes away, with the backlog still named", () => {
    vi.useFakeTimers();
    const fix = fixture({ connected: false, synced: false, unsyncedChanges: 1 });
    const { host } = mount(fix);
    expect(facts(host).State).toBe("offline");
    expect(facts(host).Backlog).toBe("1 sync message unacked");
  });

  it("shows the same two locally served facts as the status line", () => {
    vi.useFakeTimers();
    const remote: HubEndpoint = {
      url: "wss://remote.example/ws",
      source: "document",
    };
    for (const [hubAcked, expected] of [
      [false, "not synced with hub"],
      [true, "synced with hub"],
      [null, "—"],
    ] as const) {
      const { host, view } = mount(fixture(), remote, hubAcked);
      try {
        expect(facts(host)).toMatchObject({
          Hub: remote.url,
          Source: "served /uberblick-config.json",
          State: "saved here",
          "Hub state": expected,
        });
      } finally {
        view.unmount();
      }
    }
  });

  it("names a local workspace and omits an upstream state it cannot claim", () => {
    vi.useFakeTimers();
    const { host } = mount(fixture(), { url: "local", source: "document" }, true);
    expect(facts(host)).toMatchObject({ Hub: "local", State: "saved here" });
    expect(facts(host)["Hub state"]).toBeUndefined();
  });

  it("suppresses the upstream fact when the local room is not writable", () => {
    vi.useFakeTimers();
    const { host } = mount(
      fixture({ connected: false, synced: false, writable: false }),
      ENDPOINT,
      true,
    );
    expect(facts(host)).toMatchObject({
      Hub: "—",
      Source: "—",
      State: "offline",
    });
    expect(facts(host)["Hub state"]).toBeUndefined();
  });

  it("explains why durable local edits are not shared with the hub", () => {
    vi.useFakeTimers();
    const { host } = mount(fixture(), ENDPOINT, false, undefined, "no-hub-credentials");
    expect(facts(host)).toMatchObject({
      State: "saved here",
      "Hub state": "not shared with hub",
      Reason: "this machine has no credentials for its hub",
    });
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
      const { host, view } = mount(fixture(status));
      try {
        return facts(host);
      } finally {
        view.unmount();
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
        "the hub is older than this app — update the hub (app 2, hub 1); " +
          "this document is not saved",
        { protocolMismatch: { hub: 1, client: 2 } },
      ],
      ["no hub token", TOKEN_MISSING, { tokenMissing: true }],
      [
        "not authorized",
        `${AUTH_REJECTED}; this document is not saved`,
        { authFailed: true },
      ],
    ];
    for (const [word, reason, status] of refused) {
      const { host, view } = mount(fixture(status));
      try {
        expect(facts(host).State).toBe(word);
        expect(facts(host).Reason).toBe(reason);
      } finally {
        view.unmount();
      }
    }
  });

  it("lists both sessions, with the caret's block only where there is one", () => {
    vi.useFakeTimers();
    const fix = fixture();
    const agent =
      "Claude · documentation agent reviewing the complete production corpus";
    const person =
      "Alexandria Montgomery · Engineering collaboration session on the production workspace";
    publish(fix, AGENT_CLIENT, { name: agent, color: "#7b5ec7" }, 1);
    publish(
      fix,
      HUMAN_CLIENT,
      { name: person, color: "#0c853d" },
      null,
      WEB_MARKER,
    );
    const { host } = mount(fix);
    // Sorted by client id, so the list does not reorder itself under a reader.
    expect(presentNow(host)).toEqual([
      `${agent} block 2`,
      // No cursor published: the row is still drawn, and says nothing about
      // where — a block number nobody could point at would be an invention.
      person,
    ]);
    // Avatar plus name, each in its own presence colour — the one its cursor
    // carries in the prose (#494).
    const avatars = [...host.querySelectorAll<HTMLElement>(".ub-avatar")];
    expect(
      avatars.map((avatar) => [avatar.textContent, avatar.style.borderColor]),
    ).toEqual([
      ["C🤖", "rgb(123, 94, 199)"],
      ["A", "rgb(12, 133, 61)"],
    ]);
    // Announced once: the visible name is the row's accessible name, and the
    // avatar in front of it is decoration. A labelled avatar here would make
    // a screen reader read every session twice.
    for (const avatar of avatars) {
      expect(avatar.getAttribute("aria-hidden")).toBe("true");
      expect(avatar.getAttribute("aria-label")).toBeNull();
      expect(avatar.getAttribute("title")).toBeNull();
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
    const { host } = mount(fix);
    expect(presentNow(host)).toEqual(["Claude · demo agent block 2"]);
    act(() => {
      insertBlock(fix.ydoc, null, { type: "paragraph", text: "a new first" });
    });
    expect(presentNow(host)).toEqual(["Claude · demo agent block 3"]);
  });

  it("drops a session when its awareness state goes away", () => {
    vi.useFakeTimers();
    const fix = fixture();
    publish(fix, AGENT_CLIENT, { name: "Claude · demo agent", color: "#7b5ec7" }, 0);
    const { host } = mount(fix);
    expect(presentNow(host)).toEqual(["Claude · demo agent block 1"]);
    act(() => {
      removeAwarenessStates(fix.awareness, [AGENT_CLIENT], "test");
    });
    expect(presentNow(host)).toEqual([]);
    expect(host.querySelector(".ub-presence")).toBeNull();
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
    const { host } = mount(fix, {
      url: "ws://localhost:1234",
      source: "define",
    });
    expect(facts(host).Hub).toBe("ws://localhost:1234");
    expect(facts(host).Source).toBe(
      "compiled default, /uberblick-config.json not used",
    );
  });

  it("says the same of a build that carried no endpoint of its own", () => {
    vi.useFakeTimers();
    const fix = fixture();
    const { host } = mount(fix, {
      url: "ws://localhost:1234",
      source: "fallback",
    });
    expect(facts(host).Source).toBe(
      "in-code default, /uberblick-config.json not used",
    );
  });

  it("says so rather than guessing while the endpoint is still resolving", () => {
    vi.useFakeTimers();
    const fix = fixture();
    const view = render(<Panel fix={fix} endpoint={null} />);
    const host = view.container;
    // Never a fallback address: the panel exists to say which hub this client
    // dialled, and a plausible guess is the one answer it must not give.
    expect(facts(host).Hub).toBe("—");
    expect(facts(host).Source).toBe("—");
  });
});
