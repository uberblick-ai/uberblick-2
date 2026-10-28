import { afterAll, afterEach, describe, expect, it } from "vitest";
import { removeTempDirs, startServer } from "./core-helpers.js";
import type { Rig } from "./core-helpers.js";

const rigs: Rig[] = [];

async function local(): Promise<Rig> {
  const rig = await startServer();
  rigs.push(rig);
  return rig;
}

afterEach(async () => {
  for (const rig of rigs.splice(0)) await rig.close();
});
afterAll(removeTempDirs);

describe("inline formatting on reads", () => {
  it("returns a formatted prose block's runs in the shape insert_block takes, and nothing for plain prose", async () => {
    const rig = await local();
    const target = await rig.ok("create_doc", { title: "Target", description: "A linked page." });
    const runs = [
      { text: "Plain, ", marks: {} },
      { text: "bold", marks: { bold: true } },
      { text: ", ", marks: {} },
      { text: "code", marks: { inlineCode: true } },
      { text: ", ", marks: {} },
      { text: "a site", marks: { link: "https://example.com" } },
      { text: " and ", marks: {} },
      { text: "Target", marks: { docLink: target.uuid, italic: true } },
      { text: ".", marks: {} },
    ];
    const created = await rig.ok("create_doc", {
      title: "Formatted", description: "Formatting read back.",
      blocks: [
        { type: "paragraph", inline: runs },
        { type: "paragraph", text: "Nothing formatted here." },
        { type: "code", language: "ts", text: "const bold = true;" },
      ],
    });
    const read = await rig.ok("get_doc", { uuid: created.uuid });
    const [formatted, plain, code] = read.blocks;
    expect(formatted.text).toBe("Plain, bold, code, a site and Target.");
    expect(formatted.inline).toEqual(runs);
    expect(plain).not.toHaveProperty("inline");
    expect(code).not.toHaveProperty("inline");

    // The runs round-trip: writing them back stores the same formatting.
    const copied = await rig.ok("insert_block", { uuid: created.uuid, blocks: [{ type: "paragraph", inline: formatted.inline }] });
    const reread = await rig.ok("get_doc", { uuid: created.uuid });
    const copy = reread.blocks.find((block: { id: string }) => block.id === copied.blocks[0].id);
    expect(copy.inline).toEqual(runs);
  });
});
