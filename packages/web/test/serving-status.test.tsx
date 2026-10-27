/** The `/api/status` room reading is current, calm and never guessed. */

import { act, render, type RenderResult } from "./react-render.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import type {
  DocumentSearchClient,
  DocumentSearchStatus,
} from "../src/shell/document-search.js";
import type { RoomConnection, RoomStatus } from "../src/collab/rooms.js";
import { StatusLine } from "../src/ui/document/EditorPane.js";
import {
  SERVING_STATUS_POLL_MS,
  SERVING_STATUS_SETTLE_MS,
  SERVING_STATUS_TIMEOUT_MS,
  useServingRoomStatus,
} from "../src/ui/status/serving-status.js";

const ROOM_A = "6f4c8a51-2b7d-4e39-9a06-c81d3f572be4/doc-a";
const ROOM_B = "6f4c8a51-2b7d-4e39-9a06-c81d3f572be4/doc-b";

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function status(room: string, hubAcked: boolean): DocumentSearchStatus {
  return { caughtUp: hubAcked, rooms: { [room]: { hubAcked } } };
}

function client(
  read: DocumentSearchClient["status"],
): DocumentSearchClient {
  return {
    status: vi.fn(read),
    search: vi.fn(async () => []),
    update: vi.fn(async () => null),
  };
}

function Reading({
  api,
  room,
}: {
  api: DocumentSearchClient | null;
  room: string | null;
}) {
  const reading = useServingRoomStatus(api, room);
  return (
    <output>
      {reading === null ? "unknown" :
        `${reading.hubAcked === null ? "unknown" : reading.hubAcked ? "yes" : "no"}${reading.notSharedReason === null ? "" : `: ${reading.notSharedReason}`}`}
    </output>
  );
}

function mount(api: DocumentSearchClient | null, room: string | null): {
  host: HTMLElement;
  view: RenderResult;
} {
  const view = render(<Reading api={api} room={room} />);
  const host = view.container;
  return { host, view };
}

function connectedRoom() {
  const listeners = new Set<(status: RoomStatus) => void>();
  const current: RoomStatus = {
    connected: true, synced: true, writable: true, unsyncedChanges: 0,
    hasReceivedServerState: true, hasAnswered: true, storeRefused: false,
    protocolMismatch: null, authFailed: false, tokenMissing: false,
  };
  const connection = {
    room: ROOM_A,
    ydoc: new Y.Doc(),
    provider: { awareness: null },
    status: current,
    onStatusChange(listener: (status: RoomStatus) => void) {
      listeners.add(listener);
      listener(current);
      return () => { listeners.delete(listener); };
    },
  } as unknown as RoomConnection;
  return {
    connection,
    listeners,
    change(patch: Partial<RoomStatus>) {
      Object.assign(current, patch);
      for (const listener of listeners) listener({ ...current });
    },
  };
}

function ServedReading({ api, connection }: { api: DocumentSearchClient; connection: RoomConnection }) {
  const reading = useServingRoomStatus(api, connection.room, connection);
  return <>
    <StatusLine connection={connection} presence={[]} syncReading={{ hubAcked: reading?.hubAcked ?? null }} />
    <output>{reading?.hubAcked === null ? "unknown" : reading?.hubAcked ? "yes" : "no"}</output>
  </>;
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("the locally served room's upstream reading", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("publishes raw poll and provider results on the status element before presentation settles", async () => {
    vi.useFakeTimers();
    const answer = deferred<DocumentSearchStatus>();
    const api = client(() => answer.promise);
    const room = connectedRoom();
    const view = render(<ServedReading api={api} connection={room.connection} />);
    const element = view.container.querySelector<HTMLElement>(".ub-status")!;
    const presentation = view.container.querySelector("output")!;

    expect(element.dataset.localSync).toBe("acknowledged");
    expect(element.dataset.upstreamSync).toBe("pending");
    await act(async () => answer.resolve(status(ROOM_A, true)));
    expect(element.dataset.upstreamSync).toBe("acknowledged");
    expect(presentation.textContent).toBe("unknown");

    act(() => {
      room.change({ unsyncedChanges: 1 });
      // Check before act lets React flush its room-status subscription.
      expect(element.dataset.localSync).toBe("pending");
      expect(element.dataset.upstreamSync).toBe("pending");
    });
    act(() => {
      room.change({ unsyncedChanges: 0 });
      expect(element.dataset.localSync).toBe("acknowledged");
      expect(element.dataset.upstreamSync).toBe("pending");
    });
    view.unmount();
    room.connection.ydoc.destroy();
    expect(room.listeners.size).toBe(0);
  });

  it("ignores an in-flight upstream answer when a local edit and acknowledgement share its clock tick", async () => {
    vi.useFakeTimers();
    const stale = deferred<DocumentSearchStatus>();
    const fresh = deferred<DocumentSearchStatus>();
    const api = client(vi.fn().mockReturnValueOnce(stale.promise).mockReturnValueOnce(fresh.promise));
    const room = connectedRoom();
    const view = render(<ServedReading api={api} connection={room.connection} />);
    const element = view.container.querySelector<HTMLElement>(".ub-status")!;
    const started = Date.now();

    act(() => {
      room.change({ unsyncedChanges: 1 });
      room.change({ unsyncedChanges: 0 });
    });
    expect(Date.now()).toBe(started);
    await act(async () => stale.resolve(status(ROOM_A, true)));
    expect(element.dataset.localSync).toBe("acknowledged");
    expect(element.dataset.upstreamSync).toBe("pending");

    await act(async () => vi.advanceTimersByTimeAsync(SERVING_STATUS_POLL_MS));
    await act(async () => fresh.resolve(status(ROOM_A, true)));
    expect(element.dataset.upstreamSync).toBe("acknowledged");
    view.unmount();
    room.connection.ydoc.destroy();
    expect(room.listeners.size).toBe(0);
  });

  it("exposes an explicit sharing refusal immediately without changing local acknowledgement", async () => {
    const api = client(async () => ({ ...status(ROOM_A, false), notSharedReason: "no-hub-credentials" }));
    const room = connectedRoom();
    const view = render(<ServedReading api={api} connection={room.connection} />);
    await flush();
    const element = view.container.querySelector<HTMLElement>(".ub-status")!;
    expect(element.dataset.localSync).toBe("acknowledged");
    expect(element.dataset.upstreamSync).toBe("offline");
    view.unmount();
    room.connection.ydoc.destroy();
  });

  it("exposes uncalmed evidence with the request start time", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const pending = deferred<DocumentSearchStatus>();
    const api = client(async () => await pending.promise);
    function RawReading() {
      return <output>{JSON.stringify(useServingRoomStatus(api, ROOM_A))}</output>;
    }
    const view = render(<RawReading />);
    act(() => vi.setSystemTime(11_000));
    await act(async () => pending.resolve(status(ROOM_A, true)));
    expect(JSON.parse(view.container.textContent ?? "null")).toMatchObject({
      hubAcked: null,
      rawHubAcked: true,
      sampledAt: 10_000,
    });
  });

  it("ignores a late answer after the room changes", async () => {
    vi.useFakeTimers();
    const a = deferred<DocumentSearchStatus>();
    const b = deferred<DocumentSearchStatus>();
    const api = client(
      vi
        .fn()
        .mockReturnValueOnce(a.promise)
        .mockReturnValueOnce(b.promise)
        .mockResolvedValue(status(ROOM_B, false)),
    );
    const { host, view } = mount(api, ROOM_A);

    view.rerender(<Reading api={api} room={ROOM_B} />);
    await act(async () => a.resolve(status(ROOM_A, true)));
    expect(host.textContent).toBe("unknown");

    await act(async () => b.resolve(status(ROOM_B, false)));
    expect(host.textContent).toBe("unknown");
    await act(async () =>
      vi.advanceTimersByTimeAsync(SERVING_STATUS_SETTLE_MS),
    );
    expect(host.textContent).toBe("no");
  });

  it("blanks a previous success on failure, omission and serving-mode exit", async () => {
    vi.useFakeTimers();
    let answer: DocumentSearchStatus | Error = status(ROOM_A, true);
    const api = client(async () => {
      if (answer instanceof Error) throw answer;
      return answer;
    });
    const { host, view } = mount(api, ROOM_A);

    await flush();
    await act(async () =>
      vi.advanceTimersByTimeAsync(SERVING_STATUS_SETTLE_MS),
    );
    expect(host.textContent).toBe("yes");

    answer = new Error("refused");
    await act(async () => vi.advanceTimersByTimeAsync(SERVING_STATUS_POLL_MS));
    expect(host.textContent).toBe("unknown");
    answer = { caughtUp: true, rooms: { [ROOM_B]: { hubAcked: true } } };
    await act(async () => vi.advanceTimersByTimeAsync(SERVING_STATUS_POLL_MS));
    expect(host.textContent).toBe("unknown");

    view.rerender(<Reading api={null} room={ROOM_A} />);
    expect(host.textContent).toBe("unknown");
  });

  it("does not adopt a contrary one-poll sample", async () => {
    vi.useFakeTimers();
    let hubAcked = true;
    const api = client(async () => status(ROOM_A, hubAcked));
    const { host } = mount(api, ROOM_A);

    await flush();
    await act(async () =>
      vi.advanceTimersByTimeAsync(SERVING_STATUS_SETTLE_MS),
    );
    expect(host.textContent).toBe("yes");

    hubAcked = false;
    await act(async () => vi.advanceTimersByTimeAsync(SERVING_STATUS_POLL_MS));
    expect(host.textContent).toBe("yes");
    hubAcked = true;
    await act(async () => vi.advanceTimersByTimeAsync(SERVING_STATUS_POLL_MS));
    expect(host.textContent).toBe("yes");
  });

  it("keeps the serving reason through blank room answers and replaces it on a successful poll", async () => {
    vi.useFakeTimers();
    let answer: DocumentSearchStatus | Error = {
      ...status(ROOM_A, false),
      notSharedReason: "no-hub-credentials",
    };
    const api = client(async () => {
      if (answer instanceof Error) throw answer;
      return answer;
    });
    const { host, view } = mount(api, ROOM_A);
    await flush();
    expect(host.textContent).toBe("unknown: no-hub-credentials");
    await act(async () => vi.advanceTimersByTimeAsync(SERVING_STATUS_SETTLE_MS));
    expect(host.textContent).toBe("no: no-hub-credentials");

    answer = {
      ...status(ROOM_B, false),
      notSharedReason: "no-hub-credentials",
    };
    await act(async () => vi.advanceTimersByTimeAsync(SERVING_STATUS_POLL_MS));
    expect(host.textContent).toBe("unknown: no-hub-credentials");

    view.rerender(<Reading api={api} room={ROOM_B} />);
    expect(host.textContent).toBe("unknown: no-hub-credentials");
    answer = new Error("unreachable");
    await flush();
    expect(host.textContent).toBe("unknown: no-hub-credentials");

    // A successful serving response replaces the reason even when it does not
    // answer the current room. It never grants that room an acknowledgement.
    answer = status(ROOM_A, true);
    await act(async () => vi.advanceTimersByTimeAsync(SERVING_STATUS_POLL_MS));
    expect(host.textContent).toBe("unknown");
    view.rerender(<Reading api={api} room={ROOM_A} />);
    await flush();
    await act(async () => vi.advanceTimersByTimeAsync(SERVING_STATUS_SETTLE_MS));
    expect(host.textContent).toBe("yes");
    answer = new Error("unreachable");
    await act(async () => vi.advanceTimersByTimeAsync(SERVING_STATUS_POLL_MS));
    expect(host.textContent).toBe("unknown");
  });

  it("does not carry the serving reason into a different client", async () => {
    vi.useFakeTimers();
    const api = client(async () => ({
      ...status(ROOM_A, false),
      notSharedReason: "no-hub-credentials",
    }));
    const next = client(async () => new Promise<DocumentSearchStatus>(() => {}));
    const { host, view } = mount(api, ROOM_A);
    await flush();
    expect(host.textContent).toBe("unknown: no-hub-credentials");
    view.rerender(<Reading api={next} room={ROOM_A} />);
    expect(host.textContent).toBe("unknown");
  });

  it("expires a hung request, blanks the old fact and keeps polling", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const recovered = deferred<DocumentSearchStatus>();
    const api = client(async () => {
      calls += 1;
      if (calls === 2) return await new Promise<DocumentSearchStatus>(() => {});
      if (calls === 3) return await recovered.promise;
      return status(ROOM_A, true);
    });
    const { host } = mount(api, ROOM_A);

    await flush();
    await act(async () =>
      vi.advanceTimersByTimeAsync(SERVING_STATUS_SETTLE_MS),
    );
    expect(host.textContent).toBe("yes");

    await act(async () =>
      vi.advanceTimersByTimeAsync(SERVING_STATUS_TIMEOUT_MS),
    );
    expect(host.textContent).toBe("unknown");
    await act(async () => vi.advanceTimersByTimeAsync(SERVING_STATUS_POLL_MS));
    expect(calls).toBeGreaterThanOrEqual(3);
    await act(async () => recovered.resolve(status(ROOM_A, true)));
    await act(async () =>
      vi.advanceTimersByTimeAsync(SERVING_STATUS_SETTLE_MS),
    );
    expect(host.textContent).toBe("yes");
  });
});
