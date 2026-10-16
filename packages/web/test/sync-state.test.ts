import { describe, expect, it } from "vitest";
import type { RoomConnection, RoomStatus } from "../src/collab/rooms.js";
import { bindSyncAttributes, observeSyncState } from "../src/ui/status/sync-state.js";

function fixture() {
  const listeners = new Set<(status: RoomStatus) => void>();
  const status: RoomStatus = {
    connected: true, synced: true, writable: true, unsyncedChanges: 0,
    hasReceivedServerState: true, hasAnswered: true, storeRefused: false,
    protocolMismatch: null, authFailed: false, tokenMissing: false,
  };
  const connection = {
    room: "workspace/doc", status,
    onStatusChange(listener: (status: RoomStatus) => void) {
      listeners.add(listener);
      listener(status);
      return () => { listeners.delete(listener); };
    },
  } as RoomConnection;
  return {
    connection,
    listeners,
    change(patch: Partial<RoomStatus>) {
      Object.assign(status, patch);
      for (const listener of listeners) listener({ ...status });
    },
  };
}

describe("document settle attributes", () => {
  it("does not acknowledge refused or not-yet-admitted rooms with retained sync flags", () => {
    const fix = fixture();
    const element = document.createElement("div");
    const unbind = bindSyncAttributes(element, fix.connection, false);
    fix.change({ writable: false });
    expect(element.dataset.localSync).toBe("pending");
    fix.change({ authFailed: true });
    expect(element.dataset.localSync).toBe("offline");
    fix.change({ authFailed: false, tokenMissing: true });
    expect(element.dataset.localSync).toBe("offline");
    fix.change({ tokenMissing: false, storeRefused: true });
    expect(element.dataset.localSync).toBe("offline");
    unbind();
  });

  it("invalidates local acknowledgement synchronously and leaves presentation timers independent", () => {
    const fix = fixture();
    const element = document.createElement("div");
    const unbind = bindSyncAttributes(element, fix.connection, false);
    expect(element.dataset.localSync).toBe("acknowledged");
    expect(element.hasAttribute("data-upstream-sync")).toBe(false);
    fix.change({ unsyncedChanges: 1 });
    expect(element.dataset.localSync).toBe("pending");
    fix.change({ unsyncedChanges: 0 });
    expect(element.dataset.localSync).toBe("acknowledged");
    fix.change({ connected: false });
    expect(element.dataset.localSync).toBe("offline");
    unbind();
    expect(fix.listeners.size).toBe(0);
  });

  it("requires an upstream request started after acknowledgement of the latest change", () => {
    const fix = fixture();
    const element = document.createElement("div");
    const unbind = bindSyncAttributes(element, fix.connection, true);
    const sync = observeSyncState(fix.connection);
    sync.request()(true);
    expect(element.dataset.upstreamSync).toBe("acknowledged");
    const beforeEdit = sync.request();
    fix.change({ unsyncedChanges: 1 });
    expect(element.dataset.upstreamSync).toBe("pending");
    const beforeAck = sync.request();
    fix.change({ unsyncedChanges: 0 });
    beforeEdit(true);
    expect(element.dataset.upstreamSync).toBe("pending");
    beforeAck(true);
    expect(element.dataset.upstreamSync).toBe("pending");
    sync.request()(true);
    expect(element.dataset.upstreamSync).toBe("acknowledged");
    sync.request()(false);
    expect(element.dataset.upstreamSync).toBe("pending");
    sync.request()(null);
    expect(element.dataset.upstreamSync).toBe("offline");
    unbind();
    expect(fix.listeners.size).toBe(1);
    sync.release();
    expect(fix.listeners.size).toBe(0);
  });

  it("cannot reuse confirmation across disconnects, remounts or documents", () => {
    const fix = fixture();
    const sync = observeSyncState(fix.connection);
    const element = document.createElement("div");
    let unbind = bindSyncAttributes(element, fix.connection, true);
    const beforeDisconnect = sync.request();
    fix.change({ connected: false });
    expect(element.dataset.upstreamSync).toBe("offline");
    fix.change({ connected: true });
    beforeDisconnect(true);
    expect(element.dataset.upstreamSync).toBe("pending");
    sync.request()(true);
    unbind();
    unbind = bindSyncAttributes(element, fixture().connection, true);
    expect(element.dataset.upstreamSync).toBe("pending");
    unbind();
    sync.release();
    const reopened = observeSyncState(fix.connection);
    unbind = bindSyncAttributes(element, fix.connection, true);
    expect(element.dataset.upstreamSync).toBe("pending");
    unbind();
    reopened.release();
  });
});
