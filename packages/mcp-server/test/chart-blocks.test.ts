/** Existing content tools author chart mappings while retaining ordinary locks and indexing. */
import { afterAll, afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { removeTempDirs, startServer } from "./helpers.js";
import type { Rig } from "./helpers.js";

const rigs: Rig[] = [];
const lineMapping = JSON.stringify({
  version: 1, type: "line", collection: "observations",
  x: { field: "day", type: "date" },
  y: [{ field: "count", label: "quartzchartmapping", unit: "issues" }],
});
const tableMapping = JSON.stringify({
  version: 1, type: "table", collection: "observations",
  columns: [
    { field: "day", format: "date" },
    { field: "count", label: "quartzchartmapping", format: "number", unit: "issues", decimals: 0 },
  ],
  sort: { field: "day", direction: "desc" }, pageSize: 25,
});

async function local(): Promise<Rig> {
  const rig = await startServer();
  rigs.push(rig);
  return rig;
}

afterEach(async () => {
  for (const rig of rigs.splice(0)) await rig.close();
});
afterAll(removeTempDirs);

describe.each([
  { type: "line", mapping: lineMapping },
  { type: "table", mapping: tableMapping },
])("$type mappings through MCP", ({ mapping }) => {
  it("creates, inserts, reads and edits source without copying or changing data", async () => {
    const rig = await local();
    const created = await rig.ok("create_doc", {
      title: "Live trend", description: "Chart source beside structured observations.",
      blocks: [{ type: "chart", text: mapping }],
    });
    const { uuid } = created;
    expect(created.blocks[0]).toMatchObject({ type: "chart", text: mapping });
    await rig.ok("update_data", { uuid, operations: [{
      collection: "observations", schema: { version: 1, schema: { type: "object" } },
      upsert: [{ id: "row-a", value: { day: "2026-10-08", count: 7, secret: "DATA_SENTINEL" } }],
    }] });
    const doc = rig.instance.replicas.replica(uuid).doc;
    const data = JSON.stringify(doc.getMap("data").toJSON());
    const read = await rig.ok("get_doc", { uuid });
    expect(read.blocks[0]).toMatchObject({ type: "chart", text: mapping });
    expect(JSON.stringify(read)).not.toContain("DATA_SENTINEL");
    expect((await rig.ok("search", { query: "quartzchartmapping" })).hits).toMatchObject([{ uuid }]);
    const inserted = await rig.ok("insert_block", { uuid, type: "chart", text: "{ incomplete" });
    const next = mapping.replace("quartzchartmapping", "amethystchartmapping");
    const edited = await rig.ok("edit_block", {
      uuid, block_id: read.blocks[0].id, old_text: mapping, new_text: next, rev: read.blocks[0].rev,
    });
    expect(edited.block).toMatchObject({ type: "chart", text: next });
    const current = await rig.ok("get_doc", { uuid });
    expect(current.blocks).toMatchObject([
      { id: inserted.block.id, type: "chart", text: "{ incomplete" },
      { id: edited.block.id, type: "chart", text: next },
    ]);
    expect((await rig.ok("search", { query: "amethystchartmapping" })).hits).toMatchObject([{ uuid }]);
    const exported = (await rig.ok("export_markdown", { uuid })).markdown;
    expect(exported).toContain(`\`\`\`chart\n${next}\n\`\`\``);
    expect(exported).toContain("Structured document data is omitted");
    expect(exported).not.toContain("DATA_SENTINEL");
    expect(JSON.stringify(doc.getMap("data").toJSON())).toBe(data);
  });

  it.each(["archived", "decided"] as const)("keeps %s chart mappings readable and refuses content writes", async (state) => {
    const rig = await local();
    const created = await rig.ok("create_doc", {
      title: "Locked trend", description: "A read-only chart mapping.",
      ...(state === "decided" ? { kind: "decision", status: "decided" } : {}),
      blocks: [{ type: "chart", text: mapping }],
    });
    const { uuid } = created;
    if (state === "archived") await rig.ok("archive_doc", { uuid });
    const read = await rig.ok("get_doc", { uuid });
    expect(read.blocks[0]).toMatchObject({ type: "chart", text: mapping });
    const doc = rig.instance.replicas.replica(uuid).doc;
    const before = Y.encodeStateAsUpdate(doc);
    for (const [name, fields] of [
      ["edit_block", { block_id: read.blocks[0].id, old_text: mapping, new_text: "{}", rev: read.blocks[0].rev }],
      ["insert_block", { type: "chart", text: mapping }],
      ["delete_block", { block_id: read.blocks[0].id }],
    ] as const) {
      expect(await rig.call(name, { uuid, ...fields })).toMatchObject({ isError: true, payload: {
        error: state === "archived" ? "doc_archived" : "decision_read_only",
        applied: false, partial: false, synced: false,
      } });
      expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    }
    expect((await rig.ok("export_markdown", { uuid })).markdown).toContain(`\`\`\`chart\n${mapping}\n\`\`\``);
  });
});
