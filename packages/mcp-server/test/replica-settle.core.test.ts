
import { afterEach, expect, it } from "vitest";

import { openWorkspaceReplicas, type WorkspaceReplicaSet } from "../src/workspace-replicas.js";
import { cleanupTestResources, testConfig } from "./core-helpers.js";

const workspaces: WorkspaceReplicaSet[] = [];

afterEach(async () => {
  await cleanupTestResources({
    clients: workspaces.splice(0).map((client) => () => client.close()),
  });
});

it("reports unavailable for a local-only replica even with no pending rooms", async () => {
  const workspace = openWorkspaceReplicas(testConfig());
  workspaces.push(workspace);
  expect(await workspace.replicas.waitForSettled()).toEqual({ caughtUp: false, reason: "unavailable" });
});
