/** The `/api/status` room reading is current, calm and never guessed. */

import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  DocumentSearchClient,
  DocumentSearchStatus,
} from "../src/shell/document-search.js";
import {
  SERVING_STATUS_POLL_MS,
  SERVING_STATUS_SETTLE_MS,
  SERVING_STATUS_TIMEOUT_MS,
  useServingRoomStatus,
} from "../src/ui/serving-status.js";

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
    search: vi.fn(async () => ({ hits: [], limit: 100, capped: false })),
    status: vi.fn(read),
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
    <output>{reading === null ? "unknown" : reading ? "yes" : "no"}</output>
  );
}

function mount(api: DocumentSearchClient | null, room: string | null): {
  host: HTMLElement;
  root: Root;
} {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(<Reading api={api} room={room} />));
  return { host, root };
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
    document.body.replaceChildren();
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
    const { host, root } = mount(api, ROOM_A);

    act(() => root.render(<Reading api={api} room={ROOM_B} />));
    await act(async () => a.resolve(status(ROOM_A, true)));
    expect(host.textContent).toBe("unknown");

    await act(async () => b.resolve(status(ROOM_B, false)));
    expect(host.textContent).toBe("unknown");
    await act(async () =>
      vi.advanceTimersByTimeAsync(SERVING_STATUS_SETTLE_MS),
    );
    expect(host.textContent).toBe("no");
    act(() => root.unmount());
  });

  it("blanks a previous success on failure, omission and serving-mode exit", async () => {
    vi.useFakeTimers();
    let answer: DocumentSearchStatus | Error = status(ROOM_A, true);
    const api = client(async () => {
      if (answer instanceof Error) throw answer;
      return answer;
    });
    const { host, root } = mount(api, ROOM_A);

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

    act(() => root.render(<Reading api={null} room={ROOM_A} />));
    expect(host.textContent).toBe("unknown");
    act(() => root.unmount());
  });

  it("does not adopt a contrary one-poll sample", async () => {
    vi.useFakeTimers();
    let hubAcked = true;
    const api = client(async () => status(ROOM_A, hubAcked));
    const { host, root } = mount(api, ROOM_A);

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
    act(() => root.unmount());
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
    const { host, root } = mount(api, ROOM_A);

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
    act(() => root.unmount());
  });
});
