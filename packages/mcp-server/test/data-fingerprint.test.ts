import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { initDoc } from "@uberblick/schema";
import { docFingerprint } from "../src/remote.js";

const UUID = "a4444444-4444-4444-8444-444444444444";
const recordKey = JSON.stringify(["record", "observations", "row-a"]);

function document(): Y.Doc {
  const doc = new Y.Doc();
  initDoc(doc, { uuid: UUID, title: "Observations" });
  return doc;
}

describe("promotion fingerprints include document data", () => {
  it("detects a data-only deletion that state vectors cannot detect", () => {
    const doc = document();
    doc.getMap("data").set(recordKey, { value: 1 });
    const remote = new Y.Doc();
    Y.applyUpdate(remote, Y.encodeStateAsUpdate(doc));
    expect(docFingerprint(remote)).toBe(docFingerprint(doc));
    doc.getMap("data").delete(recordKey);
    expect(Y.encodeStateVector(doc)).toEqual(Y.encodeStateVector(remote));
    expect(docFingerprint(remote)).not.toBe(docFingerprint(doc));
    Y.applyUpdate(remote, Y.encodeStateAsUpdate(doc));
    expect(docFingerprint(remote)).toBe(docFingerprint(doc));
    doc.destroy();
    remote.destroy();
  });

  it("preserves the fingerprint for empty data and ignores JSON property insertion order", () => {
    const doc = document();
    const before = docFingerprint(doc);
    doc.getMap("data");
    expect(docFingerprint(doc)).toBe(before);
    const copy = new Y.Doc();
    Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc));
    doc.getMap("data").set(recordKey, { a: 1, b: { c: 2, d: 3 } });
    copy.getMap("data").set(recordKey, { b: { d: 3, c: 2 }, a: 1 });
    expect(docFingerprint(copy)).toBe(docFingerprint(doc));
    doc.getMap("data").clear();
    expect(docFingerprint(doc)).toBe(before);
    doc.destroy();
    copy.destroy();
  });

  it("covers unsupported schemas and invalid records without attempting to validate or repair them", () => {
    const doc = document();
    const data = doc.getMap("data");
    data.set(JSON.stringify(["schema", "observations"]), {
      version: 99,
      schema: { type: "object" },
    });
    const before = docFingerprint(doc);
    data.set(recordKey, "invalid merged record");
    const stored = Y.encodeStateAsUpdate(doc);
    expect(docFingerprint(doc)).not.toBe(before);
    expect(Y.encodeStateAsUpdate(doc)).toEqual(stored);
    doc.destroy();
  });
});
