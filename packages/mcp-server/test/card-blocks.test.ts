
import { cardPartTexts, findBlockElement, getBlocksWithInline } from "@uberblick/schema";
import type { CardPart } from "@uberblick/schema";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";

import { blockText } from "../src/replica.js";
import { readBlocks, removeTempDirs, startServer } from "./helpers.js";
import type { Rig } from "./helpers.js";

const rigs: Rig[] = [];
const PARTS: readonly CardPart[] = ["label", "title", "body", "footer"];

async function localRig(): Promise<Rig> {
  const rig = await startServer();
  rigs.push(rig);
  return rig;
}

afterEach(async () => {
  for (const rig of rigs.splice(0)) await rig.close();
});
afterAll(removeTempDirs);

function partText(doc: Y.Doc, id: string, part: CardPart): Y.XmlText {
  const element = findBlockElement(doc, id);
  const text = element === null ? null : cardPartTexts(element, part)[0] ?? null;
  if (text === null) throw new Error(`no ${part} text`);
  return text;
}

function partRuns(doc: Y.Doc, id: string, part: CardPart) {
  const runs = getBlocksWithInline(doc).find(entry => entry.block.id === id)?.card?.[part];
  if (runs === undefined) throw new Error(`no ${part} runs`);
  return runs;
}

describe("cards through MCP", () => {
  it("creates and inserts canonical prose parts with inline marks and a real caret", async () => {
    const rig = await localRig();
    const target = await rig.ok("create_doc", { title: "Card link target", description: "A known inline document target." });
    const body = `\`code\` **bold** *italic* ~~strike~~ [external](https://example.com/page) [document](${target.uuid})`;
    const unordered = `footer: Footer\ntitle: **Title**\nlabel: "Literal label"\n\n${body}`;
    const canonical = `label: "Literal label"\ntitle: **Title**\nfooter: Footer\n\n${body}`;
    const created = await rig.ok("create_doc", { title: "Cards", description: "Four prose parts with inline marks.",
      blocks: [{ type: "card", text: unordered }] });
    const doc = rig.instance.replicas.replica(created.uuid).doc;
    const [original] = await readBlocks(rig, created.uuid, created.blocks);
    expect(original).toMatchObject({ type: "card", text: canonical });
    expect(partText(doc, original.id, "label").toString()).toBe('"Literal label"');
    expect(partRuns(doc, original.id, "title")).toEqual([{ text: "Title", marks: { bold: true } }]);
    expect(partRuns(doc, original.id, "body")).toEqual([
      { text: "code", marks: { inlineCode: true } }, { text: " ", marks: {} },
      { text: "bold", marks: { bold: true } }, { text: " ", marks: {} },
      { text: "italic", marks: { italic: true } }, { text: " ", marks: {} },
      { text: "strike", marks: { strike: true } }, { text: " ", marks: {} },
      { text: "external", marks: { link: "https://example.com/page" } }, { text: " ", marks: {} },
      { text: "document", marks: { docLink: target.uuid } },
    ]);
    const inserted = await rig.ok("insert_block", { uuid: created.uuid, blocks: [{ type: "card", text: canonical }] });
    expect((await readBlocks(rig, created.uuid, inserted.blocks))[0].text).toBe(canonical);
    for (const part of PARTS) expect(partRuns(doc, inserted.blocks[0].id, part)).toEqual(partRuns(doc, original.id, part));
    const text = blockText(doc, inserted.blocks[0].id);
    expect(text).toBeInstanceOf(Y.XmlText);
    const cursor = rig.instance.replicas.replica(created.uuid).awareness.getLocalState()!.cursor;
    const position = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(cursor.head), doc);
    expect(position?.type).toBe(text);
    expect((await rig.ok("search", { query: "Literal label" })).hits.map((hit: { uuid: string }) => hit.uuid)).toContain(created.uuid);
    expect((await rig.ok("export_markdown", { uuid: created.uuid, frontmatter: false })).markdown)
      .toBe(`:::card\n${canonical}\n:::\n\n:::card\n${canonical}\n:::\n`);
    const help = await rig.ok("get_help", { topic: "markdown" });
    expect(help.text).toContain(":::card");
    const tool = (await rig.client.listTools()).tools.find(tool => tool.name === "insert_block")!;
    expect((tool.inputSchema.properties as Record<string, any>).blocks.items.properties.text.description).toContain(":::card");
  });

});
