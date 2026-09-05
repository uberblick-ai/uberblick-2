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
    const api = client(vi.fn().mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise));
    const { host, root } = mount(api, ROOM_A);

    act(() => root.render(<Reading api={api} room={ROOM_B} />));
    await act(async () => a.resolve(status(ROOM_A, true)));
    expect(host.textContent).toBe("unknown");

    await act(async () => b.resolve(status(ROOM_B, false)));
    expect(host.textContent).toBe("unknown");
    await act(async () => vi.advanceTimersByTimeAsync(400));
    expect(host.textContent).toBe("no");
    act(() => root.unmount());
  });

  it("blanks a previous success on failure, omission and serving-mode exit", async () => {
    vi.useFakeTimers();
    const answers: Array<DocumentSearchStatus | Error> = [
      status(ROOM_A, true),
      new Error("refused"),
      { caughtUp: true, rooms: { [ROOM_B]: { hubAcked: true } } },
    ];
    const api = client(async () => {
      const next = answers.shift();
      if (next instanceof Error) throw next;
      if (next === undefined) return status(ROOM_A, true);
      return next;
    });
    const { host, root } = mount(api, ROOM_A);

    await flush();
    await act(async () => vi.advanceTimersByTimeAsync(300));
    expect(host.textContent).toBe("yes");

    await act(async () => vi.advanceTimersByTimeAsync(SERVING_STATUS_POLL_MS));
    expect(host.textContent).toBe("unknown");
    await act(async () => vi.advanceTimersByTimeAsync(SERVING_STATUS_POLL_MS));
    expect(host.textContent).toBe("unknown");

    act(() => root.render(<Reading api={null} room={ROOM_A} />));
    expect(host.textContent).toBe("unknown");
    act(() => root.unmount());
  });

  it("holds a brief false answer instead of strobing while writes settle", async () => {
    vi.useFakeTimers();
    const answers = [status(ROOM_A, true), status(ROOM_A, false), status(ROOM_A, true)];
    const api = client(async () => answers.shift() ?? status(ROOM_A, true));
    const { host, root } = mount(api, ROOM_A);

    await flush();
    await act(async () => vi.advanceTimersByTimeAsync(300));
    expect(host.textContent).toBe("yes");

    await act(async () => vi.advanceTimersByTimeAsync(SERVING_STATUS_POLL_MS));
    expect(host.textContent).toBe("yes");
    await act(async () => vi.advanceTimersByTimeAsync(399));
    expect(host.textContent).toBe("yes");
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(host.textContent).toBe("no");

    await act(async () => vi.advanceTimersByTimeAsync(600));
    expect(host.textContent).toBe("no");
    await act(async () => vi.advanceTimersByTimeAsync(300));
    expect(host.textContent).toBe("yes");
    act(() => root.unmount());
  });
});
