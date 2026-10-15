import { getMetaMap } from "@uberblick/schema";
import type { Hub } from "@uberblick/hub";

import { afterEach, describe, expect, it } from "vitest";
import { compareCorpus, inspectRemote, isIdentical, syncWorkspace } from "../src/remote.js";
import { cleanupTestResources, hubUrl, LIVE_HUB_SETTLE, startHub, startServer, testConfig, TEST_SECRET, waitForCorpus } from "./helpers.js";
import type { Rig } from "./helpers.js";

const rigs: Rig[] = [];
const hubs: Hub[] = [];

async function localRig(config = testConfig()): Promise<Rig> {
  const rig = await startServer(config);
  rigs.push(rig);
  return rig;
}

afterEach(async () => {
  await cleanupTestResources({
    clients: rigs.splice(0).map((client) => () => client.close()),
    hubs: hubs.splice(0).map((hub) => () => hub.stop()),
  });
});

describe("removed changelog metadata", () => {
  it("has no tool, schema or help surface", async () => {
    const rig = await localRig();
    const { tools } = await rig.client.listTools();
    expect(JSON.stringify(tools)).not.toMatch(/changelog/i);
    const { topics } = await rig.ok("get_help");
    expect(JSON.stringify(topics)).not.toMatch(/changelog/i);
    for (const { id } of topics) {
      expect((await rig.ok("get_help", { topic: id })).text, id).not.toMatch(/changelog/i);
    }
    expect((await rig.call("get_help", { topic: "set_changelog_suggestion" })).payload.error)
      .toBe("unknown_help_topic");
  });

  it.each(["A stored legacy sentence.", null])("keeps stored %s through bridge upload and fresh-replica reads", async (value) => {
    const hub = await startHub();
    hubs.push(hub);
    const rig = await localRig();
    const { uuid } = await rig.ok("create_doc", {
      title: "Legacy bridge", description: "An offline document promoted to a hub.",
      blocks: [{ type: "paragraph", text: "Content survives promotion." }],
    });
    getMetaMap(rig.instance.replicas.replica(uuid).doc).set("changelogSuggestion", value);
    const before = await rig.ok("get_doc", { uuid });
    await rigs.pop()!.close();

    const config = {
      ...rig.config, authSecret: TEST_SECRET, hubUrl: hubUrl(hub.port), ...LIVE_HUB_SETTLE,
    };
    const uploaded = await syncWorkspace(config);
    const remote = await inspectRemote(config, { documents: true });
    expect(uploaded.complete).toBe(true);
    expect(uploaded.missing).toEqual([]);
    expect(uploaded.unsettled).toEqual([]);
    expect(remote.complete).toBe(true);
    expect(remote.missing).toEqual([]);
    expect(remote.unsettled).toEqual([]);
    expect(isIdentical(compareCorpus(uploaded.entries, remote.entries))).toBe(true);

    const fresh = await localRig(testConfig({
      authSecret: TEST_SECRET, hubUrl: hubUrl(hub.port), ...LIVE_HUB_SETTLE,
    }));
    await waitForCorpus(fresh, [uuid]);
    expect(await fresh.ok("get_doc", { uuid })).toEqual(before);
    expect(getMetaMap(fresh.instance.replicas.replica(uuid).doc).get("changelogSuggestion")).toBe(value);
  });
});
