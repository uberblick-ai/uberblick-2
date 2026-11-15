import { expect, it } from "vitest";
import * as Y from "yjs";
import { appendBlock, editBlock, getBlock, getBlockInline, initDoc } from "../src/index.js";

function document() {
  const doc = new Y.Doc();
  initDoc(doc, { uuid: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", title: "Links" });
  return doc;
}

it("links newly written addresses across splice boundaries without changing old plain addresses", () => {
  const doc = document();
  const oldText = "https://old.example stays plain; new: https://new.exam";
  const id = appendBlock(doc, { type: "paragraph", text: oldText });
  const newText = `${oldText}ple/path). Also www.example.com.`;
  editBlock(doc, id, oldText, newText, { autolink: true });
  expect(getBlock(doc, id)?.text).toBe(newText);
  expect(getBlockInline(doc, id)).toEqual([
    { text: "https://old.example stays plain; new: ", marks: {} },
    { text: "https://new.example/path", marks: { link: "https://new.example/path" } },
    { text: "). Also ", marks: {} },
    { text: "www.example.com", marks: { link: "https://www.example.com" } },
    { text: ".", marks: {} },
  ]);
  doc.destroy();
});

it("never retargets existing links or overlaps document links and inline code", () => {
  const doc = document();
  const id = appendBlock(doc, {
    type: "paragraph",
    inline: [
      { text: "https://example.com", marks: { link: "https://target.example" } },
      { text: " https://example.com", marks: { docLink: "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff" } },
      { text: " https://example.com", marks: { inlineCode: true } },
    ],
  });
  const before = getBlock(doc, id)!.text;
  const after = before.replaceAll("example.com", "example.com/path");
  editBlock(doc, id, before, after, { autolink: true });
  expect(getBlockInline(doc, id)).toEqual([
    { text: "https://example.com/path", marks: { link: "https://target.example" } },
    { text: " https://example.com/path", marks: { docLink: "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff" } },
    { text: " https://example.com/path", marks: { inlineCode: true } },
  ]);
  doc.destroy();
});

it("keeps source literal and does not link on a no-op or deletion-only edit", () => {
  const doc = document();
  const oldText = "https://example.com!";
  const prose = appendBlock(doc, { type: "paragraph", text: oldText });
  editBlock(doc, prose, oldText, oldText, { autolink: true });
  expect(getBlockInline(doc, prose)).toEqual([{ text: oldText, marks: {} }]);
  editBlock(doc, prose, oldText, "https://example.com", { autolink: true });
  expect(getBlockInline(doc, prose)).toEqual([{ text: "https://example.com", marks: {} }]);
  for (const type of ["code", "terminal", "chart"] as const) {
    const id = appendBlock(doc, { type, text: "source" });
    editBlock(doc, id, "source", "https://example.com", { autolink: true });
    expect(getBlockInline(doc, id)).toEqual([{ text: "https://example.com", marks: {} }]);
    expect(getBlock(doc, id)?.text).toBe("https://example.com");
  }
  doc.destroy();
});
