/** Only applied document changes arm pulses; connection handshakes do not. */

import { act, render } from "./react-render.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import type { RoomConnection, RoomStatus } from "../src/collab/rooms.js";
import { useDocumentSyncActivity } from "../src/ui/status/document-sync-activity.js";
import type { DocumentSyncActivity } from "../src/ui/status/document-sync-activity.js";

function room(patch: Partial<RoomStatus> = {}) {
  const ydoc = new Y.Doc();
  const provider = {};
  const listeners = new Set<(status: RoomStatus) => void>();
  const status: RoomStatus = {
    connected: true,
    synced: true,
    hasReceivedServerState: true,
    hasAnswered: true,
    writable: true,
    storeRefused: false,
    unsyncedChanges: 0,
    protocolMismatch: null,
    authFailed: false,
    tokenMissing: false,
    ...patch,
  };
  const update = (patch: Partial<RoomStatus>) => {
    Object.assign(status, patch);
    for (const listener of listeners) listener({ ...status });
  };
  // The provider observes local writes before UI subscribers do.
  ydoc.on("update", (_bytes: Uint8Array, origin: unknown) => {
    if (origin !== provider) update({ unsyncedChanges: status.unsyncedChanges + 1 });
  });
  const connection = {
    room: "workspace/document",
    ydoc,
    provider,
    status,
    onStatusChange(listener: (status: RoomStatus) => void) {
      listeners.add(listener);
      listener({ ...status });
      return () => listeners.delete(listener);
    },
  } as unknown as RoomConnection;
  const remote = new Y.Doc();
  let revision = 0;
  return {
    connection,
    update,
    local() { ydoc.getMap("meta").set("title", `local ${++revision}`); },
    remote() {
      remote.getMap("meta").set("title", `remote ${++revision}`);
      Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(remote), provider);
    },
  };
}

function mount(connection: RoomConnection, hubAcked?: boolean | null, sampledAt: number | null = null) {
  function Reading({ connection, acked, sampledAt }: {
    connection: RoomConnection;
    acked: boolean | null | undefined;
    sampledAt: number | null;
  }) {
    return <output>{JSON.stringify(useDocumentSyncActivity(connection, acked, acked, sampledAt))}</output>;
  }
  const view = render(<Reading connection={connection} acked={hubAcked} sampledAt={sampledAt} />);
  return {
    read: () => JSON.parse(view.container.textContent ?? "null") as DocumentSyncActivity,
    rerender: (acked: boolean | null, sampledAt: number | null) => {
      view.rerender(<Reading connection={connection} acked={acked} sampledAt={sampledAt} />);
    },
    replace: (next: RoomConnection) => {
      view.rerender(<Reading connection={next} acked={hubAcked} sampledAt={sampledAt} />);
    },
  };
}

describe("document sync activity", () => {
  afterEach(() => vi.useRealTimers());

  it("confirms opening and reconnecting without pulsing for their inbound state", () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const doc = room({ synced: false });
    const view = mount(doc.connection);
    expect(view.read()).toEqual({ lastConfirmedAt: null, pulse: 0, confirmed: false });
    act(() => doc.remote());
    act(() => doc.update({ synced: true }));
    expect(view.read()).toEqual({ lastConfirmedAt: 10_000, pulse: 0, confirmed: true });

    act(() => doc.update({ connected: false, synced: false, writable: false }));
    act(() => doc.update({ connected: true, writable: true, unsyncedChanges: 1 }));
    act(() => doc.remote());
    act(() => doc.update({ synced: true, unsyncedChanges: 0 }));
    expect(view.read().pulse).toBe(0);
  });

  it("pulses when a local edit is acknowledged even within one React batch", () => {
    const doc = room();
    const view = mount(doc.connection);
    act(() => {
      doc.local();
      doc.update({ unsyncedChanges: 0 });
    });
    expect(view.read().pulse).toBe(1);
    expect(view.read().confirmed).toBe(true);
    act(() => doc.update({ unsyncedChanges: 0 }));
    expect(view.read().pulse).toBe(1);
  });

  it("pulses once for an applied incoming change after the handshake", () => {
    const doc = room();
    const view = mount(doc.connection);
    act(() => doc.remote());
    expect(view.read().pulse).toBe(1);
    act(() => doc.update({ unsyncedChanges: 0 }));
    expect(view.read().pulse).toBe(1);
  });

  it("waits for a fresh upstream sample after local saving, even when false was never polled", () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const doc = room();
    const view = mount(doc.connection, true, 9_000);
    expect(view.read()).toEqual({ lastConfirmedAt: 9_000, pulse: 0, confirmed: true });
    act(() => doc.local());
    expect(view.read().confirmed).toBe(false);
    act(() => doc.update({ unsyncedChanges: 0 }));
    expect(view.read().pulse).toBe(0);

    view.rerender(true, 9_500);
    expect(view.read().confirmed).toBe(false);
    view.rerender(true, 10_001);
    expect(view.read()).toEqual({ lastConfirmedAt: 10_001, pulse: 1, confirmed: true });
    view.rerender(true, 11_000);
    expect(view.read().lastConfirmedAt).toBe(10_001);
    expect(view.read().pulse).toBe(1);
  });

  it("requires hub confirmation for incoming changes delivered by the local replica", () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const doc = room();
    const view = mount(doc.connection, true, 9_000);
    act(() => doc.remote());
    expect(view.read().pulse).toBe(0);
    view.rerender(false, 11_000);
    expect(view.read().confirmed).toBe(false);
    view.rerender(true, 12_000);
    expect(view.read().pulse).toBe(1);
  });

  it("keeps a local change pending through a reconnect until its hub acknowledgement", () => {
    const doc = room();
    const view = mount(doc.connection);
    act(() => doc.update({ connected: false, synced: false, writable: false }));
    act(() => doc.local());
    expect(view.read().pulse).toBe(0);
    act(() => doc.update({ connected: true, writable: true, unsyncedChanges: 1 }));
    act(() => doc.remote());
    expect(view.read().pulse).toBe(0);
    act(() => doc.update({ synced: true, unsyncedChanges: 0 }));
    expect(view.read().pulse).toBe(1);
  });

  it("keeps unknown acknowledgement and refusals unconfirmed", () => {
    const doc = room();
    const view = mount(doc.connection, null);
    expect(view.read().confirmed).toBe(false);
    view.rerender(true, 10_000);
    expect(view.read().confirmed).toBe(true);
    view.rerender(null, null);
    expect(view.read().confirmed).toBe(false);
    act(() => doc.update({ authFailed: true }));
    view.rerender(true, 11_000);
    expect(view.read().confirmed).toBe(false);
    expect(view.read().pulse).toBe(0);
  });

  it("does not transfer activity to another connection", () => {
    const first = room();
    const view = mount(first.connection);
    act(() => first.remote());
    const second = room({ synced: false });
    view.replace(second.connection);
    expect(view.read()).toEqual({ lastConfirmedAt: null, pulse: 0, confirmed: false });
    act(() => first.remote());
    expect(view.read().pulse).toBe(0);
  });
});
