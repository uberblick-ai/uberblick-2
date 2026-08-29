/**
 * How long a departed agent's caret stays on screen (#407).
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
import {
  AGENT_CURSOR_GRACE_MS,
  withDepartedAgentCursors,
} from "../src/editor/collaboration.js";

const AGENT_NAME = "Uberblick Coordinator Agent";

let viewer: Awareness;
let agent: Awareness;

/** The agent publishes a cursor, and the viewer's room receives it. */
function publishAgentCursor(head: number): void {
  agent.setLocalState({
    user: { name: AGENT_NAME, color: "#a33" },
    cursor: { anchor: head, head },
    client: "mcp",
  });
  applyAwarenessUpdate(
    viewer,
    encodeAwarenessUpdate(agent, [agent.clientID]),
    "test",
  );
}

/** The session exits: the room drops its state, as the hub's does. */
function agentLeaves(): void {
  removeAwarenessStates(viewer, [agent.clientID], "test");
}

function caretIn(awareness: Awareness): unknown {
  return awareness.getStates().get(agent.clientID)?.cursor;
}

beforeEach(() => {
  vi.useFakeTimers();
  viewer = new Awareness(new Y.Doc());
  agent = new Awareness(new Y.Doc());
});

afterEach(() => {
  viewer.destroy();
  agent.destroy();
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

  // Presence is gone the instant the session is: only the view keeps the caret.
  expect(viewer.getStates().has(agent.clientID)).toBe(false);
  expect(view.getStates().get(agent.clientID)?.user).toEqual({
    name: AGENT_NAME,
    color: "#a33",
  });

  // Still there at 29 s — the five seconds this used to be would have expired
  // twenty-four seconds ago.
  vi.advanceTimersByTime(29_000);
  expect(caretIn(view)).toEqual({ anchor: 3, head: 3 });

  // And gone just after 30, on its own, with a change nobody had to ask for.
  vi.advanceTimersByTime(1_001);
  expect(view.getStates().has(agent.clientID)).toBe(false);
  expect(changes.at(-1)?.removed).toEqual([agent.clientID]);
});

it("lets a returning session replace its own retained caret at once", () => {
  const view = withDepartedAgentCursors(viewer, AGENT_CURSOR_GRACE_MS);
  view.on("change", () => {});

  publishAgentCursor(3);
  agentLeaves();
  vi.advanceTimersByTime(1_000);

  // The agent is back and writing somewhere else. The live state is what the
  // caret is drawn from — the same object the room holds, not a copy of where
  // it used to be.
  publishAgentCursor(9);
  expect(view.getStates().get(agent.clientID)).toBe(
    viewer.getStates().get(agent.clientID),
  );
  expect(caretIn(view)).toEqual({ anchor: 9, head: 9 });

  // ...and the departure's own timer, had it survived, would fire about here.
  vi.advanceTimersByTime(29_500);
  expect(caretIn(view)).toEqual({ anchor: 9, head: 9 });
});
