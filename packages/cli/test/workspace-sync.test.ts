/** A workspace is current only when this replica covers the hub-acknowledged store cut. */

import { randomUUID } from "node:crypto";
import { SYNC_PROTOCOL_VERSION } from "@uberblick/hub/protocol";
import { createMcpServer, resolveMcpConfig } from "@uberblick/mcp-server";
import type { UberblickMcpServer } from "@uberblick/mcp-server";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { workspaceCaughtUp } from "../src/status.js";
import { removeTempDirs, sandbox } from "./helpers.js";

const WORKSPACE = "aeb8e90a-2452-4228-a012-cb0a6eebf01a";
const HUB = "ws://localhost:1234";
const instances: UberblickMcpServer[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const instance of instances.splice(0)) await instance.close();
  removeTempDirs();
});

function replicaFixture() {
  const box = sandbox({ projectBinding: { workspaceId: WORKSPACE, hubUrl: null } });
  // A real local store without a socket: spies below control only the hub's
  // observed acknowledgement, never the store's pending markers or log cuts.
  const instance = createMcpServer(resolveMcpConfig({
    ...box.env, WORKSPACE_ID: WORKSPACE, HUB_URL: HUB, HUB_AUTH_TOKEN: "",
  }));
  instances.push(instance);
  const replicas = instance.replicas;
  const replica = replicas.attachedReplicas()[0];
  if (replica === undefined) throw new Error("The server must attach its directory replica at boot.");
  for (const pending of instance.store.pendingRooms()) {
    instance.store.clearPending(pending.room, pending.seq);
  }
  const hub = vi.spyOn(replicas.sync, "state").mockReturnValue({
    status: "connected", url: HUB, protocolVersion: SYNC_PROTOCOL_VERSION,
  });
  const drain = vi.spyOn(replicas.sync, "isDraining").mockReturnValue(false);
  const quiet = vi.spyOn(replicas, "isRoomQuiet").mockReturnValue(true);
  return { instance, replicas, replica, hub, drain, quiet };
}

function update(): Uint8Array {
  const doc = new Y.Doc();
  doc.getText("body").insert(0, "A synthetic peer change.");
  const encoded = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return encoded;
}

describe("workspace full-replica acknowledgement", () => {
  it.each(["update log", "compacted snapshot"])(
    "keeps a peer-cleared pending marker false until this replica applies the %s",
    (storage) => {
      const { instance, replicas, replica } = replicaFixture();
      expect(workspaceCaughtUp(replicas)).toBe(true);

      const seq = instance.store.appendUpdate(replica.room, update(), "local");
      // The peer has sent and acknowledged this change. Its clearing the shared
      // marker does not mean this process has replayed that peer's log cut.
      instance.store.clearPending(replica.room, seq);
      if (storage === "compacted snapshot") instance.store.compact(replica.room, update(), seq);
      expect(workspaceCaughtUp(replicas)).toBe(false);

      replica.lastSeq = seq;
      expect(workspaceCaughtUp(replicas)).toBe(true);
    },
  );

  it("does not forget pending changes in a room that is not attached here", () => {
    const { instance, replicas } = replicaFixture();
    const room = `${WORKSPACE}/${randomUUID()}`;
    expect(workspaceCaughtUp(replicas)).toBe(true);
    const seq = instance.store.appendUpdate(room, update(), "local");
    expect(workspaceCaughtUp(replicas)).toBe(false);
    instance.store.clearPending(room, seq);
    expect(workspaceCaughtUp(replicas)).toBe(true);
  });

  it("requires both provider acknowledgement and a completed attach drain", () => {
    const { replicas, drain, quiet } = replicaFixture();
    expect(workspaceCaughtUp(replicas)).toBe(true);
    quiet.mockReturnValue(false);
    expect(workspaceCaughtUp(replicas)).toBe(false);
    quiet.mockReturnValue(true);
    drain.mockReturnValue(true);
    expect(workspaceCaughtUp(replicas)).toBe(false);
    drain.mockReturnValue(false);
    expect(workspaceCaughtUp(replicas)).toBe(true);
  });

  it.each(["hub-down", "auth-failed", "connecting", "disabled"] as const)(
    "does not claim acknowledgement while the hub is %s",
    (status) => {
      const { instance, replicas, hub } = replicaFixture();
      instance.store.recordLastSync(Date.now());
      expect(workspaceCaughtUp(replicas)).toBe(true);
      hub.mockReturnValue({
        status, url: status === "disabled" ? null : HUB, protocolVersion: SYNC_PROTOCOL_VERSION,
      });
      expect(workspaceCaughtUp(replicas)).toBe(false);
    },
  );

  it("does not claim acknowledgement after a local persistence failure", () => {
    const { replicas, replica } = replicaFixture();
    expect(workspaceCaughtUp(replicas)).toBe(true);
    vi.spyOn(replicas, "persistenceError").mockReturnValue({
      room: replica.room, message: "Synthetic update-log failure.",
    });
    expect(workspaceCaughtUp(replicas)).toBe(false);
  });
});
