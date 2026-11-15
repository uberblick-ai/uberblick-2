import { afterAll, afterEach, describe, expect, it } from "vitest";
import { blockText } from "../src/replica.js";
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
  it.each(["create_doc", "insert_block"])("stores prose web addresses written through %s without interpreting other Markdown", async (tool) => {
    const rig = await local();
    const target = await rig.ok("create_doc", { title: "Target", description: "A linked page." });
    const text = "**bold** <https://angle.example/a> http://plain.example/path(foo)). www.example.com.";
    const protectedRuns = [
      { text: "https://label.example", marks: { link: "https://target.example" } },
      { text: " ", marks: {} },
      { text: "www.reference.example", marks: { docLink: target.uuid } },
      { text: " ", marks: {} },
      { text: "https://code.example", marks: { inlineCode: true } },
    ];
    const blocks = [
      { type: "paragraph", text },
      { type: "heading", level: 2, inline: [{ text: "Visit www.heading.example.", marks: { bold: true } }] },
      { type: "list-item", text: "http://list.example" },
      { type: "quote", text: "https://quote.example" },
      { type: "callout", inline: protectedRuns },
      ...["code", "terminal", "chart"].map(type => ({ type, text })),
    ];
    const created = await rig.ok("create_doc", {
      title: "Automatic links", description: "Bare addresses use ordinary external link marks.",
      ...(tool === "create_doc" ? { blocks } : {}),
    });
    if (tool === "insert_block") await rig.ok("insert_block", { uuid: created.uuid, blocks });
    const read = await rig.ok("get_doc", { uuid: created.uuid });
    expect(read.blocks[0].text).toBe(text);
    expect(read.blocks[0].inline).toEqual([
      { text: "**bold** <", marks: {} },
      { text: "https://angle.example/a", marks: { link: "https://angle.example/a" } },
      { text: "> ", marks: {} },
      { text: "http://plain.example/path(foo)", marks: { link: "http://plain.example/path(foo)" } },
      { text: "). ", marks: {} },
      { text: "www.example.com", marks: { link: "https://www.example.com" } },
      { text: ".", marks: {} },
    ]);
    expect(read.blocks[1].inline).toEqual([
      { text: "Visit ", marks: { bold: true } },
      { text: "www.heading.example", marks: { bold: true, link: "https://www.heading.example" } },
      { text: ".", marks: { bold: true } },
    ]);
    expect(read.blocks[2].inline).toEqual([{ text: "http://list.example", marks: { link: "http://list.example" } }]);
    expect(read.blocks[3].inline).toEqual([{ text: "https://quote.example", marks: { link: "https://quote.example" } }]);
    expect(read.blocks[4].inline).toEqual(protectedRuns);
    for (const source of read.blocks.slice(5)) {
      expect(source.text).toBe(text);
      expect(source).not.toHaveProperty("inline");
    }
  });

  it("links newly edited prose while leaving untouched plain addresses and existing link targets alone", async () => {
    const rig = await local();
    const created = await rig.ok("create_doc", {
      title: "Edited addresses", description: "An edit only links newly written addresses.",
      blocks: [
        { type: "paragraph", text: "Keep https://old.example and TOKEN." },
        { type: "paragraph", inline: [{ text: "https://label.example", marks: { link: "https://target.example" } }] },
      ],
    });
    // A legacy or undone address remains plain until that address is written again.
    const plain = blockText(rig.instance.replicas.replica(created.uuid).doc, created.blocks[0].id)!;
    plain.format(0, plain.length, { link: null });
    let read = await rig.ok("get_doc", { uuid: created.uuid });
    expect(read.blocks[0]).not.toHaveProperty("inline");
    await rig.ok("edit_block", {
      uuid: created.uuid, block_id: read.blocks[0].id, old_text: read.blocks[0].text,
      new_text: "Keep https://old.example and www.new.example.", rev: read.blocks[0].rev,
    });
    await rig.ok("edit_block", {
      uuid: created.uuid, block_id: read.blocks[1].id, old_text: read.blocks[1].text,
      new_text: "https://other.example", rev: read.blocks[1].rev,
    });
    read = await rig.ok("get_doc", { uuid: created.uuid });
    expect(read.blocks[0].text).toBe("Keep https://old.example and www.new.example.");
    expect(read.blocks[0].inline).toEqual([
      { text: "Keep https://old.example and ", marks: {} },
      { text: "www.new.example", marks: { link: "https://www.new.example" } },
      { text: ".", marks: {} },
    ]);
    expect(read.blocks[1].inline).toEqual([{ text: "https://other.example", marks: { link: "https://target.example" } }]);
    const unchanged = read.blocks[0];
    await rig.ok("edit_block", {
      uuid: created.uuid, block_id: unchanged.id, old_text: unchanged.text,
      new_text: unchanged.text, rev: unchanged.rev,
    });
    expect((await rig.ok("get_doc", { uuid: created.uuid })).blocks[0]).toEqual(unchanged);
  });

  it("stores automatic links in MCP Markdown containers while keeping card button labels plain", async () => {
    const rig = await local();
    const created = await rig.ok("create_doc", {
      title: "Container links", description: "MCP's Markdown readers store links in prose parts.",
      blocks: [
        { type: "table", text: "| Link |\n| --- |\n| www.table.example |" },
        { type: "card", text: "title: https://title.example\nbutton: [www.button.example](https://button.example)\n\nhttps://body.example" },
        { type: "figma", text: "url: https://www.figma.com/design/key/Example\n\n<https://caption.example>" },
      ],
    });
    const read = await rig.ok("get_doc", { uuid: created.uuid });
    expect(read.blocks[0].text).toContain("[www.table.example](https://www.table.example)");
    expect(read.blocks[1].text).toContain("title: [https://title.example](https://title.example)");
    expect(read.blocks[1].text).toContain("button: [www.button.example](https://button.example)");
    expect(read.blocks[1].text).toContain("[https://body.example](https://body.example)");
    expect(read.blocks[2].text).toContain("[https://caption.example](https://caption.example)");
  });

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
