import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import type { Block } from "../src/index.js";
import {
  ANNOTATIONS_KEY,
  BLOCKS_KEY,
  META_KEY,
  BlockNotFoundError,
  InvalidDocumentLifecycleError,
  addComment,
  appendBlock,
  applyDocData,
  blockRev,
  decisionContentLocked,
  createAnnotation,
  deleteBlock,
  getBlock,
  getBlockText,
  getBlocks,
  getMeta,
  getMetaMap,
  initDoc,
  insertBlock,
  listAnnotations,
  readDocData,
  setBlockLanguage,
  setBlockLevel,
  setDescription,
  setKind,
  setLinks,
  setStatus,
  setTags,
  setTldr,
  setTitle,
  upsertDirectoryEntry,
} from "../src/index.js";
import { syncDocs } from "./helpers.js";

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
  it("initialises metadata and materialises the three roots", () => {
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
      tags: ["keystone", "schema"],
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

  it.each(["A legacy release note.", null])(
    "ignores a stored legacy changelog value %j without writing",
    (legacy) => {
      const doc = seeded();
      const expected = getMeta(doc);
      const meta = getMetaMap(doc);
      meta.set("changelogSuggestion", legacy);
      let updates = 0;
      doc.on("update", () => {
        updates += 1;
      });

      expect(getMeta(doc)).toEqual(expected);
      expect(getMeta(doc)).not.toHaveProperty("changelogSuggestion");
      expect(meta.get("changelogSuggestion")).toBe(legacy);
      expect(updates).toBe(0);
      doc.destroy();
    },
  );

  it.each(["A legacy release note.", null])(
    "preserves a stored legacy changelog value %j through metadata writes and sync",
    (legacy) => {
      const a = seeded();
      getMetaMap(a).set("changelogSuggestion", legacy);
      const b = new Y.Doc();
      syncDocs(a, b);

      initDoc(a, {
        uuid: UUID,
        title: "Block model, revised",
        tags: ["schema", "keystone"],
      });
      setDescription(a, "Rewritten discovery copy.");
      setTldr(b, "A quick summary for a person.");
      setKind(b, "decision");
      setStatus(b, "open");
      const target = "22222222-2222-4222-8222-222222222222";
      setLinks(b, [target]);
      syncDocs(a, b);

      for (const replica of [a, b]) {
        expect(getMeta(replica)).toEqual({
          uuid: UUID,
          title: "Block model, revised",
          tags: ["keystone", "schema"],
          description: "Rewritten discovery copy.",
          tldr: "A quick summary for a person.",
          kind: "decision",
          status: "open",
          topic: UUID,
          discussion: null,
          links: [target],
        });
        expect(getMetaMap(replica).get("changelogSuggestion")).toBe(legacy);
        replica.destroy();
      }
    },
  );

  it("locks only decided-record content", () => {
    for (const [meta, locked] of [
      [{}, false],
      [{ kind: "decision" }, false],
      [{ kind: "decision", status: "open" }, false],
      [{ kind: "decision", status: "decided" }, true],
      [{ kind: "decision", status: "rejected" }, false],
      [{ kind: "decision", status: "withdrawn" }, false],
    ] as const) {
      expect(decisionContentLocked(meta), JSON.stringify(meta)).toBe(locked);
    }
  });

  it("writes every legal kind/status pair and refuses every illegal one", () => {
    const legal = [
      ["decision", "open"],
      ["decision", "decided"],
      ["decision", "rejected"],
      ["decision", "withdrawn"],
    ] as const;
    for (const [kind, status] of legal) {
      const doc = seeded();
      setKind(doc, kind);
      setStatus(doc, status);
      expect(getMeta(doc), `${kind}:${status}`).toMatchObject({ kind, status });
    }

    const noKind = seeded();
    const noKindBefore = getMetaMap(noKind).toJSON();
    expect(() => setStatus(noKind, "open")).toThrow(
      InvalidDocumentLifecycleError,
    );
    expect(getMetaMap(noKind).toJSON()).toEqual(noKindBefore);

    for (const status of ["draft", "planned", "implementing", "done"]) {
      const doc = seeded();
      const ordinaryBefore = Y.encodeStateAsUpdate(doc);
      expect(() => setKind(doc, "requirement" as never)).toThrow(
        InvalidDocumentLifecycleError,
      );
      expect(Y.encodeStateAsUpdate(doc)).toEqual(ordinaryBefore);
      setKind(doc, "decision");
      const before = getMetaMap(doc).toJSON();
      expect(() => setStatus(doc, status as never)).toThrow(
        InvalidDocumentLifecycleError,
      );
      expect(getMetaMap(doc).toJSON()).toEqual(before);
    }

    const outside = seeded();
    expect(() => setKind(outside, "note" as never)).toThrow(
      InvalidDocumentLifecycleError,
    );
    setKind(outside, "decision");
    const outsideBefore = getMetaMap(outside).toJSON();
    expect(() => setStatus(outside, "reviewing" as never)).toThrow(
      InvalidDocumentLifecycleError,
    );
    expect(getMetaMap(outside).toJSON()).toEqual(outsideBefore);
  });

  it.each([
    ["status", (doc: Y.Doc) => setKind(doc, "decision")],
    ["kind", (doc: Y.Doc) => setStatus(doc, "open")],
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
    getMetaMap(doc).set("kind", "requirement");
    getMetaMap(doc).set("status", "implementing");
    const before = getMetaMap(doc).toJSON();

    expect(() => setKind(doc, "decision")).toThrow(
      InvalidDocumentLifecycleError,
    );
    expect(getMetaMap(doc).toJSON()).toEqual(before);

    setStatus(doc, "");
    setKind(doc, "decision");
    expect(getMeta(doc)).toMatchObject({ kind: "decision" });
    expect(getMeta(doc)).not.toHaveProperty("status");

    // A valid kind write repairs a hidden pair whose status is already legal.
    getMetaMap(doc).set("kind", "requirement");
    getMetaMap(doc).set("status", "open");
    setKind(doc, "decision");
    expect(getMeta(doc)).toMatchObject({
      kind: "decision",
      status: "open",
    });
  });

  it("clears status alone, or kind and status together", () => {
    const doc = seeded();
    setKind(doc, "decision");
    setStatus(doc, "open");

    setStatus(doc, "");
    expect(getMeta(doc)).toMatchObject({ kind: "decision" });
    expect(getMeta(doc)).not.toHaveProperty("status");

    setStatus(doc, "open");
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
    getMetaMap(malformedStatus).set("kind", "decision");
    getMetaMap(malformedStatus).set("status", 42);
    expect(getMeta(malformedStatus)).toMatchObject({ kind: "decision" });
    expect(getMeta(malformedStatus)).not.toHaveProperty("status");

    const a = seeded();
    getMetaMap(a).set("kind", "requirement");
    const b = new Y.Doc();
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    setKind(a, "decision");
    getMetaMap(b).set("status", "implementing");
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

  it.each([undefined, "draft", "planned", "implementing", "done", "decided", 42])(
    "reads a stored requirement with status %j as regular without rewriting its room",
    (status) => {
      const doc = seeded();
      const directory = new Y.Doc();
      upsertDirectoryEntry(directory, { uuid: UUID, title: "Block model" });
      setDescription(doc, "Preserved description.");
      setTldr(doc, "Preserved summary.");
      setLinks(doc, ["22222222-2222-4222-8222-222222222222"]);
      const blockId = appendBlock(doc, { type: "paragraph", text: "Preserved content." });
      const annotation = createAnnotation(doc, blockId, 0, 9, "reviewer", "Preserved comment.");
      applyDocData(doc, directory, [{
        collection: "findings",
        schema: { version: 1, schema: { type: "object" } },
        upsert: [{ id: "one", value: { result: "Preserved data." } }],
      }]);
      const expected = {
        meta: getMeta(doc), blocks: getBlocks(doc),
        data: readDocData(doc), annotations: listAnnotations(doc),
      };
      const stored = getMetaMap(doc);
      stored.set("kind", "requirement");
      if (status !== undefined) stored.set("status", status);
      const before = Y.encodeStateAsUpdate(doc);
      expect(getMeta(doc)).toEqual(expected.meta);
      expect(decisionContentLocked(getMeta(doc))).toBe(false);
      expect(getBlocks(doc)).toEqual(expected.blocks);
      expect(readDocData(doc)).toEqual(expected.data);
      expect(listAnnotations(doc)).toEqual(expected.annotations);
      expect(Y.encodeStateAsUpdate(doc)).toEqual(before);

      const replica = new Y.Doc();
      Y.applyUpdate(replica, before);
      initDoc(doc, { uuid: UUID, title: "Revised", tags: ["rfc"] });
      setDescription(doc, "Revised description.");
      setTldr(doc, "Revised summary.");
      setLinks(doc, []);
      appendBlock(replica, { type: "paragraph", text: "New content." });
      addComment(replica, annotation.id, "author", "New comment.");
      applyDocData(replica, directory, [{ collection: "findings", upsert: [{ id: "two", value: {} }] }]);
      syncDocs(doc, replica);
      for (const current of [doc, replica]) {
        expect(getMeta(current)).not.toHaveProperty("kind");
        expect(getMeta(current)).not.toHaveProperty("status");
        expect(getMetaMap(current).get("kind")).toBe("requirement");
        expect(getMetaMap(current).get("status")).toBe(status);
        expect(getMeta(current).title).toBe("Revised");
        expect(getBlocks(current)).toHaveLength(2);
        expect(listAnnotations(current)[0]?.comments).toHaveLength(2);
        expect(readDocData(current)?.collections[0]?.records).toHaveLength(2);
        current.destroy();
      }
      directory.destroy();
    },
  );

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
