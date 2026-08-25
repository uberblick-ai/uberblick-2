/**
 * No room is acquired before the hub endpoint is known (#91).
 *
 * The one invariant the runtime-configuration change turns on. The shared
 * websocket is built from the first room acquired and lives for the session, so
 * a room taken out a tick early would dial the build-time fallback and stay
 * there — with the served document fetched, parsed, and ignored. That failure
 * is invisible: the app works, against the wrong hub.
 *
 * The render is deliberately *not* gated, which is the other half: the shell is
 * on screen while the endpoint is still being read.
 */

import { afterEach, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import * as Y from "yjs";
import { directoryRoom } from "@uberblick/schema";

const acquireRoom = vi.hoisted(() => vi.fn());
vi.mock("../src/collab/rooms.js", () => ({ acquireRoom }));

const { App } = await import("../src/ui/App.js");
const { WORKSPACE } = await import("../src/config.js");

/** Enough of a connection for the panes that render against the directory. */
function fakeHandle(room: string): unknown {
  const ydoc = new Y.Doc();
  return {
    connection: {
      room,
      ydoc,
      provider: {
        awareness: { getStates: () => new Map(), on: () => {}, off: () => {}, clientID: 1 },
      },
      status: { connected: false, synced: false, unsyncedChanges: 0, localReplicaLoaded: false, hasLocalCache: false },
      onStatusChange: () => () => {},
      whenLocalReplicaLoaded: Promise.resolve(),
    },
    release: () => {},
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  acquireRoom.mockReset();
});

it("holds the first connect until the endpoint resolves, without holding the render", async () => {
  let answer: (response: Response) => void = () => {};
  vi.spyOn(globalThis, "fetch").mockImplementation(
    () => new Promise<Response>((resolve) => { answer = resolve; }),
  );
  acquireRoom.mockImplementation((room: string) => fakeHandle(room));

  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<App />);
  });

  // The shell is up — the read gates the connect, not the render.
  expect(container.querySelector(".ub-brand")?.textContent).toBe("uberblick");
  expect(acquireRoom).not.toHaveBeenCalled();

  await act(async () => {
    answer(new Response('{"hubUrl":"wss://hub.example/ws"}', { status: 200 }));
  });

  expect(acquireRoom).toHaveBeenCalledWith(
    directoryRoom(WORKSPACE),
    expect.anything(),
  );

  await act(async () => {
    root.unmount();
  });
  container.remove();
});
