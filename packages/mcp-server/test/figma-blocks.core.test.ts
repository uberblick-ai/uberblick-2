import { randomUUID } from "node:crypto";
import { createAnnotation, figmaCaptionElement, figmaCaptionTexts, findBlockElement, getBlocksWithInline } from "@uberblick/schema";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { docFingerprint } from "../src/remote.js";
import { blockText } from "../src/replica.js";
import { removeTempDirs, startServer } from "./core-helpers.js";
import type { Rig } from "./core-helpers.js";

const rigs: Rig[] = [];
const LINK = "https://www.figma.com/design/k3Lm9QzT2x/Checkout-flow?node-id=12-345";
const SOURCE = `url: ${LINK}\ntitle: Payment, mobile\nheight: 560\n\nKeep the caption.`;

async function localRig(): Promise<Rig> {
  const rig = await startServer();
  rigs.push(rig);
  return rig;
}

afterEach(async () => {
  for (const rig of rigs.splice(0)) await rig.close();
  vi.restoreAllMocks();
});
afterAll(removeTempDirs);

function captionText(doc: Y.Doc, id: string): Y.XmlText {
  const element = findBlockElement(doc, id);
  const text = element === null ? null : figmaCaptionTexts(element)[0] ?? null;
  if (text === null) throw new Error("no caption text");
  return text;
}

function captionRuns(doc: Y.Doc, id: string) {
  const runs = getBlocksWithInline(doc).find(entry => entry.block.id === id)?.figma?.caption;
  if (runs === undefined) throw new Error("no caption runs");
  return runs;
}

describe("Figma blocks through MCP", () => {
  it("creates and inserts canonical content, literal titles and derived fields without contacting Figma", async () => {
    const rig = await localRig();
    const target = await rig.ok("create_doc", { title: "Caption target", description: "A local Figma caption link target." });
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("unexpected network request"));
    const caption = `\`code\` **bold** *italic* ~~strike~~ [external](https://example.com/page) [document](${target.uuid})`;
    const source = `height: 560\ntitle: **Payment**, mobile\nurl: ${LINK}&t=AbC123-1&other=discarded#ignored\n\n${caption}`;
    const canonical = `url: ${LINK}\ntitle: **Payment**, mobile\nheight: 560\n\n${caption}`;
    const created = await rig.ok("create_doc", { title: "Design references", description: "Figma content stays structured and server-local.",
      blocks: [{ type: "figma", text: source }] });
    const doc = rig.instance.replicas.replica(created.uuid).doc;
    const original = created.blocks[0];
    expect(original).toMatchObject({ type: "figma", text: canonical,
      figma: { kind: "frame", file: "k3Lm9QzT2x", fileName: "Checkout flow", node: "12:345" } });
    expect(findBlockElement(doc, original.id)?.getAttribute("title")).toBe("**Payment**, mobile");
    expect(captionRuns(doc, original.id)).toEqual([
      { text: "code", marks: { inlineCode: true } }, { text: " ", marks: {} },
      { text: "bold", marks: { bold: true } }, { text: " ", marks: {} },
      { text: "italic", marks: { italic: true } }, { text: " ", marks: {} },
      { text: "strike", marks: { strike: true } }, { text: " ", marks: {} },
      { text: "external", marks: { link: "https://example.com/page" } }, { text: " ", marks: {} },
      { text: "document", marks: { docLink: target.uuid } },
    ]);
    const inserted = await rig.ok("insert_block", { uuid: created.uuid, after_block_id: original.id, blocks: [{ type: "figma", text: source }] });
    expect(inserted.blocks[0].text).toBe(canonical);
    expect(inserted.blocks[0].figma).toEqual(original.figma);
    expect(captionRuns(doc, inserted.blocks[0].id)).toEqual(captionRuns(doc, original.id));
    expect((await rig.ok("get_doc", { uuid: created.uuid })).blocks).toEqual([original, inserted.blocks[0]]);
    expect((await rig.ok("export_markdown", { uuid: created.uuid, frontmatter: false })).markdown)
      .toBe(`:::figma\n${canonical}\n:::\n\n:::figma\n${canonical}\n:::\n`);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([undefined, "https://example.com/x", "https://www.figma.com/deck/future-key"])(
    "reads canonical content without derived fields for a stored link this version cannot normalize: %s",
    async (url) => {
      const rig = await localRig();
      const created = await rig.ok("create_doc", { title: "Stored Figma links", description: "Version-skewed links remain readable.",
        blocks: [{ type: "paragraph", text: "Before" }, { type: "figma", text: SOURCE },
          { type: "figma", text: SOURCE }, { type: "paragraph", text: "After" }] });
      const doc = rig.instance.replicas.replica(created.uuid).doc;
      const original = created.blocks[1];
      const element = findBlockElement(doc, original.id)!;
      if (url === undefined) element.removeAttribute("url");
      else element.setAttribute("url", url);
      const stored = Y.encodeStateAsUpdate(doc);

      const read = await rig.ok("get_doc", { uuid: created.uuid });
      expect(read.blocks[1]).toEqual({ id: original.id, type: "figma",
        text: SOURCE.replace(LINK, url ?? ""), rev: expect.any(String) });
      expect(read.blocks[1].rev).not.toBe(original.rev);
      expect([read.blocks[0], ...read.blocks.slice(2)]).toEqual([created.blocks[0], ...created.blocks.slice(2)]);
      expect(Y.encodeStateAsUpdate(doc)).toEqual(stored);
    },
  );

  it.each([
    ["design/key", { kind: "file", file: "key" }],
  ])("passes accepted Figma host normalization through create_doc: %s", async (path, fields) => {
    const rig = await localRig();
    const created = await rig.ok("create_doc", { title: "Accepted Figma links", description: "Each path has one derived view identity.",
      blocks: ["figma.com", "www.figma.com"].map(host => ({ type: "figma", text: `url: https://${host}/${path}\n\n` })) });
    expect(created.blocks[0].figma).toEqual(fields);
    expect(created.blocks[1].figma).toEqual(fields);
    expect(created.blocks[0].text).toBe(created.blocks[1].text);
    expect(created.blocks[0].text).toContain("https://www.figma.com/");
  });

  it.each([
    ["title: No URL\n\nCaption", false],
    ["url: https://example.com/design/key\n\nCaption", true],
  ] as const)("refuses invalid create, insert and edit content before any write: %s", async (invalid, expectsHostError) => {
    const rig = await localRig();
    const created = await rig.ok("create_doc", { title: "Figma refusals", description: "Invalid content cannot make a partial write.",
      blocks: [{ type: "figma", text: SOURCE }] });
    const doc = rig.instance.replicas.replica(created.uuid).doc;
    const listed = await rig.ok("list_docs");
    const before = Y.encodeStateAsUpdate(doc);
    const writes = rig.instance.store.logSize();
    let updates = 0;
    doc.on("update", () => { updates += 1; });
    for (const [name, args] of [
      ["create_doc", { title: "No partial Figma", description: "All seeds validate before creation.",
        blocks: [{ type: "paragraph", text: "Earlier seed" }, { type: "figma", text: invalid }] }],
      ["insert_block", { uuid: created.uuid, blocks: [{ type: "figma", text: invalid }] }],
      ["edit_block", { uuid: created.uuid, block_id: created.blocks[0].id, old_text: SOURCE,
        new_text: invalid, rev: created.blocks[0].rev }],
    ] as const) {
      const refused = await rig.call(name, args);
      expect(refused).toMatchObject({ isError: true, payload: { error: "invalid_figma", recoveryClass: "manual",
        applied: false, partial: false, synced: false } });
      expect(refused.payload.recovery).toContain("url");
      if (expectsHostError) {
        const message = "figma blocks take figma.com links only; use a plain link for other sites";
        expect(refused.payload.message).toBe(name === "insert_block" ? `Entry 1: ${message} Nothing was written.` : message);
      }
    }
    expect(updates).toBe(0);
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    expect(rig.instance.store.logSize()).toBe(writes);
    expect(await rig.ok("list_docs")).toEqual(listed);
    expect((await rig.ok("get_doc", { uuid: created.uuid })).blocks).toEqual(created.blocks);
  });

  it("preserves stale assertions before malformed replacement content", async () => {
    const rig = await localRig();
    const created = await rig.ok("create_doc", { title: "Figma revisions", description: "Caption formatting participates in edit assertions.",
      blocks: [{ type: "figma", text: SOURCE }] });
    const doc = rig.instance.replicas.replica(created.uuid).doc;
    captionText(doc, created.blocks[0].id).format(0, 4, { bold: {} });
    const read = (await rig.ok("get_doc", { uuid: created.uuid })).blocks[0];
    const before = Y.encodeStateAsUpdate(doc);
    const stale = await rig.call("edit_block", { uuid: created.uuid, block_id: read.id,
      old_text: read.text, new_text: "missing URL", rev: created.blocks[0].rev });
    expect(stale.payload).toMatchObject({ error: "stale_block", applied: false });
    const mismatch = await rig.call("edit_block", { uuid: created.uuid, block_id: read.id,
      old_text: SOURCE, new_text: "missing URL", rev: read.rev });
    expect(mismatch.payload).toMatchObject({ error: "old_text_mismatch", applied: false });
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
  });

  it("indexes caption document links and refuses newly unknown targets before any write", async () => {
    const rig = await localRig();
    const target = await rig.ok("create_doc", { title: "Figma backlink target", description: "A locally known caption target." });
    const source = SOURCE.replace("Keep the caption.", `[Document](${target.uuid})`);
    const created = await rig.ok("create_doc", { title: "Figma outgoing links", description: "Caption links contribute to backlinks.",
      blocks: [{ type: "figma", text: source }] });
    expect((await rig.ok("backlinks", { uuid: target.uuid })).backlinks.map((row: { uuid: string }) => row.uuid)).toEqual([created.uuid]);
    expect((await rig.ok("get_doc", { uuid: created.uuid })).blocks[0].doc_links).toBeUndefined();
    const doc = rig.instance.replicas.replica(created.uuid).doc;
    const invalid = source.replace(target.uuid, randomUUID());
    const listed = await rig.ok("list_docs");
    const before = Y.encodeStateAsUpdate(doc);
    const writes = rig.instance.store.logSize();
    for (const [name, args] of [
      ["create_doc", { title: "No partial caption link", description: "All seed caption links validate first.",
        blocks: [{ type: "paragraph", text: "Earlier seed" }, { type: "figma", text: invalid }] }],
      ["insert_block", { uuid: created.uuid, blocks: [{ type: "figma", text: invalid }] }],
      ["edit_block", { uuid: created.uuid, block_id: created.blocks[0].id,
        old_text: source, new_text: invalid, rev: created.blocks[0].rev }],
    ] as const) {
      expect(await rig.call(name, args)).toMatchObject({ isError: true, payload: {
        error: "doclink_target_not_known_locally", applied: false, partial: false,
      } });
    }
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    expect(rig.instance.store.logSize()).toBe(writes);
    expect(await rig.ok("list_docs")).toEqual(listed);
    await rig.ok("edit_block", { uuid: created.uuid, block_id: created.blocks[0].id,
      old_text: source, new_text: SOURCE, rev: created.blocks[0].rev });
    expect((await rig.ok("backlinks", { uuid: target.uuid })).backlinks).toEqual([]);
  });

  it("keeps an unresolved caption target editable through label, formatting and header changes", async () => {
    const rig = await localRig();
    const created = await rig.ok("create_doc", { title: "Existing caption target", description: "An existing caption link need not resolve locally.",
      blocks: [{ type: "figma", text: SOURCE }] });
    const doc = rig.instance.replicas.replica(created.uuid).doc;
    const id = created.blocks[0].id;
    const text = captionText(doc, id);
    const unknown = randomUUID();
    text.format(0, text.length, { docLink: { docId: unknown } });
    const read = (await rig.ok("get_doc", { uuid: created.uuid })).blocks[0];
    const source = SOURCE.replace("Keep the caption.", `[**Renamed**](${unknown})`);
    const edited = await rig.ok("edit_block", { uuid: created.uuid, block_id: id,
      old_text: read.text, new_text: source, rev: read.rev });
    expect(edited.block.text).toBe(source);
    expect(captionText(doc, id)).toBe(text);
    expect(captionRuns(doc, id)).toEqual([{ text: "Renamed", marks: { bold: true, docLink: unknown } }]);
    const changedHeader = source.replace("title: Payment, mobile", "title: New title");
    expect((await rig.ok("edit_block", { uuid: created.uuid, block_id: id,
      old_text: edited.block.text, new_text: changedHeader, rev: edited.block.rev })).block.text).toBe(changedHeader);
    expect(captionText(doc, id)).toBe(text);
  });

  it("refuses MCP anchors and link ranges while preserving existing thread replies and resolution", async () => {
    const rig = await localRig();
    const target = await rig.ok("create_doc", { title: "Figma range target", description: "A known target for a refused range." });
    const created = await rig.ok("create_doc", { title: "Figma thread lifecycle", description: "Existing caption anchors remain readable and replyable.",
      blocks: [{ type: "figma", text: SOURCE }] });
    const doc = rig.instance.replicas.replica(created.uuid).doc;
    const id = created.blocks[0].id;
    const thread = createAnnotation(doc, id, 0, 4, "Reader", "Existing caption thread", { part: "caption" });
    const read = await rig.ok("get_doc", { uuid: created.uuid });
    const before = Y.encodeStateAsUpdate(doc);
    const writes = rig.instance.store.logSize();
    const annotated = await rig.call("annotate", { uuid: created.uuid, block_id: id, start: 0, end: 4, text: "New thread" });
    expect(annotated).toMatchObject({ isError: true, payload: { error: "annotation_figma", recoveryClass: "manual",
      applied: false, partial: false, synced: false } });
    expect(annotated.payload.recovery).toContain("thread_id");
    const linked = await rig.call("link_range", { uuid: created.uuid, block_id: id,
      start: 0, end: 4, doc_id: target.uuid, rev: read.blocks[0].rev });
    expect(linked).toMatchObject({ isError: true, payload: { error: "inline_link_range", applied: false, partial: false } });
    expect(linked.payload.recovery).toContain("Figma");
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    expect(rig.instance.store.logSize()).toBe(writes);
    for (const resolved of [true, false]) {
      const reply = await rig.ok("annotate", { uuid: created.uuid, thread_id: thread.id, resolved, text: "Reply" });
      expect(reply.annotation).toMatchObject({ resolved, range: { part: "caption", start: 0, end: 4, collapsed: false } });
    }
    const after = await rig.ok("get_doc", { uuid: created.uuid });
    expect(after.blocks).toEqual(read.blocks);
    expect(after.annotations[0].comments).toHaveLength(3);
  });

  it.each(["Caption", ""])("anchors the agent caret in the caption, including an empty one: %s", async (caption) => {
    const rig = await localRig();
    const created = await rig.ok("create_doc", { title: "Figma cursor", description: "Cursor publication addresses the stored caption." });
    const inserted = await rig.ok("insert_block", { uuid: created.uuid, blocks: [{ type: "figma", text: `url: ${LINK}\n\n${caption}` }] });
    const replica = rig.instance.replicas.replica(created.uuid);
    const cursor = replica.awareness.getLocalState()!.cursor;
    const position = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(cursor.head), replica.doc);
    const element = findBlockElement(replica.doc, inserted.blocks[0].id);
    const expected = blockText(replica.doc, inserted.blocks[0].id) ??
      (element === null ? undefined : figmaCaptionElement(element)?.firstChild);
    expect(position?.type).toBe(expected);
  });

  it("detects anchor-only and stored-attribute divergence during remote content verification", async () => {
    const rig = await localRig();
    const created = await rig.ok("create_doc", { title: "Figma replication", description: "Raw caption anchors and stored attributes participate in verification.",
      blocks: [{ type: "figma", text: SOURCE }] });
    const doc = rig.instance.replicas.replica(created.uuid).doc;
    const id = created.blocks[0].id;
    const thread = createAnnotation(doc, id, 0, 4, "Reader", "Caption anchor", { part: "caption" });
    const before = await rig.ok("get_doc", { uuid: created.uuid });
    const copy = new Y.Doc();
    try {
      Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc));
      expect(docFingerprint(copy)).toBe(docFingerprint(doc));
      captionText(doc, id).format(0, 4, { comment: null });
      const after = await rig.ok("get_doc", { uuid: created.uuid });
      expect(after.blocks).toEqual(before.blocks);
      expect(after.annotations[0]).toMatchObject({ id: thread.id, comments: before.annotations[0].comments, range: null });
      expect(docFingerprint(copy)).not.toBe(docFingerprint(doc));
      Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc));
      expect(docFingerprint(copy)).toBe(docFingerprint(doc));
      const element = findBlockElement(doc, id)!;
      element.setAttribute("title", "Payment,\nmobile");
      expect((await rig.ok("get_doc", { uuid: created.uuid })).blocks).toEqual(before.blocks);
      expect(docFingerprint(copy)).not.toBe(docFingerprint(doc));
      Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc));
      expect(docFingerprint(copy)).toBe(docFingerprint(doc));
    } finally {
      copy.destroy();
    }
  });
});
