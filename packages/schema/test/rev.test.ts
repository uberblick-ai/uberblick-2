import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  appendBlock,
  blockRev,
  createAnnotation,
  editBlock,
  getBlock,
  getBlockRev,
  getBlocks,
  initDoc,
  setBlockLanguage,
  setBlockLevel,
  setBlockType,
} from "../src/index.js";
import { replicaPair, syncDocs } from "./helpers.js";

const UUID = "88888888-8888-4888-8888-888888888888";

function seeded(): Y.Doc {
  const doc = new Y.Doc();
  initDoc(doc, { uuid: UUID, title: "Revs" });
  return doc;
}

describe("blockRev", () => {
  it("is a stable 16-character hex hash", () => {
    const rev = blockRev({ type: "paragraph", text: "hello" });
    expect(rev).toMatch(/^[0-9a-f]{16}$/);
    expect(blockRev({ type: "paragraph", text: "hello" })).toBe(rev);
  });

  it("changes with text, type and attributes", () => {
    const base = blockRev({ type: "paragraph", text: "hello" });
    expect(blockRev({ type: "paragraph", text: "hello " })).not.toBe(base);
    expect(blockRev({ type: "mermaid", text: "hello" })).not.toBe(base);
    expect(blockRev({ type: "heading", text: "hello", level: 1 })).not.toBe(
      blockRev({ type: "heading", text: "hello", level: 2 }),
    );
    expect(blockRev({ type: "code", text: "x", language: "ts" })).not.toBe(
      blockRev({ type: "code", text: "x", language: "py" }),
    );
  });

  it("cannot be confused by field boundaries", () => {
    // A field value that looks like a neighbouring field must not collide.
    expect(blockRev({ type: "code", text: "a", language: "b" })).not.toBe(
      blockRev({ type: "code", text: "", language: "b\",\"a" }),
    );
    expect(blockRev({ type: "paragraph", text: "" })).not.toBe(
      blockRev({ type: "paragraph", text: '","' }),
    );
  });

  it("is what reads report, and follows every kind of write", () => {
    const doc = seeded();
    const id = appendBlock(doc, { type: "heading", text: "Title", level: 2 });

    const first = getBlock(doc, id)?.rev;
    expect(first).toBe(blockRev({ type: "heading", text: "Title", level: 2 }));
    expect(getBlockRev(doc, id)).toBe(first);
    expect(getBlocks(doc)[0]?.rev).toBe(first);

    editBlock(doc, id, "Title", "Title, revised");
    const afterEdit = getBlockRev(doc, id);
    expect(afterEdit).not.toBe(first);

    setBlockLevel(doc, id, 3);
    const afterLevel = getBlockRev(doc, id);
    expect(afterLevel).not.toBe(afterEdit);

    setBlockType(doc, id, "code", { language: "ts" });
    const afterType = getBlockRev(doc, id);
    expect(afterType).not.toBe(afterLevel);

    setBlockLanguage(doc, id, "python");
    expect(getBlockRev(doc, id)).not.toBe(afterType);
  });

  it("ignores annotation marks, so annotating does not invalidate a pending edit", () => {
    const doc = seeded();
    const id = appendBlock(doc, { type: "paragraph", text: "Hello brave world" });
    const before = getBlockRev(doc, id);

    createAnnotation(doc, id, 6, 11, "reviewer", "hm");

    expect(getBlockRev(doc, id)).toBe(before);
    // …and an edit asserting the pre-annotation rev still applies.
    editBlock(doc, id, "Hello brave world", "Hello brave new world", {
      rev: before,
    });
    expect(getBlock(doc, id)?.text).toBe("Hello brave new world");
  });

  it("agrees across replicas that have converged", () => {
    let id = "";
    const [a, b] = replicaPair((doc) => {
      initDoc(doc, { uuid: UUID, title: "Revs" });
      id = appendBlock(doc, { type: "paragraph", text: "shared" });
    });
    expect(getBlockRev(a, id)).toBe(getBlockRev(b, id));

    editBlock(a, id, "shared", "shared, edited by A");
    expect(getBlockRev(a, id)).not.toBe(getBlockRev(b, id));
    syncDocs(a, b);
    expect(getBlockRev(a, id)).toBe(getBlockRev(b, id));
  });
});
