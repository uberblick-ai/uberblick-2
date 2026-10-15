import { randomUUID } from "node:crypto";
import { cardPartTexts, createAnnotation, decisionApprovalFingerprint, findBlockElement, getBlocksWithInline, getMetaMap, setKind, setStatus } from "@uberblick/schema";
import type { CardPart } from "@uberblick/schema";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { docFingerprint } from "../src/remote.js";
import { removeTempDirs, startServer } from "./core-helpers.js";
import type { Rig } from "./core-helpers.js";

const rigs: Rig[] = [];
const PARTS: readonly CardPart[] = ["label", "title", "body", "footer"];
const SOURCE = "label: Review\ntitle: Keep the title\nfooter: Evidence\n\nKeep the body.";

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

function sourceWithPart(part: CardPart, value: string): string {
  return `label: ${part === "label" ? value : "Review"}\ntitle: ${part === "title" ? value : "Keep the title"}\nfooter: ${part === "footer" ? value : "Evidence"}\n\n${part === "body" ? value : "Keep the body."}`;
}

describe("cards through MCP", () => {

  it.each([
    { source: "title: Card title\n\nCard body", part: "body" },
    { source: "title: Card title\n\n", part: "title" },
  ] as const)("places the agent caret in $part when later optional parts are empty", async ({ source, part }) => {
    const rig = await localRig();
    const created = await rig.ok("create_doc", { title: "Card caret", description: "The agent caret stays in a visible part." });
    const inserted = await rig.ok("insert_block", { uuid: created.uuid, type: "card", text: source });
    const replica = rig.instance.replicas.replica(created.uuid);
    const cursor = replica.awareness.getLocalState()!.cursor;
    const position = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(cursor.head), replica.doc);
    const text = partText(replica.doc, inserted.block.id, part);
    expect(position?.type).toBe(text);
    expect(position?.index).toBe(text.length);
  });

  it.each([
    "https://example.com/recommendation?prompt=Review%20this%20change",
    "claude://code/new",
    "claude://code/new?q=Review%20this%20change&folder=%2Fexample%2Fproject",
    "claude-cli://open",
    "claude-cli://open?q=Review%20this%20change&repo=example%2Fproject",
    "codex://new",
    "codex://new?prompt=Review%20this%20change&path=%2Fexample%2Fproject",
  ])("round-trips one button with its author text and preserves it during prose edits: %s", async (href) => {
    const rig = await localRig();
    const button = `button: [Discuss this recommendation](${href})`;
    const source = `${button}\nfooter: Evidence\ntitle: Keep the title\nlabel: Review\n\nKeep the body.`;
    const canonical = `label: Review\ntitle: Keep the title\nfooter: Evidence\n${button}\n\nKeep the body.`;
    const created = await rig.ok("create_doc", { title: "Card button", description: "A single author-named card action.",
      blocks: [{ type: "card", text: source }] });
    const inserted = await rig.ok("insert_block", { uuid: created.uuid, type: "card", text: source });
    expect(created.blocks[0].text).toBe(canonical);
    expect(inserted.block.text).toBe(canonical);
    const read = await rig.ok("get_doc", { uuid: created.uuid });
    expect(read.blocks.map((block: { text: string }) => block.text)).toEqual([canonical, canonical]);
    expect((await rig.ok("export_markdown", { uuid: created.uuid, frontmatter: false })).markdown)
      .toBe(`:::card\n${canonical}\n:::\n\n:::card\n${canonical}\n:::\n`);
    const changed = canonical.replace("Keep the body.", "Changed body.");
    const edited = await rig.ok("edit_block", { uuid: created.uuid, block_id: inserted.block.id,
      old_text: canonical, new_text: changed, rev: inserted.block.rev });
    expect(edited.block.text).toBe(changed);
    const noButton = changed.replace(`${button}\n`, "");
    const removed = await rig.ok("edit_block", { uuid: created.uuid, block_id: inserted.block.id,
      old_text: changed, new_text: noButton, rev: edited.block.rev });
    expect(removed.block.text).toBe(noButton);
  });

  it("round-trips all button appearances in authored order after footer", async () => {
    const rig = await localRig();
    const appearances = [
      { input: "outline neutral", canonical: "" },
      { input: "neutral filled", canonical: " filled" },
      { input: "blue outline", canonical: " blue" },
      { input: "filled blue", canonical: " filled blue" },
      { input: "outline green", canonical: " green" },
      { input: "green filled", canonical: " filled green" },
      { input: "violet outline", canonical: " violet" },
      { input: "filled violet", canonical: " filled violet" },
    ];
    const destinations = ["codex://new?prompt=Review", "claude://code/new?q=Review", "claude-cli://open?q=Review", "https://example.com/details"];
    const buttons = appearances.map(({ input }, index) =>
      `button: [Action ${index}](${destinations[index % destinations.length]}) ${input}`);
    const canonicalButtons = appearances.map(({ canonical }, index) =>
      `button: [Action ${index}](${destinations[index % destinations.length]})${canonical}`);
    const source = `${buttons.slice(0, 4).join("\n")}\nfooter: Evidence\ntitle: Keep the title\n${buttons.slice(4).join("\n")}\nlabel: Review\n\nKeep the body.`;
    const canonical = SOURCE.replace("footer: Evidence\n", `footer: Evidence\n${canonicalButtons.join("\n")}\n`);
    const created = await rig.ok("create_doc", { title: "Several card actions", description: "Buttons keep order and appearance through canonical reads." });
    const inserted = await rig.ok("insert_block", { uuid: created.uuid, type: "card", text: source });
    expect(inserted.block.text).toBe(canonical);
    expect((await rig.ok("get_doc", { uuid: created.uuid })).blocks[0]).toEqual(inserted.block);
    expect((await rig.ok("export_markdown", { uuid: created.uuid, frontmatter: false })).markdown)
      .toBe(`:::card\n${canonical}\n:::\n`);
    const proseEdit = canonical.replace("Keep the body.", "Changed body.");
    const edited = await rig.ok("edit_block", { uuid: created.uuid, block_id: inserted.block.id,
      old_text: canonical, new_text: proseEdit, rev: inserted.block.rev });
    expect(edited.block.text).toBe(proseEdit);
    const buttonEdit = proseEdit.replace("button: [Action 3](https://example.com/details) filled blue",
      "button: [View details](https://example.com/updated) violet filled");
    const expected = buttonEdit.replace(" violet filled", " filled violet");
    const changed = await rig.ok("edit_block", { uuid: created.uuid, block_id: inserted.block.id,
      old_text: proseEdit, new_text: buttonEdit, rev: edited.block.rev });
    expect(changed.block.text).toBe(expected);
    expect((await rig.ok("export_markdown", { uuid: created.uuid, frontmatter: false })).markdown)
      .toBe(`:::card\n${expected}\n:::\n`);
  });

  it("changes rev for each button field and position while preserving the other button", async () => {
    const rig = await localRig();
    const first = "button: [Open](codex://new) filled blue";
    const second = "button: [Details](https://example.com/details) green";
    const initial = SOURCE.replace("footer: Evidence\n", `footer: Evidence\n${first}\n${second}\n`);
    const created = await rig.ok("create_doc", { title: "Card action assertions", description: "Every button field and order participates in rev.",
      blocks: [{ type: "card", text: initial }] });
    let current = created.blocks[0];
    const changes = [
      initial.replace("[Open]", "[Open in Codex]"),
      initial.replace("[Open]", "[Open in Codex]").replace("codex://new)", "codex://new?prompt=Review)"),
      initial.replace("[Open]", "[Open in Codex]").replace("codex://new)", "codex://new?prompt=Review)").replace(" filled blue", " blue"),
      initial.replace("[Open]", "[Open in Codex]").replace("codex://new)", "codex://new?prompt=Review)").replace(" filled blue", " violet"),
    ];
    for (const newText of changes) {
      const changed = await rig.ok("edit_block", { uuid: created.uuid, block_id: current.id,
        old_text: current.text, new_text: newText, rev: current.rev });
      expect(changed.block.rev).not.toBe(current.rev);
      expect(changed.block.text).toBe(newText);
      expect(changed.block.text).toContain(second);
      current = changed.block;
    }
    const changedFirst = "button: [Open in Codex](codex://new?prompt=Review) violet";
    const reordered = current.text.replace(`${changedFirst}\n${second}`, `${second}\n${changedFirst}`);
    const moved = await rig.ok("edit_block", { uuid: created.uuid, block_id: current.id,
      old_text: current.text, new_text: reordered, rev: current.rev });
    expect(moved.block.rev).not.toBe(current.rev);
    expect(moved.block.text).toBe(reordered);
    const removed = await rig.ok("edit_block", { uuid: created.uuid, block_id: current.id,
      old_text: moved.block.text, new_text: reordered.replace(`${changedFirst}\n`, ""), rev: moved.block.rev });
    expect(removed.block.text).toBe(SOURCE.replace("footer: Evidence\n", `footer: Evidence\n${second}\n`));
  });

  it("refuses malformed or disallowed buttons before any create, insert or edit write", async () => {
    const rig = await localRig();
    const source = SOURCE.replace("footer: Evidence\n",
      "footer: Evidence\nbutton: [Existing](https://example.com/existing) filled violet\nbutton: [Other](codex://new) blue\n");
    const created = await rig.ok("create_doc", { title: "Card button refusals", description: "Invalid card actions cannot make a partial write.",
      blocks: [{ type: "card", text: source }] });
    const doc = rig.instance.replicas.replica(created.uuid).doc;
    const before = Y.encodeStateAsUpdate(doc);
    const writes = rig.instance.store.logSize();
    const listed = await rig.ok("list_docs");
    const invalidButtons = [
      "[Discuss](http://example.com)", "[Discuss](javascript:alert%281%29)",
      "[Discuss](data:text/plain,hello)", "[Discuss](file:///example)",
      "[Discuss](vbscript:example)", "[Discuss](mailto:reader@example.com)",
      "[Discuss](/relative)", "[Discuss](codex://settings)",
      "[Discuss](codex://new/other)", "[Discuss](codex://new#fragment)",
      "[Discuss](claude://code/other)", "[Discuss](claude-cli://other)",
      "[](https://example.com)", "[   ](https://example.com)",
      "[**Discuss**](https://example.com)", "Discuss",
      "[Discuss](https://example.com) trailing", "[Discuss](https://example.com) [Again](https://example.com)",
      "[Discuss](https://example.com) outline filled", "[Discuss](https://example.com) filled filled",
      "[Discuss](https://example.com) blue green", "[Discuss](https://example.com) violet violet",
      "[Discuss](https://example.com) red", "[Discuss](https://example.com) FILLED",
      "[Discuss](https://example.com) filled blue trailing", "[Discuss](https://example.com) blue filled neutral",
    ];
    for (const button of invalidButtons) {
      const invalid = `title: Keep the title\nbutton: [Valid first](codex://new) filled blue\nbutton: ${button}\nbutton: [Valid last](https://example.com) green\n\nKeep the body.`;
      for (const [name, args] of [
        ["create_doc", { title: "No partial button", description: "All seeds validate before creation.",
          blocks: [{ type: "paragraph", text: "Earlier seed" }, { type: "card", text: invalid }] }],
        ["insert_block", { uuid: created.uuid, type: "card", text: invalid }],
        ["edit_block", { uuid: created.uuid, block_id: created.blocks[0].id, old_text: source,
          new_text: invalid, rev: created.blocks[0].rev }],
      ] as const) {
        const refused = await rig.call(name, args);
        expect(refused, `${name}: ${button}`).toMatchObject({ isError: true, payload: {
          error: "invalid_card", recoveryClass: "manual", applied: false, partial: false, synced: false,
        } });
        expect(refused.payload.recovery).toContain("button");
      }
    }
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    expect(rig.instance.store.logSize()).toBe(writes);
    expect(await rig.ok("list_docs")).toEqual(listed);
  });

  it("adds and changes a button through an edit without changing its prose parts", async () => {
    const rig = await localRig();
    const created = await rig.ok("create_doc", { title: "Card button editing", description: "MCP can replace a card action independently.",
      blocks: [{ type: "card", text: SOURCE }] });
    const withButton = SOURCE.replace("footer: Evidence\n", "footer: Evidence\nbutton: [Review in Claude](claude://code/new?q=Review)\n");
    const added = await rig.ok("edit_block", { uuid: created.uuid, block_id: created.blocks[0].id,
      old_text: SOURCE, new_text: withButton, rev: created.blocks[0].rev });
    expect(added.block.text).toBe(withButton);
    const changedButton = withButton.replace("[Review in Claude](claude://code/new?q=Review)",
      "[Discuss in Codex](codex://new?prompt=Discuss%20the%20recommendation)");
    const changed = await rig.ok("edit_block", { uuid: created.uuid, block_id: created.blocks[0].id,
      old_text: withButton, new_text: changedButton, rev: added.block.rev });
    expect(changed.block.text).toBe(changedButton);
    const doc = rig.instance.replicas.replica(created.uuid).doc;
    const expectedParts = { label: "Review", title: "Keep the title", footer: "Evidence", body: "Keep the body." };
    for (const part of PARTS) {
      expect(partRuns(doc, created.blocks[0].id, part)).toEqual([{ text: expectedParts[part], marks: {} }]);
    }
  });

  it.each([
    "label: Missing title\n\nBody",
    "title: \n\nBody",
    "title: Title\nunknown: Value\n\nBody",
    "title: Title\ntitle: Duplicate\n\nBody",
    "title: Title\nlabel: First\nlabel: Duplicate\n\nBody",
    "title: Title\nfooter: First\nfooter: Duplicate\n\nBody",
    "title: Title\nNot a key\n\nBody",
  ])("refuses malformed card content before any create, insert or edit write: %s", async (invalid) => {
    const rig = await localRig();
    const created = await rig.ok("create_doc", { title: "Card refusals", description: "Invalid parts cannot make a partial write.",
      blocks: [{ type: "card", text: SOURCE }] });
    const doc = rig.instance.replicas.replica(created.uuid).doc;
    const listed = await rig.ok("list_docs");
    const before = Y.encodeStateAsUpdate(doc);
    const writes = rig.instance.store.logSize();
    let updates = 0;
    doc.on("update", () => { updates += 1; });
    for (const [name, args] of [
      ["create_doc", { title: "No partial card", description: "All seeds validate before creation.",
        blocks: [{ type: "paragraph", text: "Earlier seed" }, { type: "card", text: invalid }] }],
      ["insert_block", { uuid: created.uuid, type: "card", text: invalid }],
      ["edit_block", { uuid: created.uuid, block_id: created.blocks[0].id, old_text: SOURCE,
        new_text: invalid, rev: created.blocks[0].rev }],
    ] as const) {
      const refused = await rig.call(name, args);
      expect(refused).toMatchObject({ isError: true, payload: { error: "invalid_card", recoveryClass: "manual",
        applied: false, partial: false, synced: false } });
      expect(refused.payload.recovery).toContain("title");
    }
    expect(updates).toBe(0);
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    expect(rig.instance.store.logSize()).toBe(writes);
    expect(await rig.ok("list_docs")).toEqual(listed);
    expect((await rig.ok("get_doc", { uuid: created.uuid })).blocks).toEqual(created.blocks);
  });

  it("keeps stale assertions ahead of malformed content and makes formatting part of rev", async () => {
    const rig = await localRig();
    const created = await rig.ok("create_doc", { title: "Card revisions", description: "Formatting is part of the edit assertion.",
      blocks: [{ type: "card", text: SOURCE }] });
    const doc = rig.instance.replicas.replica(created.uuid).doc;
    partText(doc, created.blocks[0].id, "title").format(0, 4, { bold: {} });
    const read = (await rig.ok("get_doc", { uuid: created.uuid })).blocks[0];
    expect(read.rev).not.toBe(created.blocks[0].rev);
    expect(read.text).toContain("title: **Keep** the title");
    const before = Y.encodeStateAsUpdate(doc);
    const stale = await rig.call("edit_block", { uuid: created.uuid, block_id: read.id,
      old_text: read.text, new_text: "missing title", rev: created.blocks[0].rev });
    expect(stale.payload).toMatchObject({ error: "stale_block", applied: false });
    const mismatch = await rig.call("edit_block", { uuid: created.uuid, block_id: read.id,
      old_text: SOURCE, new_text: "missing title", rev: read.rev });
    expect(mismatch.payload).toMatchObject({ error: "old_text_mismatch", applied: false });
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    const edited = await rig.ok("edit_block", { uuid: created.uuid, block_id: read.id,
      old_text: read.text, new_text: read.text.replace("**Keep**", "*Keep*"), rev: read.rev });
    expect(edited.block.rev).not.toBe(read.rev);
    expect(partRuns(doc, read.id, "title")[0]).toEqual({ text: "Keep", marks: { italic: true } });
  });

  it("requires a title repair when the editor emptied a stored title", async () => {
    const rig = await localRig();
    const created = await rig.ok("create_doc", { title: "Empty editor title", description: "MCP repairs a card that remains editable in the browser.",
      blocks: [{ type: "card", text: SOURCE }] });
    const doc = rig.instance.replicas.replica(created.uuid).doc;
    const id = created.blocks[0].id;
    for (const part of ["title", "footer"] as const) {
      const text = partText(doc, id, part);
      text.delete(0, text.length);
    }
    const read = (await rig.ok("get_doc", { uuid: created.uuid })).blocks[0];
    expect(read.text).toBe("label: Review\n\nKeep the body.");
    const before = Y.encodeStateAsUpdate(doc);
    const writes = rig.instance.store.logSize();
    const invalid = await rig.call("edit_block", { uuid: created.uuid, block_id: id,
      old_text: read.text, new_text: read.text, rev: read.rev });
    expect(invalid).toMatchObject({ isError: true, payload: { error: "invalid_card", applied: false, partial: false } });
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    expect(rig.instance.store.logSize()).toBe(writes);
    const repaired = await rig.ok("edit_block", { uuid: created.uuid, block_id: id,
      old_text: read.text, new_text: "label: Review\ntitle: Repaired title\n\nKeep the body.", rev: read.rev });
    expect(repaired.block.text).toBe("label: Review\ntitle: Repaired title\n\nKeep the body.");
    expect(partText(doc, id, "title").toString()).toBe("Repaired title");
    expect(partText(doc, id, "footer").toString()).toBe("");
  });

  it("indexes document links independently from all four parts", async () => {
    const rig = await localRig();
    const targets: Record<string, string> = {};
    for (const part of PARTS) targets[part] = (await rig.ok("create_doc", {
      title: `Target ${part}`, description: "A card part link target.",
    })).uuid;
    const source = `label: [Label](${targets.label})\ntitle: [Title](${targets.title})\nfooter: [Footer](${targets.footer})\n\n[Body](${targets.body})`;
    const created = await rig.ok("create_doc", { title: "Card outgoing links", description: "Each part contributes its links.",
      blocks: [{ type: "card", text: source }] });
    for (const part of PARTS) {
      expect((await rig.ok("backlinks", { uuid: targets[part] })).backlinks.map((row: { uuid: string }) => row.uuid))
        .toEqual([created.uuid]);
    }
    await rig.ok("edit_block", { uuid: created.uuid, block_id: created.blocks[0].id,
      old_text: source, new_text: source.replace(`[Label](${targets.label})`, "Label"), rev: created.blocks[0].rev });
    expect((await rig.ok("backlinks", { uuid: targets.label })).backlinks).toEqual([]);
    for (const part of ["title", "body", "footer"] as const) {
      expect((await rig.ok("backlinks", { uuid: targets[part] })).backlinks.map((row: { uuid: string }) => row.uuid))
        .toEqual([created.uuid]);
    }
  });

  it.each(PARTS)("refuses a newly unknown document link in %s before any write", async (part) => {
    const rig = await localRig();
    const created = await rig.ok("create_doc", { title: "Card target validation", description: "Every card part validates new links.",
      blocks: [{ type: "card", text: SOURCE }] });
    const doc = rig.instance.replicas.replica(created.uuid).doc;
    const invalid = sourceWithPart(part, `[Unknown](${randomUUID()})`);
    const listed = await rig.ok("list_docs");
    const before = Y.encodeStateAsUpdate(doc);
    const writes = rig.instance.store.logSize();
    for (const [name, args] of [
      ["create_doc", { title: "No partial link", description: "Validate all seed card parts first.",
        blocks: [{ type: "paragraph", text: "Earlier seed" }, { type: "card", text: invalid }] }],
      ["insert_block", { uuid: created.uuid, type: "card", text: invalid }],
      ["edit_block", { uuid: created.uuid, block_id: created.blocks[0].id,
        old_text: SOURCE, new_text: invalid, rev: created.blocks[0].rev }],
    ] as const) {
      expect(await rig.call(name, args)).toMatchObject({ isError: true, payload: {
        error: "doclink_target_not_known_locally", applied: false, partial: false,
      } });
    }
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    expect(rig.instance.store.logSize()).toBe(writes);
    expect(await rig.ok("list_docs")).toEqual(listed);
  });

  it("preserves unchanged parts and comment anchors across prose and formatting edits", async () => {
    const rig = await localRig();
    const source = "label: *Review*\ntitle: **Keep** the title\nfooter: ~~Evidence~~\n\nKeep the body.";
    const created = await rig.ok("create_doc", { title: "Card comment anchors", description: "Part edits keep the characters they do not change.",
      blocks: [{ type: "card", text: source }] });
    const doc = rig.instance.replicas.replica(created.uuid).doc;
    const id = created.blocks[0].id;
    const original = Object.fromEntries(PARTS.map(part => [part, partText(doc, id, part)]));
    const threads = Object.fromEntries(PARTS.map(part => [part,
      createAnnotation(doc, id, 0, 4, "Reader", `Discuss ${part}`, { part }).id,
    ]));
    const before = await rig.ok("get_doc", { uuid: created.uuid });
    for (const part of PARTS) {
      expect(before.annotations.find((entry: { id: string }) => entry.id === threads[part]).range)
        .toEqual({ part, start: 0, end: 4, collapsed: false });
    }
    const changed = before.blocks[0].text.replace("the body.", "the new body.").replace("**Keep**", "*Keep*");
    await rig.ok("edit_block", { uuid: created.uuid, block_id: id,
      old_text: before.blocks[0].text, new_text: changed, rev: before.blocks[0].rev });
    const after = await rig.ok("get_doc", { uuid: created.uuid });
    for (const part of PARTS) {
      expect(partText(doc, id, part)).toBe(original[part]);
      expect(after.annotations.find((entry: { id: string }) => entry.id === threads[part]).range)
        .toEqual({ part, start: 0, end: 4, collapsed: false });
    }
    expect(partRuns(doc, id, "label")).toEqual([{ text: "Review", marks: { italic: true } }]);
    expect(partRuns(doc, id, "footer")).toEqual([{ text: "Evidence", marks: { strike: true } }]);
    expect(partRuns(doc, id, "title")[0]).toEqual({ text: "Keep", marks: { italic: true } });
    const state = Y.encodeStateAsUpdate(doc);
    const noop = await rig.ok("edit_block", { uuid: created.uuid, block_id: id,
      old_text: after.blocks[0].text, new_text: after.blocks[0].text, rev: after.blocks[0].rev });
    expect(noop.block).toEqual(after.blocks[0]);
    expect(Y.encodeStateAsUpdate(doc)).toEqual(state);
  });

  it("refuses new MCP anchors and link ranges while preserving existing card thread lifecycle", async () => {
    const rig = await localRig();
    const target = await rig.ok("create_doc", { title: "Card range target", description: "A known target for a refused range." });
    const created = await rig.ok("create_doc", { title: "Card thread lifecycle", description: "Web anchors remain agent-readable and replyable.",
      blocks: [{ type: "card", text: SOURCE }] });
    const doc = rig.instance.replicas.replica(created.uuid).doc;
    const id = created.blocks[0].id;
    const thread = createAnnotation(doc, id, 0, 4, "Reader", "Web thread", { part: "body" });
    const read = await rig.ok("get_doc", { uuid: created.uuid });
    const before = Y.encodeStateAsUpdate(doc);
    const writes = rig.instance.store.logSize();
    const annotated = await rig.call("annotate", { uuid: created.uuid, block_id: id, start: 0, end: 4, text: "New thread" });
    expect(annotated).toMatchObject({ isError: true, payload: { error: "annotation_card", recoveryClass: "manual",
      applied: false, partial: false, synced: false } });
    expect(annotated.payload.recovery).toContain("web editor");
    const linked = await rig.call("link_range", { uuid: created.uuid, block_id: id,
      start: 0, end: 4, doc_id: target.uuid, rev: read.blocks[0].rev });
    expect(linked).toMatchObject({ isError: true, payload: { error: "inline_link_range", applied: false, partial: false } });
    expect(linked.payload.recovery).toEqual(expect.any(String));
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    expect(rig.instance.store.logSize()).toBe(writes);
    for (const resolved of [true, false]) {
      const reply = await rig.ok("annotate", { uuid: created.uuid, thread_id: thread.id, resolved, text: "Reply" });
      expect(reply.annotation).toMatchObject({ resolved, range: { part: "body", start: 0, end: 4, collapsed: false } });
    }
    const after = await rig.ok("get_doc", { uuid: created.uuid });
    expect(after.blocks).toEqual(read.blocks);
    expect(after.annotations[0].comments).toHaveLength(3);
  });

  it("keeps formatting-only legacy card changes outside a decision's approved content", async () => {
    const rig = await localRig();
    const created = await rig.ok("create_doc", { title: "Approved card", description: "Card approval projects plain part content.",
      blocks: [{ type: "card", text: SOURCE }] });
    const doc = rig.instance.replicas.replica(created.uuid).doc;
    doc.transact(() => {
      setKind(doc, "decision");
      setStatus(doc, "decided");
      getMetaMap(doc).set("approvalFingerprint", decisionApprovalFingerprint(doc));
    });
    const approved = getMetaMap(doc).get("approvalFingerprint");
    for (const part of PARTS) {
      const text = partText(doc, created.blocks[0].id, part);
      text.format(0, text.length, { bold: {} });
    }
    const read = await rig.ok("get_doc", { uuid: created.uuid });
    expect(read.blocks[0].rev).not.toBe(created.blocks[0].rev);
    expect(read.approvalChanged).toBe(false);
    expect(getMetaMap(doc).get("approvalFingerprint")).toBe(approved);
    partText(doc, created.blocks[0].id, "body").insert(0, "Changed ");
    expect((await rig.ok("get_doc", { uuid: created.uuid })).approvalChanged).toBe(true);
  });

  it("detects anchor-only card divergence during content verification", async () => {
    const rig = await localRig();
    const created = await rig.ok("create_doc", { title: "Card replication", description: "A surviving thread record does not prove its anchor arrived.",
      blocks: [{ type: "card", text: SOURCE }] });
    const doc = rig.instance.replicas.replica(created.uuid).doc;
    const id = created.blocks[0].id;
    const thread = createAnnotation(doc, id, 0, 4, "Reader", "Anchored card thread", { part: "footer" });
    const before = await rig.ok("get_doc", { uuid: created.uuid });
    const copy = new Y.Doc();
    try {
      Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc));
      expect(docFingerprint(copy)).toBe(docFingerprint(doc));
      partText(doc, id, "footer").format(0, 4, { comment: null });
      const after = await rig.ok("get_doc", { uuid: created.uuid });
      expect(after.blocks).toEqual(before.blocks);
      expect(after.annotations[0]).toMatchObject({ id: thread.id, comments: before.annotations[0].comments, range: null });
      expect(docFingerprint(copy)).not.toBe(docFingerprint(doc));
      Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc));
      expect(docFingerprint(copy)).toBe(docFingerprint(doc));
    } finally {
      copy.destroy();
    }
  });
});
