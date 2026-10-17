// @vitest-environment node
/**
 * How long a departed agent's caret stays on screen.
 *
 * The lifetime lives in one constant and one view, so it is driven here on fake
 * timers rather than through an editor and a hub: a real 30-second wait would
 * cost half a minute per case and prove the clock, not the contract. The peer
 * is a real `Awareness` fed a real encoded update and then really removed, so
 * the departure is the one the room broadcasts, not a hand-written event.
 *
 * `withDepartedAgentCursors` is called with `AGENT_CURSOR_GRACE_MS` — the value
 * the extension wires in production — so a change to the constant changes what
 * these cases assert, which is what makes the number itself pinned here.
 */

import {
  applyAwarenessUpdate,
  Awareness,
  encodeAwarenessUpdate,
  removeAwarenessStates,
} from "y-protocols/awareness";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { AGENT_CLIENT } from "../src/collab/identity.js";
import {
  AGENT_CURSOR_GRACE_MS,
  agentCursorAwareness,
  withDepartedAgentCursors,
} from "../src/editor/collaboration.js";
import { readPresence } from "../src/ui/status/doc-chrome.js";

const AGENT_NAME = "Uberblick Coordinator Agent";

let viewer: Awareness;
let agent: Awareness;
let additionalPeers: Awareness[];

/**
 * A session publishes a cursor, and the viewer's room receives it.
 *
 * `client` is the whole question the grace asks, so it is a parameter: the
 * agent marker is what production publishes, and `undefined` is the session
 * that claims to be nothing — including a tab whose bundle lacks the marker.
 */
function publishCursor(
  head: number,
  client: string | undefined,
  session?: string,
): void {
  agent.setLocalState({
    user: { name: AGENT_NAME, color: "#a33" },
    cursor: { anchor: head, head },
    ...(client === undefined ? {} : { client }),
    ...(session === undefined ? {} : { session }),
  });
  applyAwarenessUpdate(
    viewer,
    encodeAwarenessUpdate(agent, [agent.clientID]),
    "test",
  );
}

/** The production case: an MCP session, publishing the agent marker. */
function publishAgentCursor(head: number, session?: string): void {
  publishCursor(head, AGENT_CLIENT, session);
}

function publishSessionPeer(peer: Awareness, session: string, head?: number): void {
  peer.setLocalState({
    user: { name: AGENT_NAME, color: "#a33" },
    client: AGENT_CLIENT,
    session,
    ...(head === undefined ? {} : { cursor: { anchor: head, head } }),
  });
  applyAwarenessUpdate(viewer, encodeAwarenessUpdate(peer, [peer.clientID]), "test");
}

function newPeer(): Awareness {
  const peer = new Awareness(new Y.Doc());
  additionalPeers.push(peer);
  return peer;
}

/** The session exits: the room drops its state, as the hub's does. */
function agentLeaves(): void {
  removeAwarenessStates(viewer, [agent.clientID], "test");
}

const DEPARTURE_SOURCES = ["connection close", "client awareness removal"] as const;

function depart(peer: Awareness, source: (typeof DEPARTURE_SOURCES)[number]): void {
  if (source === "connection close") {
    removeAwarenessStates(viewer, [peer.clientID], "test");
  } else {
    peer.setLocalState(null);
    applyAwarenessUpdate(viewer, encodeAwarenessUpdate(peer, [peer.clientID]), "test");
  }
}

function caretIn(awareness: Awareness): unknown {
  return awareness.getStates().get(agent.clientID)?.cursor;
}

beforeEach(() => {
  vi.useFakeTimers();
  viewer = new Awareness(new Y.Doc());
  agent = new Awareness(new Y.Doc());
  additionalPeers = [];
});

afterEach(() => {
  viewer.destroy();
  agent.destroy();
  for (const peer of additionalPeers) {
    peer.destroy();
    peer.doc.destroy();
  }
  vi.useRealTimers();
});

it("holds a departed agent's caret for the grace the editor wires, then drops it", () => {
  const view = withDepartedAgentCursors(viewer, AGENT_CURSOR_GRACE_MS);
  const changes: { removed: number[] }[] = [];
  view.on("change", (change: { removed: number[] }) => {
    changes.push(change);
  });

  publishAgentCursor(3);
  agentLeaves();

  // Real presence is gone immediately; only the presentation view retains it.
  expect(viewer.getStates().has(agent.clientID)).toBe(false);
  expect(view.getStates().get(agent.clientID)?.user).toEqual({
    name: AGENT_NAME,
    color: "#a33",
  });

  // Still there at 29 s: the retention must cover nearly the whole grace period.
  vi.advanceTimersByTime(29_000);
  expect(caretIn(view)).toEqual({ anchor: 3, head: 3 });

  // And gone just after 30, on its own, with a change nobody had to ask for.
  vi.advanceTimersByTime(1_001);
  expect(view.getStates().has(agent.clientID)).toBe(false);
  expect(changes.at(-1)?.removed).toEqual([agent.clientID]);
});

it("drops a departed session that never claimed to be an agent", () => {
  const view = withDepartedAgentCursors(viewer, AGENT_CURSOR_GRACE_MS);
  view.on("change", () => {});

  // Everything the grace looks at except the marker: a name and a live cursor.
  publishCursor(3, undefined);
  expect(caretIn(view)).toEqual({ anchor: 3, head: 3 });

  agentLeaves();

  // The person closed the tab, so the caret goes with them — not in 30 seconds.
  expect(view.getStates().has(agent.clientID)).toBe(false);
});

it("lets a returning session replace its own retained caret at once", () => {
  const view = agentCursorAwareness(viewer);
  view.on("change", () => {});

  publishAgentCursor(3);
  agentLeaves();
  expect(readPresence(viewer.doc, view, view.isDeparted)).toMatchObject([
    { clientId: agent.clientID, name: AGENT_NAME, departed: true },
  ]);
  vi.advanceTimersByTime(1_000);

  // The agent is back and writing somewhere else. The live state is what the
  // caret is drawn from — the same object the room holds, not the retained copy.
  publishAgentCursor(9);
  expect(view.getStates().get(agent.clientID)).toBe(
    viewer.getStates().get(agent.clientID),
  );
  expect(caretIn(view)).toEqual({ anchor: 9, head: 9 });
  const returned = readPresence(viewer.doc, view, view.isDeparted);
  expect(returned).toHaveLength(1);
  expect(returned[0]?.departed).toBeUndefined();

  // ...and the departure's own timer, had it survived, would fire about here.
  vi.advanceTimersByTime(29_500);
  expect(caretIn(view)).toEqual({ anchor: 9, head: 9 });
  expect(view.isDeparted(agent.clientID)).toBe(false);
});

it.each(DEPARTURE_SOURCES)("shares one %s and expiry between the title roster and editor cursors", (source) => {
  const cursorView = agentCursorAwareness(viewer);
  const titleView = agentCursorAwareness(viewer);
  expect(titleView).toBe(cursorView);
  // The projection must still identify and omit the reader's own session.
  viewer.setLocalState({ user: { name: "Self", color: "#a33" } });
  const title = () => readPresence(viewer.doc, titleView, titleView.isDeparted);
  cursorView.on("change", () => {});
  titleView.on("change", () => {});

  publishAgentCursor(3);
  expect(title()).toHaveLength(1);
  depart(agent, source);
  expect(title()).toMatchObject([
    { clientId: agent.clientID, name: AGENT_NAME, departed: true },
  ]);
  expect(readPresence(viewer.doc, viewer)).toEqual([]);
  vi.advanceTimersByTime(AGENT_CURSOR_GRACE_MS - 1);
  expect(title()).toHaveLength(1);
  expect(caretIn(cursorView)).toEqual({ anchor: 3, head: 3 });
  vi.advanceTimersByTime(1);
  expect(title()).toEqual([]);
  expect(caretIn(cursorView)).toBeUndefined();
});

it("does not restart departure grace when the editor rebinds under the title reader", () => {
  const view = agentCursorAwareness(viewer);
  const oldEditor = () => {};
  const title = () => {};
  const newEditor = () => {};
  view.on("change", oldEditor);
  view.on("change", title);
  publishAgentCursor(3);
  agentLeaves();

  vi.advanceTimersByTime(10_000);
  view.off("change", oldEditor);
  agentCursorAwareness(viewer).on("change", newEditor);
  vi.advanceTimersByTime(AGENT_CURSOR_GRACE_MS - 10_001);
  expect(caretIn(view)).toEqual({ anchor: 3, head: 3 });
  vi.advanceTimersByTime(1);
  expect(view.getStates().has(agent.clientID)).toBe(false);
});

it("clears both retained displays when the final document reader leaves", () => {
  const view = agentCursorAwareness(viewer);
  const editor = () => {};
  const title = () => {};
  view.on("change", editor);
  view.on("change", title);
  publishAgentCursor(3);
  agentLeaves();

  view.off("change", editor);
  expect(view.isDeparted(agent.clientID)).toBe(true);
  view.off("change", title);
  expect(view.getStates().has(agent.clientID)).toBe(false);
  expect(view.isDeparted(agent.clientID)).toBe(false);
  const reopened = agentCursorAwareness(viewer);
  reopened.on("change", title);
  expect(readPresence(viewer.doc, reopened, reopened.isDeparted)).toEqual([]);
  publishAgentCursor(9);
  expect(readPresence(viewer.doc, reopened, reopened.isDeparted)).toMatchObject([
    { clientId: agent.clientID, name: AGENT_NAME },
  ]);
  vi.advanceTimersByTime(AGENT_CURSOR_GRACE_MS - 1);
  expect(caretIn(reopened)).toEqual({ anchor: 9, head: 9 });
});

it.each([
  ["a human", { user: { name: AGENT_NAME }, client: "web", cursor: { anchor: 3 } }],
  ["an agent without a cursor", { user: { name: AGENT_NAME }, client: AGENT_CLIENT }],
  ["an agent without a name", { user: {}, client: AGENT_CLIENT, cursor: { anchor: 3 } }],
  ["an agent with a blank name", { user: { name: "  " }, client: AGENT_CLIENT, cursor: { anchor: 3 } }],
])("does not retain the avatar or cursor of %s", (_reason, state) => {
  const view = agentCursorAwareness(viewer);
  view.on("change", () => {});
  agent.setLocalState(state);
  applyAwarenessUpdate(viewer, encodeAwarenessUpdate(agent, [agent.clientID]), "test");
  agentLeaves();
  expect(view.getStates().has(agent.clientID)).toBe(false);
  expect(readPresence(viewer.doc, view, view.isDeparted)).toEqual([]);
});

it("does not restore a cursor withdrawn before the agent departs", () => {
  const view = agentCursorAwareness(viewer);
  view.on("change", () => {});
  publishAgentCursor(3);
  agent.setLocalStateField("cursor", null);
  applyAwarenessUpdate(viewer, encodeAwarenessUpdate(agent, [agent.clientID]), "test");
  agentLeaves();
  expect(view.getStates().has(agent.clientID)).toBe(false);
  expect(readPresence(viewer.doc, view, view.isDeparted)).toEqual([]);
});

it.each([
  [undefined, undefined],
  ["", ""],
  ["first-session", "second-session"],
])("keeps same-named agents with separate session identities %s and %s on their own departure lifetimes", (firstSession, secondSession) => {
  const second = new Awareness(new Y.Doc());
  try {
    const view = agentCursorAwareness(viewer);
    view.on("change", () => {});
    publishAgentCursor(3, firstSession);
    second.setLocalState({
      user: { name: AGENT_NAME, color: "#33a" },
      client: AGENT_CLIENT,
      ...(secondSession === undefined ? {} : { session: secondSession }),
      cursor: { anchor: 9, head: 9 },
    });
    applyAwarenessUpdate(viewer, encodeAwarenessUpdate(second, [second.clientID]), "test");
    agentLeaves();
    vi.advanceTimersByTime(5_000);
    removeAwarenessStates(viewer, [second.clientID], "test");
    expect(readPresence(viewer.doc, view, view.isDeparted)).toHaveLength(2);
    vi.advanceTimersByTime(AGENT_CURSOR_GRACE_MS - 5_000);
    expect(view.getStates().has(agent.clientID)).toBe(false);
    expect(view.getStates().get(second.clientID)?.cursor).toEqual({ anchor: 9, head: 9 });
    expect(readPresence(viewer.doc, view, view.isDeparted)).toMatchObject([
      { clientId: second.clientID, name: AGENT_NAME, color: "#33a", departed: true },
    ]);
    vi.advanceTimersByTime(5_000);
    expect(readPresence(viewer.doc, view, view.isDeparted)).toEqual([]);
  } finally {
    second.destroy();
    second.doc.destroy();
  }
});

it("replaces a session's departed caret with its reconnected live caret and restarts grace on departure", () => {
  const view = agentCursorAwareness(viewer);
  const changes: { removed: number[] }[] = [];
  view.on("change", (change: { removed: number[] }) => changes.push(change));
  publishAgentCursor(3, "run-1");
  agentLeaves();
  vi.advanceTimersByTime(5_000);

  const reconnected = newPeer();
  publishSessionPeer(reconnected, "run-1", 9);
  expect(view.getStates().has(agent.clientID)).toBe(false);
  expect(view.getStates().get(reconnected.clientID)?.cursor).toEqual({ anchor: 9, head: 9 });
  expect(view.isDeparted(reconnected.clientID)).toBe(false);
  expect(changes.at(-1)?.removed).toContain(agent.clientID);

  removeAwarenessStates(viewer, [reconnected.clientID], "test");
  expect(view.isDeparted(reconnected.clientID)).toBe(true);
  vi.advanceTimersByTime(AGENT_CURSOR_GRACE_MS - 5_000);
  expect(view.getStates().get(reconnected.clientID)?.cursor).toEqual({ anchor: 9, head: 9 });
  vi.advanceTimersByTime(5_000);
  expect(view.getStates().has(reconnected.clientID)).toBe(false);
  expect(changes.at(-1)?.removed).toEqual([reconnected.clientID]);
});

it.each(DEPARTURE_SOURCES)("keeps the previous caret through a cursorless reconnect and runs grace from its last %s", (source) => {
  const view = agentCursorAwareness(viewer);
  const changes: { removed: number[] }[] = [];
  const listener = (change: { removed: number[] }) => changes.push(change);
  view.on("change", listener);
  const title = () => readPresence(viewer.doc, view, view.isDeparted);
  publishAgentCursor(3, "run-1");
  depart(agent, source);
  vi.advanceTimersByTime(10_000);

  const reconnected = newPeer();
  publishSessionPeer(reconnected, "run-1");
  expect(caretIn(view)).toEqual({ anchor: 3, head: 3 });
  expect(view.isDeparted(agent.clientID)).toBe(true);
  expect(view.isDeparted(reconnected.clientID)).toBe(false);
  vi.advanceTimersByTime(10_000);
  depart(reconnected, source);
  const departureChanges = changes.length;

  vi.advanceTimersByTime(AGENT_CURSOR_GRACE_MS - 1);
  expect(caretIn(view)).toEqual({ anchor: 3, head: 3 });
  expect(title()).toMatchObject([
    { clientId: agent.clientID, name: AGENT_NAME, session: "run-1", departed: true },
  ]);
  expect(changes).toHaveLength(departureChanges);
  vi.advanceTimersByTime(1);
  expect(view.getStates().has(agent.clientID)).toBe(false);
  expect(title()).toEqual([]);
  expect(changes.at(-1)?.removed).toEqual([agent.clientID]);
  view.off("change", listener);
});

it("keeps concurrent live carets independent and only retains a session's latest departure", () => {
  const view = agentCursorAwareness(viewer);
  const changes: { removed: number[] }[] = [];
  view.on("change", (change: { removed: number[] }) => changes.push(change));
  publishAgentCursor(3, "run-1");
  const concurrent = newPeer();
  publishSessionPeer(concurrent, "run-1", 9);
  expect(caretIn(view)).toEqual({ anchor: 3, head: 3 });
  expect(view.getStates().get(concurrent.clientID)?.cursor).toEqual({ anchor: 9, head: 9 });

  publishAgentCursor(5, "run-1");
  agentLeaves();
  expect(view.isDeparted(agent.clientID)).toBe(true);
  // An unrelated awareness change re-reads the older concurrent live caret.
  viewer.setLocalState({ user: { name: "Self" }, client: "web" });
  expect(caretIn(view)).toEqual({ anchor: 5, head: 5 });
  concurrent.setLocalStateField("user", { name: "Renamed Agent", color: "#a33" });
  applyAwarenessUpdate(viewer, encodeAwarenessUpdate(concurrent, [concurrent.clientID]), "test");
  expect(caretIn(view)).toEqual({ anchor: 5, head: 5 });
  vi.advanceTimersByTime(5_000);
  removeAwarenessStates(viewer, [concurrent.clientID], "test");
  expect(view.getStates().has(agent.clientID)).toBe(false);
  expect(view.getStates().get(concurrent.clientID)?.cursor).toEqual({ anchor: 9, head: 9 });
  expect(view.isDeparted(concurrent.clientID)).toBe(true);
  expect(changes.at(-1)?.removed).toEqual(expect.arrayContaining([agent.clientID, concurrent.clientID]));

  vi.advanceTimersByTime(AGENT_CURSOR_GRACE_MS - 5_000);
  expect(view.getStates().has(concurrent.clientID)).toBe(true);
  vi.advanceTimersByTime(5_000);
  expect(view.getStates().has(concurrent.clientID)).toBe(false);
});

it("lets a concurrent live caret update supersede the session's retained departure", () => {
  const view = agentCursorAwareness(viewer);
  const changes: { removed: number[] }[] = [];
  view.on("change", (change: { removed: number[] }) => changes.push(change));
  publishAgentCursor(3, "run-1");
  const concurrent = newPeer();
  publishSessionPeer(concurrent, "run-1", 9);
  publishAgentCursor(5, "run-1");
  agentLeaves();
  publishSessionPeer(concurrent, "run-1", 15);
  expect(view.getStates().has(agent.clientID)).toBe(false);
  expect(view.getStates().get(concurrent.clientID)?.cursor).toEqual({ anchor: 15, head: 15 });
  expect(changes.at(-1)?.removed).toContain(agent.clientID);
});

it("does not restore an older departed caret while a newer same-session caret is live", () => {
  const view = agentCursorAwareness(viewer);
  view.on("change", () => {});
  publishAgentCursor(3, "run-1");
  const concurrent = newPeer();
  publishSessionPeer(concurrent, "run-1", 9);
  expect(caretIn(view)).toEqual({ anchor: 3, head: 3 });
  expect(view.getStates().get(concurrent.clientID)?.cursor).toEqual({ anchor: 9, head: 9 });

  agentLeaves();
  expect(view.getStates().has(agent.clientID)).toBe(false);
  expect(view.isDeparted(agent.clientID)).toBe(false);
  expect(view.getStates().get(concurrent.clientID)?.cursor).toEqual({ anchor: 9, head: 9 });
  removeAwarenessStates(viewer, [concurrent.clientID], "test");
  expect(view.isDeparted(concurrent.clientID)).toBe(true);
  expect(view.getStates().has(agent.clientID)).toBe(false);
});

it("does not restore a withdrawn newer caret on a same-session connection's departure", () => {
  const view = agentCursorAwareness(viewer);
  view.on("change", () => {});
  publishAgentCursor(3, "run-1");
  const concurrent = newPeer();
  publishSessionPeer(concurrent, "run-1", 9);
  concurrent.setLocalStateField("cursor", null);
  applyAwarenessUpdate(viewer, encodeAwarenessUpdate(concurrent, [concurrent.clientID]), "test");
  agentLeaves();
  expect(caretIn(view)).toEqual({ anchor: 3, head: 3 });
  removeAwarenessStates(viewer, [concurrent.clientID], "test");
  expect(caretIn(view)).toEqual({ anchor: 3, head: 3 });
  expect(view.getStates().has(concurrent.clientID)).toBe(false);
});

it("cancels replacement departure timers when the final reader leaves", () => {
  const view = agentCursorAwareness(viewer);
  const listener = vi.fn();
  view.on("change", listener);
  publishAgentCursor(3, "run-1");
  agentLeaves();
  vi.advanceTimersByTime(5_000);
  const reconnected = newPeer();
  publishSessionPeer(reconnected, "run-1", 9);
  removeAwarenessStates(viewer, [reconnected.clientID], "test");
  view.off("change", listener);
  listener.mockClear();

  vi.advanceTimersByTime(AGENT_CURSOR_GRACE_MS);
  expect(listener).not.toHaveBeenCalled();
  expect(view.isDeparted(agent.clientID)).toBe(false);
  expect(view.isDeparted(reconnected.clientID)).toBe(false);
  expect(view.getStates().has(reconnected.clientID)).toBe(false);
});
