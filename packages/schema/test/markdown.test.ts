import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  appendBlock,
  exportMarkdown,
  getBlocks,
  importMarkdown,
  initDoc,
  setTags,
} from "../src/index.js";

const UUID = "66666666-6666-4666-8666-666666666666";

const SOURCE = [
  "---",
  `uuid: ${UUID}`,
  "title: Test protocol",
  "tags: [protocol, schema]",
  "---",
  "",
  "How to verify the block model.",
  "",
  "## Steps",
  "",
  "Run the suite:",
  "",
  "```bash",
  "mise run test",
  "```",
  "",
  "```mermaid",
  "graph TD",
  "  read-->compare",
  "  compare-->work",
  "```",
  "",
  "###### Notes",
  "",
  "A paragraph that",
  "spans two source lines.",
  "",
].join("\n");

function docFrom(markdown: string): Y.Doc {
  const imported = importMarkdown(markdown);
  const doc = new Y.Doc();
  initDoc(doc, {
    uuid: imported.uuid ?? UUID,
    title: imported.title,
    tags: imported.tags,
  });
  for (const block of imported.blocks) appendBlock(doc, block);
  return doc;
}

describe("importMarkdown", () => {
  it("parses frontmatter, headings, fences and paragraphs", () => {
    const imported = importMarkdown(SOURCE);
    expect(imported.uuid).toBe(UUID);
    expect(imported.title).toBe("Test protocol");
    expect(imported.tags).toEqual(["protocol", "schema"]);
    expect(imported.blocks).toEqual([
      { type: "paragraph", text: "How to verify the block model." },
      { type: "heading", text: "Steps", level: 2 },
      { type: "paragraph", text: "Run the suite:" },
      { type: "code", text: "mise run test", language: "bash" },
      {
        type: "mermaid",
        text: "graph TD\n  read-->compare\n  compare-->work",
      },
      { type: "heading", text: "Notes", level: 6 },
      {
        type: "paragraph",
        text: "A paragraph that\nspans two source lines.",
      },
    ]);

    expect(importMarkdown("")).toEqual({ title: "", tags: [], blocks: [] });
  });

  it("takes the title from a leading H1 when there is no frontmatter, and consumes it", () => {
    const imported = importMarkdown("# Product definition\n\nWhat it is.\n");
    expect(imported.title).toBe("Product definition");
    expect(imported.tags).toEqual([]);
    expect(imported.uuid).toBeUndefined();
    expect(imported.blocks).toEqual([
      { type: "paragraph", text: "What it is." },
    ]);

    // Only a LEADING H1 is a title: any other heading stays a block, and the
    // document is left untitled.
    const notATitle = importMarkdown("## Section\n\nBody.\n");
    expect(notATitle.title).toBe("");
    expect(notATitle.blocks[0]).toEqual({
      type: "heading",
      text: "Section",
      level: 2,
    });
  });

  it("reads block-sequence tags, quoted scalars and CRLF input", () => {
    const imported = importMarkdown(
      [
        "---",
        'title: "Tricky: title, quoted"',
        "tags:",
        "  - one",
        '  - "two: also tricky"',
        "---",
        "",
        "Body.",
      ].join("\r\n"),
    );
    expect(imported.title).toBe("Tricky: title, quoted");
    expect(imported.tags).toEqual(["one", "two: also tricky"]);
    expect(imported.blocks).toEqual([{ type: "paragraph", text: "Body." }]);
  });

  it("skips HTML comments, including exported annotation comments", () => {
    const imported = importMarkdown(
      [
        "Para one.",
        "",
        "<!-- annotation abc range=0-4 alice: \"hm\" -->",
        "",
        "<!-- a",
        "     multi-line comment -->",
        "",
        "Para two.",
      ].join("\n"),
    );
    expect(imported.blocks).toEqual([
      { type: "paragraph", text: "Para one." },
      { type: "paragraph", text: "Para two." },
    ]);
  });

  it("handles tilde fences, unlabelled fences and an unterminated fence", () => {
    expect(importMarkdown("~~~\nplain\n~~~\n").blocks).toEqual([
      { type: "code", text: "plain", language: "" },
    ]);
    expect(importMarkdown("```\nplain\n```\n").blocks).toEqual([
      { type: "code", text: "plain", language: "" },
    ]);
    expect(importMarkdown("```ts\nnever closed\n").blocks).toEqual([
      { type: "code", text: "never closed", language: "ts" },
    ]);
  });

});

describe("markdown round-trip", () => {
  it("import → export → import is stable for a representative document", () => {
    const doc = docFrom(SOURCE);
    const exported = exportMarkdown(doc);
    expect(exported).toBe(SOURCE);

    const reimported = importMarkdown(exported);
    const first = importMarkdown(SOURCE);
    expect(reimported).toEqual(first);
    expect(getBlocks(docFrom(exported)).map(({ id, ...rest }) => rest)).toEqual(
      getBlocks(doc).map(({ id, ...rest }) => rest),
    );

    // Export reads nothing but the Y.Doc, so a replica hydrated from an update
    // exports byte-identically — and `frontmatter: false` drops only the header.
    const replica = new Y.Doc();
    Y.applyUpdate(replica, Y.encodeStateAsUpdate(doc));
    expect(exportMarkdown(replica)).toBe(exported);
    expect(exportMarkdown(replica, { frontmatter: false })).toBe(
      exported.slice(exported.indexOf("\n---\n\n") + "\n---\n\n".length),
    );
  });

  it("quotes frontmatter scalars that need it and round-trips them", () => {
    const doc = new Y.Doc();
    initDoc(doc, {
      uuid: UUID,
      title: "Schema: the keystone",
      tags: ["a tag", "with: colon"],
    });
    appendBlock(doc, { type: "paragraph", text: "Body." });

    const exported = exportMarkdown(doc);
    expect(exported).toBe(
      [
        "---",
        `uuid: ${UUID}`,
        'title: "Schema: the keystone"',
        'tags: [a tag, "with: colon"]',
        "---",
        "",
        "Body.",
        "",
      ].join("\n"),
    );
    const imported = importMarkdown(exported);
    expect(imported.title).toBe("Schema: the keystone");
    expect(imported.tags).toEqual(["a tag", "with: colon"]);

    // The degenerate end of the same emitter: an empty title and no tags still
    // produce valid, re-importable frontmatter — and a blockless document has
    // no body at all, which with `frontmatter: false` is the empty string.
    const empty = new Y.Doc();
    initDoc(empty, { uuid: UUID, title: "" });
    setTags(empty, []);
    const emptyExport = exportMarkdown(empty);
    expect(emptyExport).toBe(
      ["---", `uuid: ${UUID}`, 'title: ""', "tags: []", "---", ""].join("\n"),
    );
    expect(importMarkdown(emptyExport)).toEqual({
      title: "",
      tags: [],
      uuid: UUID,
      blocks: [],
    });
    expect(exportMarkdown(empty, { frontmatter: false })).toBe("");
  });

  it("lengthens the fence when the code itself contains backticks", () => {
    const doc = new Y.Doc();
    initDoc(doc, { uuid: UUID, title: "Fences" });
    appendBlock(doc, {
      type: "code",
      text: "```\nnested fence\n```",
      language: "md",
    });

    const exported = exportMarkdown(doc, { frontmatter: false });
    expect(exported).toBe(
      ["````md", "```", "nested fence", "```", "````", ""].join("\n"),
    );
    expect(importMarkdown(exported).blocks).toEqual([
      { type: "code", text: "```\nnested fence\n```", language: "md" },
    ]);
  });

  it("folds newlines out of headings", () => {
    const doc = new Y.Doc();
    initDoc(doc, { uuid: UUID, title: "Headings" });
    appendBlock(doc, { type: "heading", text: "One\nline", level: 2 });
    expect(exportMarkdown(doc, { frontmatter: false })).toBe("## One line\n");
  });
});
