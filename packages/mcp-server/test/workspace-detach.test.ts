import { afterEach, expect, it } from "vitest";
import { detachWorkspaceCopy, MirrorStore, WorkspaceDetachedError } from "../src/store.js";
import { cleanupTestResources, startServer, tempDatabasePath, testConfig, WORKSPACE, type Rig } from "./helpers.js";

const rigs: Rig[] = [];
const stores: MirrorStore[] = [];
afterEach(async () => {
  await cleanupTestResources({
    clients: rigs.splice(0).map(rig => () => rig.close()),
    after: stores.splice(0).map(store => () => store.close()),
  });
});

it("refuses stale MCP tools until restart while preserving documents and bundled help", async () => {
  const databasePath = tempDatabasePath();
  const rig = await startServer(testConfig({ databasePath }));
  rigs.push(rig);
  const created = await rig.ok("create_doc", { title: "Before detach", description: "Keep this local content." });
  detachWorkspaceCopy(databasePath, WORKSPACE, () => {});
  const refused = await rig.call("create_doc", { title: "After detach", description: "Must be refused." });
  expect(refused).toMatchObject({ isError: true, payload: { error: "workspace_detached", recoveryClass: "manual",
    recovery: expect.stringContaining("Restart the MCP server"), applied: false, partial: false, synced: false } });
  expect(await rig.call("get_doc", { uuid: created.uuid })).toMatchObject({ isError: true, payload: { error: "workspace_detached" } });
  expect(await rig.ok("sync_status")).toMatchObject({ caughtUp: false, hub: { status: "quarantined" } });
  await rig.ok("get_help", { topic: "tool-contracts" });
  await rig.client.listResources();
  await rig.client.readResource({ uri: "uberblick://help/tool-contracts" });
  const restarted = await startServer({ ...testConfig({ databasePath }), localWorkspace: true });
  rigs.push(restarted);
  expect(await restarted.ok("get_doc", { uuid: created.uuid })).toMatchObject({ title: "Before detach" });
  expect(await rig.call("list_docs")).toMatchObject({ isError: true, payload: { error: "workspace_detached" } });
});

it("rolls back the session fence and history discard if binding publication fails", () => {
  const path = tempDatabasePath();
  const before = new MirrorStore(path, WORKSPACE);
  stores.push(before);
  expect(() => detachWorkspaceCopy(path, WORKSPACE, () => { throw new Error("binding write failed"); })).toThrow("binding write failed");
  expect(before.isDetached()).toBe(false);
  expect(() => before.appendUpdate(`${WORKSPACE}/pending`, new Uint8Array([0, 0]), "local")).not.toThrow();
  detachWorkspaceCopy(path, WORKSPACE, () => {});
  expect(() => before.appendUpdate(`${WORKSPACE}/pending`, new Uint8Array([0, 0]), "remote")).toThrow(WorkspaceDetachedError);
});
