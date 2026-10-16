import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { applyDocData, readDocData } from "@uberblick/schema";
import { dataRevision } from "../src/editor/render-state.js";

describe("render data revisions", () => {
  it("can be computed from MCP-shaped stored values regardless of key, record or collection order", () => {
    const doc = new Y.Doc();
    const directory = new Y.Doc();
    const schema = { version: 1 as const, schema: { type: "object" as const } };
    const records = [{ id: "z", value: { x: 1, y: 2 } }, { id: "a", value: { x: 3, y: 4 } }];
    applyDocData(doc, directory, [
      { collection: "second", schema, replaceRecords: records },
      { collection: "first", schema, replaceRecords: [] },
    ]);
    const written = { collections: [
      { name: "second", schema, records: records.map(({ id, value }) => ({ id, value: { y: value.y, x: value.x } })) },
      { name: "first", schema, records: [] },
    ] };
    expect(dataRevision(written)).toBe(dataRevision(readDocData(doc)));
    expect(dataRevision({ collections: [] })).toBe(dataRevision(null));
    const initial = dataRevision(written);
    applyDocData(doc, directory, [{ collection: "second", upsert: [{ id: "a", value: { x: 5, y: 4 } }] }]);
    expect(dataRevision(readDocData(doc))).not.toBe(initial);
    doc.destroy(); directory.destroy();
  });

  it("includes schema and record identity even when plotted values do not change", () => {
    const collection = { name: "data", schema: null, records: [{ id: "a", value: { x: 1 } }] };
    const revision = dataRevision({ collections: [collection] });
    expect(dataRevision({ collections: [{ ...collection, schema: { version: 2 } }] })).not.toBe(revision);
    expect(dataRevision({ collections: [{ ...collection, records: [{ id: "b", value: { x: 1 } }] }] })).not.toBe(revision);
  });
});
