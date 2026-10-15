import { randomUUID } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { getMeta, initDoc, roomForDoc, upsertDirectoryEntry } from "@uberblick/schema";
import { collectReplicaSyncState } from "../src/status.js";
import { openWorkspaceReplicas, type WorkspaceReplicaSet } from "../src/workspace-replicas.js";
import { hubUrl, LIVE_HUB_SETTLE, removeTempDirs, startHub, testConfig, TEST_SECRET, WORKSPACE } from "./helpers.js";
import type { TestHub } from "./helpers.js";

const workspaces: WorkspaceReplicaSet[] = [];
const hubs: TestHub[] = [];

afterEach(async () => {
  for (const workspace of workspaces.splice(0)) await workspace.close();
  for (const hub of hubs.splice(0)) await hub.stop();
  removeTempDirs();
});

it("settles pending writes and rooms discovered during hydration without an engine or status polling", async () => {
  const hub = await startHub();
  hubs.push(hub);
  const config = () => testConfig({
    authSecret: TEST_SECRET, hubUrl: hubUrl(hub.port), ...LIVE_HUB_SETTLE,
  });
  const writer = openWorkspaceReplicas(config());
  workspaces.push(writer);
  const uuid = randomUUID();
  initDoc(writer.replicas.replica(uuid).doc, { uuid, title: "Settled document", description: "Hydrated through the directory." });
  upsertDirectoryEntry(writer.replicas.directory().doc, { uuid, title: "Settled document" });
  expect(writer.store.pendingRooms().length).toBeGreaterThan(0);
  expect(await writer.replicas.waitForSettled()).toEqual({ caughtUp: true, reason: "caught-up" });
  expect(writer.store.pendingRooms()).toEqual([]);

  const reader = openWorkspaceReplicas(config());
  workspaces.push(reader);
  expect(reader.replicas.known(uuid)).toBe(false);
  expect(await reader.replicas.waitForSettled()).toEqual({ caughtUp: true, reason: "caught-up" });
  expect(reader.replicas.known(uuid)).toBe(true);
  expect(getMeta(reader.replicas.replica(uuid).doc).title).toBe("Settled document");
  expect(collectReplicaSyncState(reader.replicas).caughtUp).toBe(true);

  expect(await reader.replicas.waitForSettled({ rooms: [roomForDoc(WORKSPACE, uuid)] })).toEqual({ caughtUp: true, reason: "caught-up" });
  expect(await reader.replicas.waitForSettled({
    rooms: [roomForDoc(WORKSPACE, randomUUID())], deadline: performance.now(),
  })).toEqual({ caughtUp: false, reason: "deadline" });
});

it("reports unavailable for a local-only replica even with no pending rooms", async () => {
  const workspace = openWorkspaceReplicas(testConfig());
  workspaces.push(workspace);
  expect(await workspace.replicas.waitForSettled()).toEqual({ caughtUp: false, reason: "unavailable" });
});
