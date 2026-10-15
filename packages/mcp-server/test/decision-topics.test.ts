

import { afterAll, afterEach, describe, expect, it } from "vitest";

import { FailingStore, removeTempDirs, startServer, tempDatabasePath, testConfig, WORKSPACE } from "./helpers.js";
import type { Rig } from "./helpers.js";

const rigs: Rig[] = [];
const stores: FailingStore[] = [];
afterEach(async () => { for (const rig of rigs.splice(0)) await rig.close(); for (const store of stores.splice(0)) store.close(); });
afterAll(removeTempDirs);

const blocks = [{ type: "paragraph", text: "Choose the implementation under these constraints." }];

async function decision(rig: Rig, fields: Record<string, unknown> = {}) {
  return rig.ok("create_doc", { title: "Topic", description: "A decision record.", kind: "decision", blocks, ...fields });
}

describe("decision topics through directory stubs", () => {

  it("reports topic archive and restore persistence failures per touched room", async () => {
    const databasePath = tempDatabasePath();
    const store = new FailingStore(databasePath, WORKSPACE);
    stores.push(store);
    const rig = await startServer(testConfig({ databasePath }), store);
    rigs.push(rig);
    const a = await decision(rig);
    const b = await decision(rig, { supersedes: a.uuid });
    store.failRoom = room => room === `${WORKSPACE}/_sidebar`;
    store.failing = true;
    const refused = await rig.call("archive_doc", { uuid: b.uuid });
    expect(refused.payload).toMatchObject({ error: "persistence_failed", partial: true, rolledBack: false, failed: { purpose: "sidebar" }, completed: [{ purpose: "directory", applied: true }] });
    await rig.close();
    rigs.splice(rigs.indexOf(rig), 1);
    const restartedStore = new FailingStore(databasePath, WORKSPACE);
    stores.push(restartedStore);
    const restarted = await startServer(testConfig({ databasePath }), restartedStore);
    rigs.push(restarted);
    expect((await restarted.ok("list_docs", { kind: "decision" })).docs).toEqual([]);
    restartedStore.failRoom = room => room === `${WORKSPACE}/_directory`;
    restartedStore.failing = true;
    const restore = await restarted.call("restore_doc", { uuid: b.uuid });
    expect(restore.payload).toMatchObject({ error: "persistence_failed", partial: false, rolledBack: false, failed: { purpose: "directory" }, completed: [] });
  });

});
