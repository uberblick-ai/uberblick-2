import { randomUUID } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { getMeta, initDoc, setKind, setMemoryAgent, setMemoryRepository } from "@uberblick/schema";
import { startServer } from "./core-helpers.js";
import type { Rig } from "./core-helpers.js";

let rig: Rig | undefined;
afterEach(async () => { await rig?.close(); rig = undefined; });

it("keeps memory creation and kind filters outside the MCP input surface", async () => {
  rig = await startServer();
  for (const [tool, args] of [
    ["create_doc", { title: "Memory", description: "A scoped agent note.", kind: "memory" }],
    ["list_docs", { kind: "memory" }],
    ["search", { query: "memory", kind: "memory" }],
  ] as const) {
    expect(await rig.call(tool, args)).toMatchObject({ isError: true, payload: { error: "schema_validation" } });
  }
  expect((await rig.ok("list_docs")).docs).toEqual([]);
});

it("reads and edits an existing memory as a regular page without losing its metadata", async () => {
  rig = await startServer();
  const uuid = randomUUID();
  const replica = rig.instance.replicas.replica(uuid);
  replica.doc.transact(() => {
    initDoc(replica.doc, { uuid, title: "Memory", description: "A scoped agent note." });
    setKind(replica.doc, "memory");
    setMemoryAgent(replica.doc, "implementer");
    setMemoryRepository(replica.doc, "uberblick-ai/uberblick-2");
  });
  expect(await rig.ok("get_doc", { uuid })).toMatchObject({
    uuid, kind: "memory", agent: "implementer", repository: "uberblick-ai/uberblick-2", blocks: [],
  });
  expect((await rig.ok("list_docs")).docs).toEqual([
    expect.objectContaining({ uuid, title: "Memory", pinned: false }),
  ]);
  expect((await rig.ok("list_docs")).docs[0]).not.toHaveProperty("kind");
  await rig.ok("set_metadata", { uuid, title: "Updated memory" });
  const inserted = await rig.ok("insert_block", { uuid, after_block_id: null, blocks: [{ type: "paragraph", text: "Keep this note." }] });
  expect(inserted.applied).toBe(true);
  expect(getMeta(replica.doc)).toMatchObject({
    kind: "memory", agent: "implementer", repository: "uberblick-ai/uberblick-2", title: "Updated memory",
  });
  expect(await rig.call("set_status", { uuid, status: "open" })).toMatchObject({
    isError: true, payload: { error: "invalid_document_lifecycle" },
  });
  expect((await rig.ok("get_doc", { uuid })).blocks).toEqual([
    expect.objectContaining({ type: "paragraph", text: "Keep this note." }),
  ]);
});
