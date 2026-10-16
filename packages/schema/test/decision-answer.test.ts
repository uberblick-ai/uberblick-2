import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  BLOCK_TYPES,
  appendBlock,
  decisionAnswerFailure,
  decisionAnswerShapeFailure,
  decisionDocAnswerFailure,
  getMetaMap,
  initDoc,
  setKind,
  setTldr,
} from "../src/index.js";
import type { BlockInput } from "../src/index.js";

describe("decision answer contract", () => {
  it.each(BLOCK_TYPES)("accepts only the four answer block types: %s", (type) => {
    expect(decisionAnswerShapeFailure([{ type }])).toBe(
      ["paragraph", "code", "table", "list-item"].includes(type) ? null : "decision_block_unsupported",
    );
  });

  it("counts mixed-style and nested adjacent list items as one block, separated runs as separate blocks", () => {
    const list: BlockInput[] = Array.from({ length: 12 }, (_, index) => ({
      type: "list-item", text: String(index), list: index % 2 ? "ordered" : "bullet", indent: index % 4,
    }));
    expect(decisionAnswerShapeFailure([
      { type: "paragraph" }, ...list, { type: "code" },
    ])).toBeNull();
    expect(decisionAnswerShapeFailure([
      ...list, { type: "paragraph" }, ...list, { type: "paragraph" },
    ])).toBe("decision_answer_too_long");
    expect(decisionAnswerShapeFailure([
      { type: "paragraph" }, { type: "code" }, { type: "table" }, { type: "paragraph" },
    ])).toBe("decision_answer_too_long");
  });

  it("requires nonblank stored answer text, honoring prose inline content and source text", () => {
    expect(decisionAnswerFailure([])).toBe("decision_answer_empty");
    expect(decisionAnswerFailure([{ type: "paragraph", text: " \n\t " }, { type: "code" }])).toBe("decision_answer_empty");
    expect(decisionAnswerFailure([{ type: "paragraph", text: "Ignored", inline: [{ text: " ", marks: {} }] }])).toBe("decision_answer_empty");
    expect(decisionAnswerFailure([{ type: "list-item", inline: [{ text: "Use this answer", marks: { bold: true } }] }])).toBeNull();
    expect(decisionAnswerFailure([{ type: "code", text: "value", inline: [{ text: " ", marks: {} }] }])).toBeNull();
  });

  it("refuses a regular page's TL;DR and any raw stored data before kind adoption", () => {
    const doc = new Y.Doc();
    initDoc(doc, { uuid: "22222222-2222-4222-8222-222222222222", title: "Answer" });
    appendBlock(doc, { type: "paragraph", text: "A recorded answer" });
    setTldr(doc, "Legacy answer");
    expect(decisionDocAnswerFailure(doc)).toBe("decision_tldr_unsupported");
    setTldr(doc, null);
    doc.getMap("data").set("unsupported storage key", { version: 99 });
    expect(decisionDocAnswerFailure(doc)).toBe("decision_data_unsupported");
    doc.getMap("data").clear();
    expect(decisionDocAnswerFailure(doc)).toBeNull();
    getMetaMap(doc).set("tldr", "   ");
    expect(decisionDocAnswerFailure(doc)).toBe("decision_tldr_unsupported");
  });

  it.each(["Legacy answer", "   "])("ignores a decision's stored legacy TL;DR %j when validating its answer", (tldr) => {
    const doc = new Y.Doc();
    initDoc(doc, { uuid: "22222222-2222-4222-8222-222222222222", title: "Answer" });
    setKind(doc, "decision");
    setTldr(doc, tldr);
    expect(decisionDocAnswerFailure(doc)).toBe("decision_answer_empty");
    appendBlock(doc, { type: "paragraph", text: "A recorded answer" });
    const before = Y.encodeStateAsUpdate(doc);
    expect(decisionDocAnswerFailure(doc)).toBeNull();
    expect(getMetaMap(doc).get("tldr")).toBe(tldr);
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    doc.destroy();
  });
});
