/**
 * A local-copy claim needs provenance, not merely an open IndexedDB database.
 * These fakes keep an empty room empty so the checkpoint is the only fact that
 * can distinguish a fresh database from a legitimately empty synced replica.
 */

import { afterEach, expect, it, vi } from "vitest";

const fakes = vi.hoisted(() => ({
  checkpoints: new Map<string, string>(),
  failStateWrite: false,
  failedStateWrites: 0,
  persistences: new Map<string, { syncLocal: () => void }>(),
  providers: new Map<string, { syncHub: () => void }>(),
}));

vi.mock("y-indexeddb", () => {
  class FakeIndexeddbPersistence {
    readonly name: string;
    readonly db: IDBDatabase;
    readonly _db: Promise<IDBDatabase>;
    private synced: (() => void) | null = null;

    constructor(name: string) {
      this.name = name;
      const database = {
        transaction: () => {
          let checkpoint: { key: string; value: string } | null = null;
          let hasState = false;
          let settlementQueued = false;
          const transaction = {
            error: null as DOMException | null,
            onabort: null as (() => void) | null,
            oncomplete: null as (() => void) | null,
            onerror: null as (() => void) | null,
            objectStore: (store: string) => ({
              add: () => {
                if (store === "updates") hasState = true;
                settle();
              },
              put: (value: string, key: string) => {
                if (store === "custom") checkpoint = { key, value };
                settle();
              },
            }),
          };

          const settle = (): void => {
            if (settlementQueued) return;
            settlementQueued = true;
            queueMicrotask(() => {
              if (fakes.failStateWrite && hasState) {
                fakes.failedStateWrites += 1;
                transaction.error = new DOMException(
                  "The room state was not stored",
                  "QuotaExceededError",
                );
                transaction.onabort?.();
                return;
              }
              if (checkpoint !== null) {
                fakes.checkpoints.set(`${name}:${checkpoint.key}`, checkpoint.value);
              }
              transaction.oncomplete?.();
            });
          };

          return transaction;
        },
      } as unknown as IDBDatabase;
      this.db = database;
      this._db = Promise.resolve(database);
      fakes.persistences.set(name, {
        syncLocal: () => this.synced?.(),
      });
    }

    once(event: string, callback: () => void): void {
      if (event === "synced") this.synced = callback;
    }

    get(key: string): Promise<string | undefined> {
      return Promise.resolve(fakes.checkpoints.get(`${this.name}:${key}`));
    }

    destroy(): Promise<void> {
      return Promise.resolve();
    }
  }

  return {
    IndexeddbPersistence: FakeIndexeddbPersistence,
  };
});

vi.mock("@hocuspocus/provider", () => {
  class FakeSocket {
    status = "disconnected";
    on(): void {}
    connect(): void {}
    disconnect(): void {}
  }

  class FakeProvider {
    readonly name: string;
    isSynced = false;
    unsyncedChanges = 0;
    awareness = null;
    private listeners = new Map<string, Array<() => void>>();

    constructor({ name }: { name: string }) {
      this.name = name;
      fakes.providers.set(name, {
        syncHub: () => {
          this.isSynced = true;
          for (const listener of this.listeners.get("synced") ?? []) listener();
        },
      });
    }

    attach(): void {}
    destroy(): void {}
    setAwarenessField(): void {}

    on(event: string, callback: () => void): void {
      const listeners = this.listeners.get(event) ?? [];
      listeners.push(callback);
      this.listeners.set(event, listeners);
    }
  }

  return {
    WebSocketStatus: { Connected: "connected", Disconnected: "disconnected" },
    HocuspocusProviderWebsocket: FakeSocket,
    HocuspocusProvider: FakeProvider,
  };
});

vi.mock("../src/config.js", () => ({
  HUB_CONFIG_PATH: "/uberblick-config.json",
  hubUrl: () => "ws://127.0.0.1:1",
  hubAuthToken: () => "test-secret",
  resolveClientConfig: async () => ({}),
}));

const { acquireRoom } = await import("../src/collab/rooms.js");

const ROOM = "6f4c8a51-2b7d-4e39-9a06-c81d3f572be4/_directory";

afterEach(() => {
  fakes.checkpoints.clear();
  fakes.failStateWrite = false;
  fakes.failedStateWrites = 0;
  fakes.persistences.clear();
  fakes.providers.clear();
  Reflect.deleteProperty(globalThis, "indexedDB");
});

it("claims an empty local copy only after a hub-confirmed checkpoint survives reload", async () => {
  Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: {} });

  const first = acquireRoom(ROOM, { name: "tester", color: "#888888" });
  try {
    expect(first.connection.status.localReplicaLoaded).toBe(false);
    expect(first.connection.status.hasLocalCache).toBe(false);

    fakes.persistences.get(ROOM)?.syncLocal();
    await first.connection.whenLocalReplicaLoaded;

    // A fresh empty database is an answered local read, not a fetched copy.
    expect(first.connection.status.localReplicaLoaded).toBe(true);
    expect(first.connection.status.hasLocalCache).toBe(false);

    fakes.providers.get(ROOM)?.syncHub();
    await vi.waitFor(() => expect(first.connection.status.hasLocalCache).toBe(true));
  } finally {
    first.release();
  }

  // No hub event in this second session: the durable checkpoint alone makes
  // the legitimately empty room available offline after its local read.
  const reopened = acquireRoom(ROOM, { name: "tester", color: "#888888" });
  try {
    fakes.persistences.get(ROOM)?.syncLocal();
    await reopened.connection.whenLocalReplicaLoaded;
    expect(reopened.connection.status.hasLocalCache).toBe(true);
  } finally {
    reopened.release();
  }
});

it("leaves no readable checkpoint when the room state write aborts", async () => {
  Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: {} });
  fakes.failStateWrite = true;

  const failed = acquireRoom(ROOM, { name: "tester", color: "#888888" });
  try {
    fakes.persistences.get(ROOM)?.syncLocal();
    await failed.connection.whenLocalReplicaLoaded;
    fakes.providers.get(ROOM)?.syncHub();
    await vi.waitFor(() => expect(fakes.failedStateWrites).toBe(1));
    expect(failed.connection.status.hasLocalCache).toBe(false);
  } finally {
    failed.release();
  }

  fakes.failStateWrite = false;
  const reopened = acquireRoom(ROOM, { name: "tester", color: "#888888" });
  try {
    fakes.persistences.get(ROOM)?.syncLocal();
    await reopened.connection.whenLocalReplicaLoaded;
    expect(reopened.connection.status.hasLocalCache).toBe(false);
  } finally {
    reopened.release();
  }
});
