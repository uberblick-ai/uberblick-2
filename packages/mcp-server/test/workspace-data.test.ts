

import { afterEach, describe, expect, it } from "vitest";

import { updateWorkspaceData } from "../src/workspace-data.js";
import { cleanupTestResources, hubUrl, LIVE_HUB_SETTLE, startHub, startServer, TEST_SECRET, testConfig } from "./helpers.js";
import type { Rig, TestHub } from "./helpers.js";

const rigs: Rig[] = [];
const hubs: TestHub[] = [];
const schema = {
  version: 1,
  schema: {
    type: "object", properties: { text: { type: "string" } },
    required: ["text"], additionalProperties: false,
  },
};
const operations = [{
  collection: "observations", schema, upsert: [{ id: "row-a", value: { text: "first" } }],
}];

async function create(rig: Rig, fields: Record<string, unknown> = {}) {
  return rig.ok("create_doc", {
    title: "Workspace data", description: "A file data operation fixture.",
    blocks: [{ type: "paragraph", text: "A supported answer." }], ...fields,
  });
}

afterEach(async () => {
  await cleanupTestResources({
    clients: rigs.splice(0).map((client) => () => client.close()),
    hubs: hubs.splice(0).map((hub) => () => hub.stop()),
  });
});

describe("workspace file data operations", () => {

  it("reports acknowledgement only after the hub receives the write", async () => {
    const hub = await startHub();
    hubs.push(hub);
    const rig = await startServer(testConfig({ hubUrl: hubUrl(hub.port), authSecret: TEST_SECRET, ...LIVE_HUB_SETTLE }));
    rigs.push(rig);
    const { uuid } = await create(rig);
    const result = await updateWorkspaceData(rig.instance.replicas, { uuid, operations });
    expect(result).toMatchObject({ changed: true, synced: true });
    expect(rig.instance.replicas.isRoomQuiet(rig.instance.replicas.replica(uuid).room)).toBe(true);
  });

});
