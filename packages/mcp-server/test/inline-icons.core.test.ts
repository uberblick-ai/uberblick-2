import { getBlocks, importMarkdown } from "@uberblick/schema";
import { afterAll, afterEach, expect, it } from "vitest";
import { removeTempDirs, startServer } from "./core-helpers.js";
import type { Rig } from "./core-helpers.js";

const rigs: Rig[] = [];
const SOURCE = ":claude: :codex: :github: :future-icon: :rocket: :smiley: 🚀 😃 10:30:15 note:this:";
const SEEDS = [
  { type: "paragraph", text: SOURCE },
  { type: "heading", text: SOURCE, level: 2 },
  { type: "list-item", text: SOURCE, list: "bullet", indent: 0 },
  { type: "quote", text: SOURCE },
  { type: "table", text: `| :claude: |\n| --- |\n| ${SOURCE} |` },
  { type: "card", text: `label: :claude:\ntitle: :codex:\nfooter: :github:\nbutton: [:claude: Discuss with Claude](claude://code/new?prompt=Review)\n\n${SOURCE}` },
  { type: "figma", text: `url: https://www.figma.com/design/key\n\n${SOURCE}` },
] as const;

afterEach(async () => {
  for (const rig of rigs.splice(0)) await rig.close();
});
afterAll(removeTempDirs);

it("preserves icon and emoji names and emoji characters through content writes, storage, reads and Markdown", async () => {
  const rig = await startServer();
  rigs.push(rig);
  const created = await rig.ok("create_doc", {
    title: "Icon source", description: "Inline icons keep their literal source.", blocks: SEEDS,
  });
  for (const [index, seed] of SEEDS.entries()) {
    expect(created.blocks[index]).toMatchObject(seed);
    const inserted = await rig.ok("insert_block", { uuid: created.uuid, blocks: [{ ...seed }] });
    expect(inserted.blocks[0]).toMatchObject(seed);
    const newText = seed.text.replaceAll(":claude:", ":unknown-name:");
    const edited = await rig.ok("edit_block", {
      uuid: created.uuid, block_id: inserted.blocks[0].id, old_text: seed.text,
      new_text: newText, rev: inserted.blocks[0].rev,
      ...(seed.type === "table" ? { table_mapping: { rows: [0, 1], columns: [0] } } : {}),
    });
    expect(edited.block).toMatchObject({ type: seed.type, text: newText });
  }
  const read = await rig.ok("get_doc", { uuid: created.uuid });
  expect(read.blocks).toHaveLength(SEEDS.length * 2);
  const stored = getBlocks(rig.instance.replicas.replica(created.uuid).doc);
  expect(stored.map((block) => block.text)).toEqual(read.blocks.map((block: { text: string }) => block.text));
  for (const seed of SEEDS) {
    expect(read.blocks).toContainEqual(expect.objectContaining(seed));
    expect(read.blocks).toContainEqual(expect.objectContaining({ type: seed.type,
      text: seed.text.replaceAll(":claude:", ":unknown-name:") }));
  }
  expect((await rig.ok("search", { query: "future-icon" })).hits).toMatchObject([{ uuid: created.uuid }]);
  const { markdown } = await rig.ok("export_markdown", { uuid: created.uuid, frontmatter: false });
  expect(markdown).toContain("[:claude: Discuss with Claude](claude://code/new?prompt=Review)");
  expect(markdown).toContain(":unknown-name:");
  expect(markdown).toContain(":rocket: :smiley: 🚀 😃");
  expect(markdown).not.toContain("<svg");
  const imported = importMarkdown(markdown).blocks;
  expect(imported).toHaveLength(SEEDS.length * 2);
  for (const block of read.blocks) {
    expect(imported).toContainEqual(expect.objectContaining({ type: block.type, text: block.text }));
  }
});
