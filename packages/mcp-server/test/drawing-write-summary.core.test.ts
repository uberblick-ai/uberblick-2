import { afterAll, afterEach, describe, expect, it } from "vitest";
import { removeTempDirs, startServer } from "./core-helpers.js";
import type { Rig } from "./core-helpers.js";

const rigs: Rig[] = [];
const FLOW = 'flow v0\ncolumns main\nbox start col=main "Start"\nend done "Done"\n\nstart --> done\n';
const BROKEN_FLOW = 'flow v0\ncolumns a b\nstep x "Start" col=zz\narrow x -> nowhere\n';
const WIREFRAME = 'dialog "Delete draft?"\n  row\n    button "Cancel"\n    button.primary "Delete"\n';
const ASCII_ART = "+-----+\n| box |\n+-----+\n";

async function local(): Promise<Rig> {
  const rig = await startServer();
  rigs.push(rig);
  return rig;
}

afterEach(async () => {
  for (const rig of rigs.splice(0)) await rig.close();
});
afterAll(removeTempDirs);

describe("drawing write summaries", () => {
  it("returns the editor's diagnostics for ablauf and wireframe seeds without refusing them", async () => {
    const rig = await local();
    const created = await rig.ok("create_doc", {
      title: "Drawings", description: "Drawing sources checked on write.",
      blocks: [
        { type: "code", language: "ablauf", text: FLOW },
        { type: "code", language: "ablauf", text: BROKEN_FLOW },
        { type: "code", language: "wireframe", text: WIREFRAME },
        { type: "code", language: "wireframe", text: ASCII_ART },
        { type: "code", language: "ts", text: "const ablauf = 1;" },
      ],
    });
    expect(created.applied).toBe(true);
    const [flow, broken, wireframe, art, ordinary] = created.blocks;
    expect(flow.drawing).toEqual({ status: "clean", diagnostics: [] });
    expect(broken.drawing).toEqual({
      status: "errors",
      diagnostics: [
        { line: 3, severity: "error", message: "unknown line `step`" },
        { line: 4, severity: "error", message: "unknown line `arrow`" },
      ],
    });
    expect(wireframe.drawing).toEqual({ status: "clean", diagnostics: [] });
    expect(art.drawing.status).toBe("warnings");
    expect(art.drawing.diagnostics.map((diagnostic: { line: number }) => diagnostic.line)).toEqual([1, 2, 3]);
    expect(ordinary).toEqual({ id: expect.any(String), rev: expect.any(String) });

    const read = await rig.ok("get_doc", { uuid: created.uuid });
    expect(read.blocks.map((block: { text: string }) => block.text)).toEqual([FLOW, BROKEN_FLOW, WIREFRAME, ASCII_ART, "const ablauf = 1;"]);
    for (const block of read.blocks) expect(block).not.toHaveProperty("drawing");
  });

  it("checks inserted and edited sources, listing at most 20 diagnostics", async () => {
    const rig = await local();
    const { uuid } = await rig.ok("create_doc", { title: "Edited drawing", description: "A drawing fixed in place." });
    const art = Array.from({ length: 25 }, (_, index) => `| row ${index} |`).join("\n");
    const inserted = await rig.ok("insert_block", { uuid, blocks: [{ type: "code", language: "wireframe", text: art }] });
    const block = inserted.blocks[0];
    expect(block.drawing.status).toBe("warnings");
    expect(block.drawing.diagnostics).toHaveLength(20);
    expect(block.drawing.diagnosticCount).toBe(25);

    const edited = await rig.ok("edit_block", { uuid, block_id: block.id, old_text: art, new_text: WIREFRAME, rev: block.rev });
    expect(edited.block).toEqual({ id: block.id, rev: expect.any(String), drawing: { status: "clean", diagnostics: [] } });
  });
});
