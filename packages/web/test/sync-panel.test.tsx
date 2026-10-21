/**
 * The sync detail panel: what a reader is told when they ask about sync.
 *
 * Everything the panel draws is client-held state, so the test supplies exactly
 * that and nothing else — a Y.Doc with blocks, a connection that only reports
 * status, and the endpoint the shell resolved. No hub, no provider, no socket:
 * a panel that needed one to
 * say whether it was connected would have nothing to show in the outage it
 * exists for.
 *
 * What is worth pinning is the truthfulness: the endpoint and the room it
 * actually names, the backlog in the unit the status line uses, and the code
 * comparison facts as the page and its recorded checks change.
 */

import { act, render, type RenderResult } from "./react-render.js";
import { fireEvent, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import { appendBlock, docRev, getBlocksFragment, getMeta, initDoc, resolveDecisionTopics, setCodeCheck, setKind, upsertDirectoryEntry } from "@uberblick/schema";
import { SyncPanel } from "../src/ui/status/SyncPanel.js";
import { documentPaneState, RoutePane } from "../src/ui/shell/RoutePane.js";
import type { HubEndpoint } from "../src/config.js";
import type { RoomConnection, RoomStatus } from "../src/collab/rooms.js";
import { TOKEN_MISSING } from "../src/ui/status/status-reading.js";
import { AUTH_REJECTED } from "@uberblick/schema/protocol";

/** A workspace id is a uuid. */
const WORKSPACE = "6f4c8a51-2b7d-4e39-9a06-c81d3f572be4";
const DOC_UUID = "9f3c1a2b-0000-4000-8000-0123456789ab";
const ROOM = `${WORKSPACE}/${DOC_UUID}`;
const selectThread = (): void => {};

/** The endpoint the shell resolved — never a hardcoded address in the panel. */
const ENDPOINT: HubEndpoint = { url: "ws://hub.example:1234", source: "document" };

interface Fixture {
  ydoc: Y.Doc;
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
  return { ydoc, connection };
}

/** The Y.XmlText of one block — what a caret is anchored in. */
function blockText(ydoc: Y.Doc, index: number): Y.XmlText {
  const element = getBlocksFragment(ydoc).get(index);
  if (!(element instanceof Y.XmlElement)) throw new Error("no such block");
  const text = element.firstChild;
  if (!(text instanceof Y.XmlText)) throw new Error("block has no text");
  return text;
}

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
  return (
    <SyncPanel
      connection={fix.connection}
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
  for (const term of within(host).queryAllByRole("term")) {
    const label = term.textContent ?? "";
    read[label] = (within(term.parentElement!).getByRole("definition").textContent ?? "")
      .replace(/\s+/g, " ")
      .trim();
  }
  return read;
}

/** Both surfaces receive the selected document's stamp once its pane is hydrated. */
function TimestampSurfaces({
  connection,
  stamp,
  open,
  pane = {},
}: {
  connection: RoomConnection;
  stamp: number | undefined;
  open: boolean;
  pane?: Partial<Parameters<typeof documentPaneState>[0]>;
}): ReactElement {
  const paneProps: Parameters<typeof documentPaneState>[0] = {
    connection,
    route: { kind: "doc", workspace: { uuid: WORKSPACE, segment: WORKSPACE }, uuid: DOC_UUID },
    meta: getMeta(connection.ydoc),
    ...pane,
  };
  const lastUpdated = documentPaneState(paneProps, paneProps.connection?.status.hasAnswered ?? false) === "shown" &&
    !paneProps.connection?.status.deleted ? stamp : undefined;
  return (
    <>
      <RoutePane
        {...paneProps}
        presence={[]}
        author="Reader"
        archived={false}
        updatedAt={stamp}
        docLinks={null}
        onSelectThread={selectThread}
      />
      {open && (
        <SyncPanel
          connection={paneProps.connection}
          endpoint={ENDPOINT}
          lastUpdated={lastUpdated}
        />
      )}
    </>
  );
}

describe("the sync panel renders the state this client holds", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows each repository's recorded comparison, including legacy and absent path facts", () => {
    vi.useFakeTimers();
    const fix = fixture();
    const commit = "a".repeat(40);
    const checkedAt = Date.now();
    setCodeCheck(fix.ydoc, { repository: "owner/matches", commit, result: "matches", rev: docRev(fix.ydoc), paths: ["src/first.ts", "src/second.ts", "README.md"] });
    setCodeCheck(fix.ydoc, { repository: "owner/ahead", commit, result: "ahead", rev: "b".repeat(16), paths: ["src/only.ts"] });
    setCodeCheck(fix.ydoc, { repository: "owner/drift", commit, result: "drift" });
    act(() => void vi.advanceTimersByTime(120_000));
    const { host, view } = mount(fix);
    try {
      expect(within(host).getAllByRole("heading").map((heading) => heading.textContent)).toEqual(["Sync", "Code"]);
      const groups = [...host.querySelectorAll<HTMLElement>(".ub-code-check")];
      const byRepo = Object.fromEntries(groups.map((group) => [facts(group).Repository, facts(group)]));
      const matches = groups.find((group) => facts(group).Repository === "owner/matches")!;
      const ahead = groups.find((group) => facts(group).Repository === "owner/ahead")!;
      expect(byRepo["owner/matches"]).toMatchObject({ Repository: "owner/matches", Compared: "aaaaaaaa · 2 minutes ago", Result: "Matches the code", "Page edited since": "No" });
      expect(within(matches).getAllByText("src/first.ts").length).toBeGreaterThan(0);
      expect(within(matches).getByRole("button", { name: "+2 more" })).toBeDefined();
      expect(within(matches).queryByText("src/second.ts")).toBeNull();
      expect(byRepo["owner/ahead"]).toMatchObject({ Result: "Ahead of the code (intended)", "Page edited since": "Yes" });
      expect(within(ahead).getAllByText("src/only.ts").length).toBeGreaterThan(0);
      expect(within(ahead).queryByRole("button")).toBeNull();
      expect(byRepo["owner/drift"]).toMatchObject({ Result: "Differs from the code", "Page edited since": "Unknown (older check)" });
      expect(byRepo["owner/drift"]).not.toHaveProperty("Looked at");
      for (const group of groups) {
        const link = within(group).getByRole("link", { name: "aaaaaaaa" });
        expect(link.getAttribute("href")).toBe(`https://github.com/${facts(group).Repository}/commit/${commit}`);
        expect(link.getAttribute("target")).toBe("_blank");
        expect(link.getAttribute("rel")).toBe("noopener noreferrer");
        const time = within(group).getByRole("time");
        expect(time.getAttribute("datetime")).toBe(new Date(checkedAt).toISOString());
        expect(time.getAttribute("title")).toBe(new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(checkedAt));
      }
      act(() => void vi.advanceTimersByTime(60_000));
      expect(facts(groups[0]!).Compared).toContain("3 minutes ago");
    } finally { view.unmount(); }
  });

  it("follows content revisions and live checks without inventing code changes", () => {
    vi.useFakeTimers();
    const fix = fixture();
    const { host, view } = mount(fix);
    try {
      expect(within(host).queryByRole("heading", { name: "Code" })).toBeNull();
      const input = { repository: "owner/project", commit: "a".repeat(40), result: "matches" as const };
      act(() => { setCodeCheck(fix.ydoc, { ...input, rev: docRev(fix.ydoc) }); });
      expect(facts(host)["Page edited since"]).toBe("No");
      act(() => { blockText(fix.ydoc, 0).insert(0, "Edited immediately "); });
      expect(facts(host)["Page edited since"]).toBe("Yes");
      act(() => { setCodeCheck(fix.ydoc, { ...input, rev: docRev(fix.ydoc) }); });
      expect(facts(host)["Page edited since"]).toBe("No");
      act(() => { setKind(fix.ydoc, "decision"); });
      expect(within(host).queryByRole("heading", { name: "Code" })).toBeNull();
      expect(host.textContent).not.toMatch(/code changed/i);
    } finally { view.unmount(); }
  });

  it("expands every recorded path in place and starts collapsed on reopening", () => {
    vi.useFakeTimers();
    const fix = fixture();
    const paths = ["src/first.ts", "src/second.ts", "README.md"];
    setCodeCheck(fix.ydoc, { repository: "owner/project", commit: "a".repeat(40), result: "matches", paths });
    const { host, view } = mount(fix);
    try {
      expect(within(host).queryByText(paths[1]!)).toBeNull();
      fireEvent.click(within(host).getByRole("button", { name: "+2 more" }));
      for (const path of paths) {
        expect(within(host).getAllByText(path).length).toBeGreaterThan(0);
      }
      expect(within(host).queryByRole("button", { name: "+2 more" })).toBeNull();
    } finally { view.unmount(); }

    const reopened = mount(fix);
    try {
      expect(within(reopened.host).getAllByText(paths[0]!).length).toBeGreaterThan(0);
      expect(within(reopened.host).queryByText(paths[1]!)).toBeNull();
      expect(within(reopened.host).getByRole("button", { name: "+2 more" })).toBeDefined();
    } finally { reopened.view.unmount(); }
  });

  it("marks each check due only after fourteen days and clears it on a new check", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-01T00:00:00Z"));
    const fix = fixture();
    const input = { commit: "a".repeat(40), result: "matches" as const };
    setCodeCheck(fix.ydoc, { ...input, repository: "owner/oldest" });
    vi.setSystemTime(new Date("2026-10-02T00:00:00Z"));
    setCodeCheck(fix.ydoc, { ...input, repository: "owner/recent" });
    vi.setSystemTime(new Date("2026-10-15T00:00:00Z"));
    const view = render(<Panel fix={fix} />);
    const host = view.container;
    const compared = (): Record<string, string> => Object.fromEntries(
      [...host.querySelectorAll<HTMLElement>(".ub-code-check")]
        .map((group) => [facts(group).Repository, facts(group).Compared!]),
    );
    try {
      expect(compared()["owner/oldest"]).not.toContain("due for a re-check");
      act(() => void vi.advanceTimersByTime(60_000));
      expect(compared()["owner/oldest"]).toMatch(/· due for a re-check$/);
      expect(compared()["owner/recent"]).not.toContain("due for a re-check");
      act(() => { setCodeCheck(fix.ydoc, { ...input, repository: "owner/oldest" }); });
      expect(compared()["owner/oldest"]).not.toContain("due for a re-check");
    } finally { view.unmount(); }
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
          within(host).getByRole("time").getAttribute("datetime"),
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

  it("mirrors the shown stamp immediately on panel open and document change", () => {
    vi.useFakeTimers();

    const first = fixture();
    const second = fixture();
    second.connection = {
      ...second.connection,
      room: `${WORKSPACE}/another-document`,
    };
    const stamp = Date.now() - 20 * 60_000;
    const secondStamp = stamp - 60_000;
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
    expect(within(host).queryByText(/Edited/)).not.toBeNull();
    expect(facts(host)["Last updated"]).toBe(
      within(within(host).getByText(/Edited/)).getByRole("time").getAttribute("title"),
    );
    draw(first.connection, false);
    draw(first.connection, true);
    // The panel's own sync word has a fresh settle window, but the age
    // already visible in the status line remains available immediately.
    expect(facts(host).State).toBe("—");
    expect(facts(host)["Last updated"]).toBe(
      within(within(host).getByText(/Edited/)).getByRole("time").getAttribute("title"),
    );
    // useRoom withholds the previous connection while the new address opens.
    view.rerender(<TimestampSurfaces connection={second.connection} stamp={secondStamp} open pane={{ connection: null }} />);
    expect(within(host).queryByText(/Edited/)).toBeNull();
    expect(facts(host)["Last updated"]).toBeUndefined();
    draw(second.connection, true, secondStamp);
    expect(within(host).queryByText(/Edited/)).not.toBeNull();
    expect(facts(host)["Last updated"]).toBe(
      within(within(host).getByText(/Edited/)).getByRole("time").getAttribute("title"),
    );
    expect(facts(host)["Last updated"]).not.toBe(new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium", timeStyle: "short",
    }).format(stamp));
    draw(second.connection, true, Number.NaN);
    expect(within(host).queryByText(/Edited/)).toBeNull();
    expect(facts(host)["Last updated"]).toBeUndefined();
  });

  it("omits both stamps while waiting and derives them when the document is shown", () => {
    vi.useFakeTimers();
    const fix = fixture();
    const stamp = Date.now() - 20 * 60_000;
    const tree = (waiting: boolean, value: number | undefined) => (
      <TimestampSurfaces connection={fix.connection} stamp={value} open
        pane={waiting ? { meta: { ...getMeta(fix.ydoc), uuid: "" } } : {}} />
    );
    const view = render(tree(true, stamp));
    const host = view.container;
    expect(within(host).getByText("Waiting for sync.")).not.toBeNull();
    expect(within(host).queryByText(/Edited/)).toBeNull();
    expect(facts(host)["Last updated"]).toBeUndefined();
    view.rerender(tree(false, stamp));
    expect(facts(host)["Last updated"]).toBe(
      within(within(host).getByText(/Edited/)).getByRole("time").getAttribute("title"),
    );
    for (const value of [undefined, Number.NaN, Infinity, Number.MAX_VALUE]) {
      view.rerender(tree(false, value));
      expect(within(host).queryByText(/Edited/)).toBeNull();
      expect(facts(host)["Last updated"]).toBeUndefined();
    }
  });

  it("withholds both stamps until the requested document and its decision context are shown", () => {
    vi.useFakeTimers();
    const fix = fixture();
    const meta = getMeta(fix.ydoc);
    const decisionMeta = { ...meta, kind: "decision" as const };
    const directory = new Y.Doc();
    upsertDirectoryEntry(directory, { uuid: DOC_UUID, title: meta.title, kind: "decision" });
    const topic = resolveDecisionTopics(directory)[0]!;
    const route = { kind: "decision" as const, workspace: { uuid: WORKSPACE, segment: WORKSPACE }, topic: DOC_UUID, record: DOC_UUID };
    const absent: Array<Partial<Parameters<typeof documentPaneState>[0]>> = [
      { connection: null },
      { meta: null },
      { meta: { ...meta, uuid: "another-document" } },
      { meta: decisionMeta, navigate: () => {} },
      { meta: decisionMeta, navigate: () => {}, topic: { ...topic, first: null } },
      { route, meta: decisionMeta, topic: null, selectedUuid: DOC_UUID },
      { route, meta: decisionMeta, topic, selectedUuid: null },
      { connection: fixture({ deleted: true }).connection },
    ];
    const tree = (pane: Partial<Parameters<typeof documentPaneState>[0]>) => (
      <TimestampSurfaces connection={fix.connection} stamp={Date.now()} open pane={pane} />
    );
    const view = render(tree(absent[0]!));
    for (const pane of absent) {
      view.rerender(tree(pane));
      expect(within(view.container).queryByText(/Edited/)).toBeNull();
      expect(facts(view.container)["Last updated"]).toBeUndefined();
    }
  });

  it("makes no room-status claim while the requested connection is absent", () => {
    vi.useFakeTimers();
    const view = render(
      <SyncPanel
        connection={null}
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
      // Which hub this "synced" is about, and who decided it.
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
   * an auth-failure state could add another — so a count assertion would fail when
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
   * A refused page must not read as merely busy in the `State` row.
   * Its word comes from the shared derivation, and the sentence it carries
   * gets a row of its own only under a refusal, preserving the ordinary fact map.
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

  /**
   * The fallback path: the served document did not decide this endpoint.
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
