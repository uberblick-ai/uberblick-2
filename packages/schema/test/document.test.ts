import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import type { Block } from "../src/index.js";
import {
  ANNOTATIONS_KEY,
  BLOCKS_KEY,
  DECISIONS_KEY,
  META_KEY,
  BlockNotFoundError,
  InvalidDocumentLifecycleError,
  appendBlock,
  blockRev,
  deleteBlock,
  getBlock,
  getBlockText,
  getBlocks,
  getMeta,
  getMetaMap,
  initDoc,
  insertBlock,
  setBlockLanguage,
  setBlockLevel,
  setChangelogSuggestion,
  setDescription,
  setKind,
  setLinks,
  setStatus,
  setTags,
  setTldr,
  setTitle,
} from "../src/index.js";

const UUID = "11111111-1111-4111-8111-111111111111";

/** Expected block, with the rev the reader should have computed for it. */
function withRev(block: Omit<Block, "rev">): Block {
  const { type, text, level, language, list, indent } = block;
  return {
    ...block,
    rev: blockRev({ type, text, level, language, list, indent }),
  };
}

function seeded(): Y.Doc {
  const doc = new Y.Doc();
  initDoc(doc, { uuid: UUID, title: "Block model", tags: ["schema"] });
  return doc;
}

describe("document round-trip", () => {
  it("initialises metadata and materialises the four roots", () => {
    const doc = seeded();
    expect(getMeta(doc)).toEqual({
      uuid: UUID,
      title: "Block model",
      tags: ["schema"],
      description: null,
      tldr: null,
      links: [],
    });
    expect([...doc.share.keys()].sort()).toEqual([
      ANNOTATIONS_KEY,
      BLOCKS_KEY,
      DECISIONS_KEY,
      META_KEY,
    ]);
  });

  it("updates title, tags and links independently", () => {
    const doc = seeded();
    setTitle(doc, "Block model, revised");
    setTags(doc, ["schema", "keystone"]);
    const target = "22222222-2222-4222-8222-222222222222";
    setLinks(doc, [target]);
    expect(getMeta(doc)).toEqual({
      uuid: UUID,
      title: "Block model, revised",
      tags: ["schema", "keystone"],
      description: null,
      tldr: null,
      links: [target],
    });
  });

  it("carries a description, and reads absent and blank as the same null", () => {
    const doc = new Y.Doc();
    initDoc(doc, { uuid: UUID, title: "Described" });
    // Nobody has said what this is for. That is one fact, with one shape.
    expect(getMeta(doc).description).toBeNull();

    setDescription(doc, "What this document is for, in a sentence.");
    expect(getMeta(doc).description).toBe(
      "What this document is for, in a sentence.",
    );

    // Re-initialising without one must not erase a description the document
    // has since acquired — the same rule `links` already has.
    initDoc(doc, { uuid: UUID, title: "Described" });
    expect(getMeta(doc).description).toBe(
      "What this document is for, in a sentence.",
    );

    setDescription(doc, "");
    expect(getMeta(doc).description).toBeNull();
  });

  it("carries and clears a TL;DR independently of the description", () => {
    const doc = seeded();
    setDescription(doc, "Agent-facing discovery copy.");

    setTldr(doc, "A quick summary for a person.");
    expect(getMeta(doc)).toMatchObject({
      description: "Agent-facing discovery copy.",
      tldr: "A quick summary for a person.",
    });

    setDescription(doc, "Rewritten discovery copy.");
    expect(getMeta(doc).tldr).toBe("A quick summary for a person.");

    setTldr(doc, null);
    expect(getMeta(doc)).toMatchObject({
      description: "Rewritten discovery copy.",
      tldr: null,
    });
    expect(getMetaMap(doc).get("tldr")).toBeNull();
  });

  it("keeps the changelog suggestion's three states apart", () => {
    const doc = seeded();
    // Nobody has written one: the key is absent, not null. Collapsing the two
    // would make every internal-only change look unfinished.
    expect(getMeta(doc)).not.toHaveProperty("changelogSuggestion");

    setChangelogSuggestion(doc, "Documents now carry a changelog suggestion.");
    expect(getMeta(doc).changelogSuggestion).toBe(
      "Documents now carry a changelog suggestion.",
    );

    // The deliberate decision that this work needs no user-facing entry.
    setChangelogSuggestion(doc, null);
    expect(getMeta(doc).changelogSuggestion).toBeNull();

    // And back to nobody having written one, with the key gone rather than
    // blank — otherwise a clear would read as that decision.
    setChangelogSuggestion(doc, "");
    expect(getMeta(doc)).not.toHaveProperty("changelogSuggestion");
    expect(getMetaMap(doc).has("changelogSuggestion")).toBe(false);
  });

  it("lets a concurrent changelog write outlive a clear, in both merge orders", () => {
    // Clearing deletes the key, which reaches only the value the clearing
    // replica has already seen — so the other writer's state survives, and the
    // three states are not equally durable. Both `DocMeta.changelogSuggestion`
    // and set_changelog_suggestion say so; this is what they say it about.
    for (const concurrent of ["A later sentence.", null]) {
      const a = seeded();
      setChangelogSuggestion(a, "The stored suggestion.");
      const b = new Y.Doc();
      Y.applyUpdate(b, Y.encodeStateAsUpdate(a));

      setChangelogSuggestion(a, "");
      setChangelogSuggestion(b, concurrent);
      const updateA = Y.encodeStateAsUpdate(a);
      const updateB = Y.encodeStateAsUpdate(b);
      Y.applyUpdate(a, updateB);
      Y.applyUpdate(b, updateA);

      for (const replica of [a, b]) {
        expect(getMeta(replica).changelogSuggestion).toBe(concurrent);
      }
    }
  });

  it("holds the changelog suggestion beside the other metadata, not instead of it", () => {
    const doc = seeded();
    setDescription(doc, "What this document is for.");
    setKind(doc, "decision");
    setStatus(doc, "open");
    const target = "22222222-2222-4222-8222-222222222222";
    setLinks(doc, [target]);

    setChangelogSuggestion(doc, "Nothing a user can see changed here.");
    expect(getMeta(doc)).toEqual({
      uuid: UUID,
      title: "Block model",
      tags: ["schema"],
      description: "What this document is for.",
      tldr: null,
      changelogSuggestion: "Nothing a user can see changed here.",
      kind: "decision",
      status: "open",
      links: [target],
    });

    // And the traffic runs the other way too: a metadata write is not a
    // wholesale replacement of `meta`.
    setTitle(doc, "Block model, revised");
    setTags(doc, ["schema", "keystone"]);
    setDescription(doc, "Rewritten.");
    expect(getMeta(doc).changelogSuggestion).toBe(
      "Nothing a user can see changed here.",
    );
  });

  it("writes every legal kind/status pair and refuses every illegal one", () => {
    const legal = [
      ["requirement", "draft"],
      ["requirement", "planned"],
      ["requirement", "implementing"],
      ["requirement", "done"],
      ["decision", "open"],
      ["decision", "decided"],
    ] as const;
    for (const [kind, status] of legal) {
      const doc = seeded();
      setKind(doc, kind);
      setStatus(doc, status);
      expect(getMeta(doc), `${kind}:${status}`).toMatchObject({ kind, status });
    }

    const noKind = seeded();
    const noKindBefore = getMetaMap(noKind).toJSON();
    expect(() => setStatus(noKind, "draft")).toThrow(
      InvalidDocumentLifecycleError,
    );
    expect(getMetaMap(noKind).toJSON()).toEqual(noKindBefore);

    for (const [kind, status] of [
      ["requirement", "open"],
      ["decision", "implementing"],
    ] as const) {
      const doc = seeded();
      setKind(doc, kind);
      const before = getMetaMap(doc).toJSON();
      expect(() => setStatus(doc, status)).toThrow(
        InvalidDocumentLifecycleError,
      );
      expect(getMetaMap(doc).toJSON()).toEqual(before);
    }

    const outside = seeded();
    expect(() => setKind(outside, "note" as never)).toThrow(
      InvalidDocumentLifecycleError,
    );
    setKind(outside, "requirement");
    const outsideBefore = getMetaMap(outside).toJSON();
    expect(() => setStatus(outside, "reviewing" as never)).toThrow(
      InvalidDocumentLifecycleError,
    );
    expect(getMetaMap(outside).toJSON()).toEqual(outsideBefore);
  });

  it.each([
    ["status", (doc: Y.Doc) => setKind(doc, "requirement")],
    ["kind", (doc: Y.Doc) => setStatus(doc, "draft")],
  ] as const)(
    "refuses a foreign BigInt %s with the named error and no write",
    (key, write) => {
      const source = seeded();
      getMetaMap(source).set(key, 1n);
      const replica = new Y.Doc();
      Y.applyUpdate(replica, Y.encodeStateAsUpdate(source));
      const before = Y.encodeStateAsUpdate(replica);

      expect(() => write(replica)).toThrow(InvalidDocumentLifecycleError);
      expect(Y.encodeStateAsUpdate(replica)).toEqual(before);
    },
  );

  it("re-kinds only when the stored status is legal for the new kind", () => {
    const doc = seeded();
    setKind(doc, "requirement");
    setStatus(doc, "implementing");
    const before = getMetaMap(doc).toJSON();

    expect(() => setKind(doc, "decision")).toThrow(
      InvalidDocumentLifecycleError,
    );
    expect(getMetaMap(doc).toJSON()).toEqual(before);

    setStatus(doc, "");
    setKind(doc, "decision");
    expect(getMeta(doc)).toMatchObject({ kind: "decision" });
    expect(getMeta(doc)).not.toHaveProperty("status");

    // A valid kind write repairs a mismatched pair left by a merge: the raw
    // status was always legal for a requirement and becomes readable again.
    getMetaMap(doc).set("status", "implementing");
    setKind(doc, "requirement");
    expect(getMeta(doc)).toMatchObject({
      kind: "requirement",
      status: "implementing",
    });
  });

  it("clears status alone, or kind and status together", () => {
    const doc = seeded();
    setKind(doc, "requirement");
    setStatus(doc, "planned");

    setStatus(doc, "");
    expect(getMeta(doc)).toMatchObject({ kind: "requirement" });
    expect(getMeta(doc)).not.toHaveProperty("status");

    setStatus(doc, "planned");
    setKind(doc, "");
    expect(getMeta(doc)).not.toHaveProperty("kind");
    expect(getMeta(doc)).not.toHaveProperty("status");
  });

  it("reads malformed and merged-mismatched lifecycle metadata tolerantly", () => {
    const malformedKind = seeded();
    getMetaMap(malformedKind).set("kind", "note");
    getMetaMap(malformedKind).set("status", "draft");
    expect(getMeta(malformedKind)).not.toHaveProperty("kind");
    expect(getMeta(malformedKind)).not.toHaveProperty("status");

    const malformedStatus = seeded();
    getMetaMap(malformedStatus).set("kind", "requirement");
    getMetaMap(malformedStatus).set("status", 42);
    expect(getMeta(malformedStatus)).toMatchObject({ kind: "requirement" });
    expect(getMeta(malformedStatus)).not.toHaveProperty("status");

    const a = seeded();
    setKind(a, "requirement");
    const b = new Y.Doc();
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    setKind(a, "decision");
    setStatus(b, "implementing");
    const updateA = Y.encodeStateAsUpdate(a);
    const updateB = Y.encodeStateAsUpdate(b);
    Y.applyUpdate(a, updateB);
    Y.applyUpdate(b, updateA);

    for (const replica of [a, b]) {
      expect(getMetaMap(replica).toJSON()).toMatchObject({
        kind: "decision",
        status: "implementing",
      });
      expect(getMeta(replica)).toMatchObject({ kind: "decision" });
      expect(getMeta(replica)).not.toHaveProperty("status");
    }
  });

  it("defaults tags and links to empty arrays and keeps links across re-init", () => {
    const doc = new Y.Doc();
    initDoc(doc, { uuid: UUID, title: "Untagged" });
    setLinks(doc, ["33333333-3333-4333-8333-333333333333"]);
    initDoc(doc, { uuid: UUID, title: "Untagged" });
    const meta = getMeta(doc);
    expect(meta.tags).toEqual([]);
    expect(meta.links).toEqual(["33333333-3333-4333-8333-333333333333"]);
  });

  it("stores every block type and reads them back in order", () => {
    const doc = seeded();
    const h1 = appendBlock(doc, { type: "heading", text: "Overview", level: 1 });
    const p = appendBlock(doc, { type: "paragraph", text: "Blocks hold text." });
    const code = appendBlock(doc, {
      type: "code",
      text: 'const x: number = 1;\nconsole.log(x);',
      language: "ts",
    });
    const mermaid = appendBlock(doc, {
      type: "mermaid",
      text: "graph TD\n  A-->B",
    });

    expect(getBlocks(doc)).toEqual([
      withRev({ id: h1, type: "heading", text: "Overview", level: 1 }),
      withRev({ id: p, type: "paragraph", text: "Blocks hold text." }),
      withRev({
        id: code,
        type: "code",
        text: 'const x: number = 1;\nconsole.log(x);',
        language: "ts",
      }),
      withRev({ id: mermaid, type: "mermaid", text: "graph TD\n  A-->B" }),
    ]);
    expect(new Set([h1, p, code, mermaid]).size).toBe(4);
  });

  /**
   * A list is a *run* of blocks, not a tree: what makes two items one list is
   * that they are adjacent, and each carries its own marker and depth. So the
   * attributes have to survive a read the way a heading's level does, and the
   * indent has to be clamped to what the model holds rather than refused.
   */
  it("stores list items as flat blocks carrying their marker and depth", () => {
    const doc = seeded();
    const first = appendBlock(doc, { type: "list-item", text: "alpha" });
    const nested = appendBlock(doc, {
      type: "list-item",
      text: "beta",
      list: "ordered",
      indent: 2,
    });
    const deep = appendBlock(doc, { type: "list-item", indent: 9 });
    const quote = appendBlock(doc, { type: "quote", text: "said someone" });

    expect(getBlocks(doc)).toEqual([
      withRev({ id: first, type: "list-item", text: "alpha", list: "bullet", indent: 0 }),
      withRev({ id: nested, type: "list-item", text: "beta", list: "ordered", indent: 2 }),
      withRev({ id: deep, type: "list-item", text: "", list: "bullet", indent: 3 }),
      withRev({ id: quote, type: "quote", text: "said someone" }),
    ]);

    // The marker and the depth are part of the block's identity for an
    // optimistic write: an item that moved a level is not the item that was read.
    expect(getBlock(doc, first)?.rev).not.toBe(
      blockRev({ type: "list-item", text: "alpha", list: "bullet", indent: 1 }),
    );
    expect(getBlock(doc, first)?.rev).not.toBe(
      blockRev({ type: "list-item", text: "alpha", list: "ordered", indent: 0 }),
    );
  });

  it("inserts at the start, after a block, and at the end", () => {
    const doc = seeded();
    const first = appendBlock(doc, { type: "paragraph", text: "one" });
    const last = appendBlock(doc, { type: "paragraph", text: "three" });
    const middle = insertBlock(doc, first, { type: "paragraph", text: "two" });
    const start = insertBlock(doc, null, { type: "paragraph", text: "zero" });

    expect(getBlocks(doc).map((block) => block.text)).toEqual([
      "zero",
      "one",
      "two",
      "three",
    ]);
    expect(getBlocks(doc).map((block) => block.id)).toEqual([
      start,
      first,
      middle,
      last,
    ]);
  });

  it("defaults heading level to 1, clamps out-of-range levels, and defaults code language to empty", () => {
    const doc = seeded();
    const plain = appendBlock(doc, { type: "heading", text: "No level" });
    const deep = appendBlock(doc, {
      type: "heading",
      text: "Too deep",
      level: 9 as 6,
    });
    const code = appendBlock(doc, { type: "code", text: "echo hi" });

    expect(getBlock(doc, plain)?.level).toBe(1);
    expect(getBlock(doc, deep)?.level).toBe(6);
    expect(getBlock(doc, code)).toEqual(
      withRev({ id: code, type: "code", text: "echo hi", language: "" }),
    );

    // Both attributes are also settable in place, without a re-type.
    setBlockLevel(doc, plain, 3);
    setBlockLanguage(doc, code, "python");
    expect(getBlock(doc, plain)?.level).toBe(3);
    expect(getBlock(doc, code)?.language).toBe("python");
  });

  it("deletes blocks and reports unknown ids", () => {
    const doc = seeded();
    const keep = appendBlock(doc, { type: "paragraph", text: "keep" });
    const drop = appendBlock(doc, { type: "paragraph", text: "drop" });
    deleteBlock(doc, drop);

    expect(getBlocks(doc).map((block) => block.id)).toEqual([keep]);
    expect(getBlock(doc, drop)).toBeNull();
    expect(() => deleteBlock(doc, drop)).toThrow(BlockNotFoundError);
    expect(() => getBlockText(doc, drop)).toThrow(BlockNotFoundError);
    expect(() => insertBlock(doc, drop, { type: "paragraph" })).toThrow(
      BlockNotFoundError,
    );
  });

});
