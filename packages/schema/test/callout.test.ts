import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  BLOCK_TYPES, CALLOUT_VARIANTS, INLINE_ICONS, InvalidCalloutError,
  InvalidTableMappingError, StaleBlockError, appendBlock, blockRev,
  compareRevisions, createAnnotation, decisionDocAnswerFailure, docRev,
  editBlock, findBlockElement, getBlock, getBlockInline, getBlockRev,
  initDoc, insertBlock, isCalloutIcon,
  isProseBlockType, resolveAnnotationRange,
} from "../src/index.js";
import type { BlockInput, BlockType, CalloutVariant } from "../src/index.js";
import type { EditBlockOptions } from "../src/blocks.js";
import { snapshotBlocks } from "../src/revision-blocks.js";

function document(): Y.Doc {
  const doc = new Y.Doc();
  initDoc(doc, { uuid: "88888888-8888-4888-8888-888888888888", title: "Callouts" });
  return doc;
}

function copy(doc: Y.Doc): Y.Doc {
  const result = new Y.Doc();
  Y.applyUpdate(result, Y.encodeStateAsUpdate(doc));
  return result;
}

const validIcons = ["🚀", "⏱️", "⏱", "👍🏽", "🇳🇱", "👩‍💻", "1️⃣", ...Object.keys(INLINE_ICONS).map((name) => `:${name}:`)];
const invalidIcons = ["", "a", "1", "#", "*", "⎈", "🇦", "🚀🚀", "🚀́", "rocket", ":rocket:", ":toString:", " 🚀", "🚀\n"];

describe("callout attributes", () => {
  it("is prose and stores its default variant, without an icon attribute", () => {
    const doc = document();
    const id = appendBlock(doc, { type: "callout", text: "Read this" });
    expect(isProseBlockType("callout")).toBe(true);
    expect(getBlock(doc, id)).toMatchObject({ id, type: "callout", variant: "note", text: "Read this" });
    expect(getBlock(doc, id)).not.toHaveProperty("icon");
    expect(findBlockElement(doc, id)?.getAttributes()).toEqual({ id, variant: "note" });
    expect(decisionDocAnswerFailure(doc)).toBe("decision_block_unsupported");
  });

  it.each(CALLOUT_VARIANTS)("stores and reads the %s variant", (variant) => {
    const doc = document();
    const id = appendBlock(doc, { type: "callout", variant, text: "Read this" });
    expect(getBlock(doc, id)?.variant).toBe(variant);
    expect(findBlockElement(doc, id)?.getAttribute("variant")).toBe(variant);
  });

  it.each(validIcons)("accepts the emoji or curated icon %s", (icon) => {
    const doc = document();
    expect(isCalloutIcon(icon)).toBe(true);
    const id = appendBlock(doc, { type: "callout", icon });
    expect(getBlock(doc, id)?.icon).toBe(icon);
  });

  it.each(invalidIcons)("refuses icon %j before inserting anything", (icon) => {
    const doc = document();
    const before = Y.encodeStateAsUpdate(doc);
    expect(isCalloutIcon(icon)).toBe(false);
    expect(() => appendBlock(doc, { type: "callout", icon })).toThrow(InvalidCalloutError);
    expect(() => insertBlock(doc, null, { type: "callout", icon })).toThrow(expect.objectContaining({ code: "invalid_callout" }));
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
  });

  it.each(["NOTE", "info", "", null, 1])("refuses variant %j before inserting anything", (variant) => {
    const doc = document();
    const before = Y.encodeStateAsUpdate(doc);
    expect(() => appendBlock(doc, { type: "callout", variant: variant as CalloutVariant })).toThrow(InvalidCalloutError);
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
  });

  it.each(BLOCK_TYPES.filter((type) => type !== "callout"))("ignores callout attributes when creating %s", (type) => {
    const doc = document();
    const text = type === "table" ? "| Header |\n| --- |\n| Body |"
      : type === "card" ? "title: Title"
      : type === "figma" ? "url: https://figma.com/design/key" : "Text";
    const id = appendBlock(doc, { type, text, variant: "invalid" as CalloutVariant, icon: "invalid" });
    expect(getBlock(doc, id)).not.toHaveProperty("variant");
    expect(getBlock(doc, id)).not.toHaveProperty("icon");
    expect(findBlockElement(doc, id)?.getAttribute("variant")).toBeUndefined();
    expect(findBlockElement(doc, id)?.getAttribute("icon")).toBeUndefined();
  });

  it("defaults invalid stored attributes for display while preserving storage and detecting later changes", () => {
    const doc = document();
    const id = appendBlock(doc, { type: "callout", text: "Read this" });
    const element = findBlockElement(doc, id)!;
    element.setAttribute("variant", "future-variant");
    element.setAttribute("icon", ":future-icon:");
    const before = Y.encodeStateAsUpdate(doc);
    const rev = getBlockRev(doc, id);
    expect(getBlock(doc, id)).toMatchObject({ variant: "note" });
    expect(getBlock(doc, id)).not.toHaveProperty("icon");
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    editBlock(doc, id, "Read this", "Read this again");
    expect(element.getAttribute("variant")).toBe("future-variant");
    expect(element.getAttribute("icon")).toBe(":future-icon:");
    const textRev = getBlockRev(doc, id);
    element.setAttribute("variant", "another-future-variant");
    expect(getBlockRev(doc, id)).not.toBe(textRev);
    const variantRev = getBlockRev(doc, id);
    element.setAttribute("icon", ":another-future-icon:");
    expect(getBlockRev(doc, id)).not.toBe(variantRev);
    expect(getBlockRev(doc, id)).not.toBe(rev);
  });
});

describe("callout edits", () => {
  it("changes or clears supplied attributes in place, preserving text, marks and anchors", () => {
    const doc = document();
    const id = appendBlock(doc, {
      type: "callout", variant: "tip", icon: "🚀",
      inline: [{ text: "Read this", marks: { bold: true } }],
    });
    const element = findBlockElement(doc, id)!;
    const text = element.firstChild;
    const annotation = createAnnotation(doc, id, 0, 4, "reader", "Question");
    const delta = (text as Y.XmlText).toDelta();
    editBlock(doc, id, "Read this", "Read this", { variant: "warning" });
    expect(getBlock(doc, id)).toMatchObject({ variant: "warning", icon: "🚀" });
    editBlock(doc, id, "Read this", "Read this", { icon: ":codex:" });
    expect(getBlock(doc, id)).toMatchObject({ variant: "warning", icon: ":codex:" });
    editBlock(doc, id, "Read this", "Read this", { icon: "" });
    expect(getBlock(doc, id)).not.toHaveProperty("icon");
    expect(element.getAttribute("icon")).toBeUndefined();
    expect(findBlockElement(doc, id)).toBe(element);
    expect(element.firstChild).toBe(text);
    expect((text as Y.XmlText).toDelta()).toEqual(delta);
    expect(resolveAnnotationRange(doc, annotation.id)).toEqual({ start: 0, end: 4, collapsed: false });
    editBlock(doc, id, "Read this", "Read this again", { variant: "important", icon: "👩‍💻" });
    expect(getBlock(doc, id)).toMatchObject({ variant: "important", icon: "👩‍💻", text: "Read this again" });
    expect(getBlockInline(doc, id)[0]?.marks).toEqual({ bold: true });
    expect(resolveAnnotationRange(doc, annotation.id)).toEqual({ start: 0, end: 4, collapsed: false });
  });

  it.each<EditBlockOptions>([
    { variant: "bad" as CalloutVariant, icon: "🚀" },
    { variant: "warning", icon: "bad" },
    { variant: "warning", icon: null } as unknown as EditBlockOptions,
  ])("refuses invalid edits before writing text or any attribute: %j", (options) => {
    const doc = document();
    const id = appendBlock(doc, { type: "callout", text: "Read this" });
    const before = Y.encodeStateAsUpdate(doc);
    expect(() => editBlock(doc, id, "Read this", "Changed", options)).toThrow(InvalidCalloutError);
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
  });

  it("does not apply valid attributes before a later validation failure", () => {
    const doc = document();
    const id = appendBlock(doc, { type: "callout", text: "Read this" });
    const before = Y.encodeStateAsUpdate(doc);
    expect(() => editBlock(doc, id, "Read this", "Changed", {
      variant: "warning", icon: "🚀", tableMapping: { rows: [], columns: [] },
    })).toThrow(InvalidTableMappingError);
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
  });

  it.each<BlockInput>([
    { type: "paragraph", text: "Read this" },
    { type: "table", text: "| Header |\n| --- |\n| Body |" },
    { type: "card", text: "title: Title" },
  ])("refuses callout attributes on a $type before any write", (input) => {
    const doc = document();
    const id = appendBlock(doc, input);
    const block = getBlock(doc, id)!;
    for (const options of [{ variant: "warning" as const }, { icon: "🚀" }, { icon: "" }]) {
      const before = Y.encodeStateAsUpdate(doc);
      expect(() => editBlock(doc, id, block.text, "Changed", options)).toThrow(InvalidCalloutError);
      expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    }
  });

  it.each<EditBlockOptions>([{ variant: "warning" }, { icon: "🚀" }])("invalidates stale block and page revisions after an attribute change: %j", (options) => {
    const doc = document();
    const id = appendBlock(doc, { type: "callout", text: "Read this" });
    const rev = getBlockRev(doc, id);
    const pageRev = docRev(doc);
    editBlock(doc, id, "Read this", "Read this", { rev, ...options });
    expect(getBlockRev(doc, id)).not.toBe(rev);
    expect(docRev(doc)).not.toBe(pageRev);
    const before = Y.encodeStateAsUpdate(doc);
    expect(() => editBlock(doc, id, "Read this", "Changed", { rev })).toThrow(StaleBlockError);
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
  });
});

describe("callout history", () => {
  it("includes stored variant and icon fields and reports each changed field", () => {
    const before = document();
    const id = appendBlock(before, { type: "callout", variant: "tip", icon: "🚀", text: "Read this" });
    expect(snapshotBlocks(before)[0]?.fields).toEqual({ variant: "tip", icon: "🚀" });
    const after = copy(before);
    editBlock(after, id, "Read this", "Read this", { variant: "warning", icon: ":codex:" });
    expect(compareRevisions(before, after).blocks[0]).toMatchObject({ kind: "changed", fields: ["icon", "variant"], spans: [] });
    editBlock(after, id, "Read this", "Read this", { icon: "" });
    expect(snapshotBlocks(after)[0]?.fields).toEqual({ variant: "warning" });
    const element = findBlockElement(after, id)!;
    element.setAttribute("variant", "future-variant");
    element.setAttribute("icon", ":future-icon:");
    expect(snapshotBlocks(after)[0]?.fields).toEqual({ variant: "future-variant", icon: ":future-icon:" });
    expect(compareRevisions(before, after).blocks[0]?.fields).toEqual(["icon", "variant"]);
  });

  it("compares a quote becoming a callout as prose, preserving its word alignment", () => {
    const before = document();
    const id = appendBlock(before, { type: "quote", text: "Read this now" });
    const after = document();
    const calloutId = appendBlock(after, { type: "callout", text: "Read this later" });
    findBlockElement(after, calloutId)!.setAttribute("id", id);
    const comparison = compareRevisions(before, after).blocks[0]!;
    expect(comparison.fields).toEqual(["variant", "type"]);
    expect(comparison.spans).toEqual([
      { kind: "unchanged", text: "Read this " },
      { kind: "removed", text: "now" },
      { kind: "added", text: "later" },
    ]);
  });
});

describe("existing block revision compatibility", () => {
  it.each<[BlockType, string]>([
    ["paragraph", "dc02e537c1224697"], ["heading", "3f45e567a5bf6251"],
    ["code", "300932a0c36d87dc"], ["list-item", "0c4295d1af813c99"],
    ["quote", "5c27f07d5201092f"], ["table", "86734f8d9e1adc49"],
    ["terminal", "f6c388e1684e7afd"], ["chart", "78cf7bb154308473"],
    ["card", "e89e742790caee5b"], ["figma", "0da7efdd80e466a5"],
  ])("keeps the pre-callout %s content hash", (type, rev) => {
    expect(blockRev({ type, text: "hello" })).toBe(rev);
    expect(blockRev({ type, text: "hello", variant: "warning", icon: "🚀" })).toBe(rev);
  });

  it("keeps hashes for existing attribute-bearing blocks", () => {
    expect(blockRev({ type: "heading", text: "hello", level: 2 })).toBe("857cedc0575511c8");
    expect(blockRev({ type: "code", text: "hello", language: "ts" })).toBe("a145af0a14dd8d6c");
    expect(blockRev({ type: "list-item", text: "hello", list: "ordered", indent: 2 })).toBe("525415fc9b50069e");
  });
});
