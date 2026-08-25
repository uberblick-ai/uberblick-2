/**
 * The local read always finishes (#161).
 *
 * `localReplicaLoaded` is what tells an empty room apart from an unread one, so
 * every reader treats false as "still reading". That makes a read which can
 * never finish a real failure mode rather than a cosmetic one: IndexedDB can
 * refuse to open at all — a private window, a browser told to block site data —
 * and `y-indexeddb` has no error event and never emits `synced` afterwards. The
 * flag would stay false for the life of the room, and a deep link to a document
 * this replica does not hold would sit on a blank pane instead of saying what it
 * is waiting for.
 *
 * Both third parties are mocked, for the same reason: what is under test is how
 * `openRoom` reacts, and a real provider would spend the file dialling a hub
 * that is not running. The `y-indexeddb` stand-in models the one signal the
 * library gives for a database that will not open — its `_db` promise rejecting,
 * with `synced` never firing — and nothing else. (The library also leaks an
 * unhandled rejection of its own there, from a `_db.then` chain in its
 * constructor that it never catches; that is out of reach from outside it.)
 * `reconnect.test.ts` is where the transport is real.
 */

import { expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { ReactElement } from "react";
import type { RoomConnection } from "../src/collab/rooms.js";

/** `fail()` is the database refusing to open. */
const idb = vi.hoisted(() => ({ fail: (): void => {} }));

vi.mock("y-indexeddb", () => {
  class FakeIndexeddbPersistence {
    _db: Promise<IDBDatabase>;
    constructor() {
      this._db = new Promise<IDBDatabase>((_resolve, reject) => {
        idb.fail = () => reject(new Error("blocked"));
      });
    }
    /** The real one emits `synced` only on success, so this never fires. */
    once(): void {}
    /** Closes the database through the same promise — so it rejects too. */
    destroy(): Promise<void> {
      return this._db.then(() => undefined);
    }
  }
  return { IndexeddbPersistence: FakeIndexeddbPersistence };
});

vi.mock("@hocuspocus/provider", () => {
  class FakeSocket {
    status = "disconnected";
    on(): void {}
    connect(): void {}
    disconnect(): void {}
  }
  class FakeProvider {
    isSynced = false;
    unsyncedChanges = 0;
    awareness = null;
    attach(): void {}
    setAwarenessField(): void {}
    on(): void {}
    destroy(): void {}
  }
  return {
    WebSocketStatus: { Connected: "connected", Disconnected: "disconnected" },
    HocuspocusProviderWebsocket: FakeSocket,
    HocuspocusProvider: FakeProvider,
  };
});

vi.mock("../src/config.js", () => ({
  hubUrl: () => "ws://127.0.0.1:1",
  HUB_AUTH_TOKEN: "test-secret",
  WORKSPACE: "main",
}));

const { acquireRoom } = await import("../src/collab/rooms.js");
const { RoutePane } = await import("../src/ui/App.js");
const { useDocMeta } = await import("../src/ui/hooks.js");

const UUID = "3231bff4-2f1c-4a49-9f0a-6f8b2c1d7e55";
/** The workspace these rooms sit in. A workspace id is a uuid. */
const WORKSPACE = "6f4c8a51-2b7d-4e39-9a06-c81d3f572be4";
const workspace = { uuid: WORKSPACE, segment: WORKSPACE };

/** App's wiring for one document: observe its meta, gate the pane on it. */
function LinkedPane({ connection }: { connection: RoomConnection }): ReactElement {
  return (
    <RoutePane
      route={{ kind: "doc", workspace, uuid: UUID }}
      connection={connection}
      meta={useDocMeta(connection)}
      author="tester"
      archived={false}
      onRestore={() => {}}
      onSelectThread={() => {}}
    />
  );
}

it("settles the local read when IndexedDB refuses to open, and still says it is waiting", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
  // jsdom has no IndexedDB; the branch under test is the one that believes it
  // does. The persistence itself is the mock above.
  Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: {} });

  const { connection, release } = acquireRoom(`${WORKSPACE}/${UUID}`, {
    name: "tester",
    color: "#888888",
  });
  expect(connection.status.localReplicaLoaded).toBe(false);

  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(<LinkedPane connection={connection} />));

  // Nothing has answered yet, so the pane keeps the frame and says nothing.
  expect(host.querySelector(".ub-notice")).toBeNull();

  await act(async () => {
    idb.fail();
    await connection.whenLocalReplicaLoaded;
  });

  // Terminal: the read is over and found nothing, which is an answer — so the
  // link says what it is waiting for instead of staying blank forever.
  expect(connection.status.localReplicaLoaded).toBe(true);
  // …and the read being over is not a cache: nothing was stored, and the status
  // line must not tell the reader otherwise.
  expect(connection.status.hasLocalCache).toBe(false);
  expect(host.querySelector(".ub-notice")?.textContent).toContain("Waiting for sync");

  act(() => root.unmount());
  host.remove();
  // Releasing closes a database that never opened. Nothing to repair, and
  // nothing to leave as an unhandled rejection either.
  release();
  Reflect.deleteProperty(globalThis, "indexedDB");
});
