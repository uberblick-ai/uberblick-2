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
import { act, renderSettled } from "./react-render.js";
import * as Y from "yjs";
import { directoryRoom } from "@uberblick/schema";

const acquireRoom = vi.hoisted(() => vi.fn());
vi.mock("../src/collab/rooms.js", () => ({ acquireRoom }));

const { App, ReboundNotice } = await import("../src/ui/App.js");

/**
 * The address names the workspace, so the test opens one. `/` would render the
 * no-workspace state and acquire nothing, which is a different claim.
 */
const WORKSPACE = "6f4c8a51-2b7d-4e39-9a06-c81d3f572be4";

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
      status: {
        connected: false,
        synced: false,
        unsyncedChanges: 0,
        hasAnswered: true,
        protocolMismatch: null,
        authFailed: false,
        tokenMissing: false,
      },
      onStatusChange: () => () => {},
    },
    release: () => {},
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  acquireRoom.mockReset();
});

it("shows the restart state only for a rebound local-serving document", async () => {
  const serving = {
    workspace: WORKSPACE,
    remoteHubUrl: "wss://remote.example/ws",
    rebound: false,
  };

  const view = await renderSettled(<ReboundNotice serving={serving} />);
  const container = view.container;
  expect(container.querySelector(".ub-rebound-notice")).toBeNull();

  await act(async () => {
    view.rerender(<ReboundNotice serving={null} />);
  });
  expect(container.querySelector(".ub-rebound-notice")).toBeNull();

  await act(async () => {
    view.rerender(<ReboundNotice serving={{ ...serving, rebound: true }} />);
  });
  const notice = container.querySelector(".ub-rebound-notice");
  expect(notice?.textContent).toContain(WORKSPACE);
  expect(notice?.textContent).toContain("wss://remote.example/ws");
  expect(notice?.querySelector("button")).toBeNull();

});

it("holds the first connect until the endpoint resolves, without holding the render", async () => {
  let answer: (response: Response) => void = () => {};
  vi.spyOn(globalThis, "fetch").mockImplementation(
    () => new Promise<Response>((resolve) => { answer = resolve; }),
  );
  acquireRoom.mockImplementation((room: string) => fakeHandle(room));

  window.history.replaceState(null, "", `/${WORKSPACE}`);
  const { container } = await renderSettled(<App />);

  // The shell is up — the read gates the connect, not the render.
  expect(container.querySelector(".ub-app")).not.toBeNull();
  expect(acquireRoom).not.toHaveBeenCalled();

  await act(async () => {
    answer(
      new Response(
        JSON.stringify({ hubUrl: "ws://127.0.0.1:4321" }),
        { status: 200 },
      ),
    );
  });

  expect(acquireRoom).toHaveBeenCalledWith(
    directoryRoom(WORKSPACE),
    expect.anything(),
  );

});

it("keeps the rebound notice visible across routes without replacing the page", async () => {
  let answer: (response: Response) => void = () => {};
  vi.spyOn(globalThis, "fetch").mockImplementation(
    () => new Promise<Response>((resolve) => { answer = resolve; }),
  );
  acquireRoom.mockImplementation((room: string) => fakeHandle(room));

  window.history.replaceState(null, "", `/${WORKSPACE}`);
  const { container } = await renderSettled(<App />);

  await act(async () => {
    answer(
      new Response(
        JSON.stringify({
          hubUrl: "ws://127.0.0.1:4321",
          workspaces: [WORKSPACE],
          remoteHubUrl: "wss://remote.example/ws",
          rebound: true,
        }),
        { status: 200 },
      ),
    );
  });

  const notice = container.querySelector(".ub-rebound-notice");
  expect(notice?.getAttribute("role")).toBe("status");
  expect(notice?.textContent).toContain(`workspace ${WORKSPACE}`);
  expect(container.querySelector(".ub-docs-heading")?.textContent).toBe("Documents");

  await act(async () => {
    window.history.pushState(null, "", `/${WORKSPACE}/not-a-document`);
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  expect(container.querySelector(".ub-notice")?.textContent).toContain(
    "Not a document link",
  );
  expect(container.querySelector(".ub-rebound-notice")?.textContent).toContain(
    "Restart ub open",
  );

});
