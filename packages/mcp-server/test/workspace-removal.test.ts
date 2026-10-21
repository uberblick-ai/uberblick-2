import { existsSync, rmSync } from "node:fs";
import { ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { createTagCatalogEntry, setTags } from "@uberblick/schema";
import { afterEach, expect, it, vi } from "vitest";
import { MirrorStore, WorkspaceRemovedError } from "../src/store.js";
import type { UpdateOrigin } from "../src/store.js";
import { cleanupTestResources, startServer, tempDatabasePath, testConfig, WORKSPACE } from "./helpers.js";
import type { Rig } from "./helpers.js";

const rigs: Rig[] = [];
const stores: MirrorStore[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupTestResources({
    clients: rigs.splice(0).map((rig) => () => rig.close()),
    after: stores.splice(0).map((store) => () => store.close()),
  });
});

it.each(["list", "read"] as const)("refuses removed-workspace resource %s without hiding product help", async (first) => {
  const databasePath = tempDatabasePath();
  const rig = await startServer(testConfig({ databasePath }));
  rigs.push(rig);
  const guide = await rig.ok("create_doc", {
    title: "Workspace guidance", description: "Removal test.",
    blocks: [{ type: "paragraph", text: "Read before writing." }],
  });
  const marker = "5a7808ea-1c79-4330-af35-3f67f9f38a3b";
  createTagCatalogEntry(rig.instance.replicas.settings().doc, "guidance", marker);
  setTags(rig.instance.replicas.replica(guide.uuid).doc, [marker]);
  const uri = `uberblick://doc/${guide.uuid}`;
  expect((await rig.client.listResources()).resources).toContainEqual(expect.objectContaining({ uri }));
  expect((await rig.client.readResource({ uri })).contents[0]).toMatchObject({
    text: expect.stringContaining("Read before writing."),
  });
  const help = await rig.client.readResource({ uri: "uberblick://help/tool-contracts" });
  const toolHelp = await rig.ok("get_help", { topic: "tool-contracts" });
  const stderr = vi.spyOn(console, "error").mockImplementation(() => {});

  removeFiles(databasePath);
  const list = () => rig.client.listResources();
  const read = () => rig.client.readResource({ uri });
  for (const call of [first === "list" ? list : read, list, read]) {
    await expect(call()).rejects.toMatchObject({
      code: ErrorCode.InternalError,
      message: `MCP error ${ErrorCode.InternalError}: ${new WorkspaceRemovedError().message}`,
      data: undefined,
    });
  }
  expect(await rig.client.readResource({ uri: "uberblick://help/tool-contracts" })).toEqual(help);
  expect(await rig.ok("get_help", { topic: "tool-contracts" })).toEqual(toolHelp);
  expect(stderr.mock.calls.flat().join("\n")).not.toContain("resource call failed");
});

function removeFiles(path: string): void {
  for (const suffix of ["", "-wal", "-shm"]) rmSync(path + suffix, { force: true });
}

function expectNoFiles(path: string): void {
  for (const suffix of ["", "-wal", "-shm"]) expect(existsSync(path + suffix)).toBe(false);
}

function expectRemoved(result: Awaited<ReturnType<Rig["call"]>>): void {
  expect(result.isError).toBe(true);
  expect(result.payload).toMatchObject({
    error: "workspace_removed",
    message: expect.stringContaining("workspace was removed from this computer"),
    recoveryClass: "manual",
    recovery: expect.stringContaining("Restart the MCP server"),
    applied: false,
    partial: false,
    synced: false,
  });
}

it("refuses every later write in each open MCP session and leaves no files at shutdown", async () => {
  const databasePath = tempDatabasePath();
  const config = testConfig({ databasePath });
  const first = await startServer(config);
  const second = await startServer(config);
  rigs.push(first, second);
  await first.ok("create_doc", { title: "Before removal", description: "Removal test." });

  removeFiles(databasePath);
  for (const rig of [first, second]) {
    expectRemoved(await rig.call("create_doc", { title: "After removal", description: "Removal test." }));
    expectRemoved(await rig.call("sidebar_group", { action: "rename", group: "existing", name: "After removal" }));
    expectRemoved(await rig.call("create_doc", { title: "Still removed", description: "Removal test." }));
    await rig.ok("get_help", { topic: "tool-contracts" });
    await rig.ok("sync_status");
  }
  await first.close();
  await second.close();
  expectNoFiles(databasePath);
});

it("detects a replacement before its first later call and cannot damage the new copy on exit", async () => {
  const databasePath = tempDatabasePath();
  const config = testConfig({ databasePath });
  const old = await startServer(config);
  rigs.push(old);
  await old.ok("create_doc", { title: "Old copy", description: "Removal test." });

  removeFiles(databasePath);
  const fresh = await startServer(config);
  rigs.push(fresh);
  const created = await fresh.ok("create_doc", { title: "New copy", description: "Removal test." });
  expectRemoved(await old.call("create_doc", { title: "Must not reach new copy", description: "Removal test." }));
  await old.close();
  expect(existsSync(`${databasePath}-wal`)).toBe(true);
  const later = await fresh.ok("create_doc", { title: "After old session exits", description: "Removal test." });
  await fresh.close();

  const restarted = await startServer(config);
  rigs.push(restarted);
  const listing = await restarted.ok("list_docs");
  expect(listing.docs.map((doc: { uuid: string }) => doc.uuid).sort()).toEqual([created.uuid, later.uuid].sort());
});

it("keeps the removed-session refusal sticky after it has already observed removal", async () => {
  const databasePath = tempDatabasePath();
  const config = testConfig({ databasePath });
  const old = await startServer(config);
  rigs.push(old);
  removeFiles(databasePath);
  expectRemoved(await old.call("create_doc", { title: "Refused before replacement", description: "Removal test." }));
  const fresh = await startServer(config);
  rigs.push(fresh);
  expectRemoved(await old.call("create_doc", { title: "Refused after replacement", description: "Removal test." }));
  await fresh.ok("create_doc", { title: "Fresh session works", description: "Removal test." });
});

class RemovingStore extends MirrorStore {
  removeOnAppend = false;

  override appendUpdate(room: string, payload: Uint8Array, origin: UpdateOrigin): number {
    if (this.removeOnAppend) removeFiles(this.databasePath);
    return super.appendUpdate(room, payload, origin);
  }
}

it("returns the specific refusal when removal happens after a write was admitted", async () => {
  const databasePath = tempDatabasePath();
  const store = new RemovingStore(databasePath, WORKSPACE);
  stores.push(store);
  const rig = await startServer(testConfig({ databasePath }), store);
  rigs.push(rig);
  store.removeOnAppend = true;
  expectRemoved(await rig.call("create_doc", { title: "Removed while writing", description: "Removal test." }));
  await rig.close();
  expectNoFiles(databasePath);
});

it("refuses remote appends and derived writes after removal", () => {
  const databasePath = tempDatabasePath();
  const store = new MirrorStore(databasePath, WORKSPACE);
  stores.push(store);
  removeFiles(databasePath);
  expect(() => store.appendUpdate(`${WORKSPACE}/remote`, new Uint8Array([0, 0]), "remote"))
    .toThrow(WorkspaceRemovedError);
  expect(() => store.clearPending(`${WORKSPACE}/remote`, 1)).toThrow(WorkspaceRemovedError);
  expect(() => store.recordLastSync(Date.now())).toThrow(WorkspaceRemovedError);
  expect(() => store.clearDerived()).toThrow(WorkspaceRemovedError);
  store.close();
  expectNoFiles(databasePath);
});
