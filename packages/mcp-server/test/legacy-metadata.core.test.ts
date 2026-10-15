import { getMetaMap } from "@uberblick/schema";

import * as Y from "yjs";
import { afterEach, describe, expect, it } from "vitest";

import { cleanupTestResources, startServer, testConfig } from "./core-helpers.js";
import type { Rig } from "./core-helpers.js";

const rigs: Rig[] = [];

async function localRig(config = testConfig()): Promise<Rig> {
  const rig = await startServer(config);
  rigs.push(rig);
  return rig;
}

afterEach(async () => {
  await cleanupTestResources({
    clients: rigs.splice(0).map((client) => () => client.close()),
  });
});

describe("removed changelog metadata", () => {

  it.each(["A stored legacy sentence.", null])("reads stored %s without returning or rewriting it", async (value) => {
    const rig = await localRig();
    const { uuid } = await rig.ok("create_doc", {
      title: "Legacy metadata", description: "A document from an earlier version.",
      blocks: [{ type: "paragraph", text: "Still readable." }],
    });
    const before = await rig.ok("get_doc", { uuid });
    const doc = rig.instance.replicas.replica(uuid).doc;
    getMetaMap(doc).set("changelogSuggestion", value);
    const encoded = Y.encodeStateAsUpdate(doc);

    expect(await rig.ok("get_doc", { uuid })).toEqual(before);
    expect(getMetaMap(doc).get("changelogSuggestion")).toBe(value);
    expect(Y.encodeStateAsUpdate(doc)).toEqual(encoded);
  });

});
