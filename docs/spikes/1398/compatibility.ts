/**
 * Throwaway, entirely in-memory compatibility probes for #1398.
 * From packages/mcp-server: mise exec -- node --import tsx ../../docs/spikes/1398/compatibility.ts
 * No replica, workspace, hub or filesystem writes occur here.
 */
import assert from "node:assert/strict";
import * as Y from "../../../packages/schema/node_modules/yjs/dist/yjs.mjs";
import * as z from "../../../packages/mcp-server/node_modules/zod/index.js";
import {
  decisionApprovalFingerprint,
  exportMarkdown,
  getBlocks,
  getBlocksFragment,
  getMeta,
  getMetaMap,
  initDoc,
  setTitle,
} from "../../../packages/schema/src/index.ts";

const validationCases: Array<{
  name: string;
  schema: Parameters<typeof z.fromJSONSchema>[0];
  input: unknown;
  expected: boolean | string;
}> = [
  { name: "uniqueItems", schema: { type: "array", items: { type: "number" }, uniqueItems: true }, input: [1, 1], expected: true },
  { name: "contains", schema: { type: "array", items: { type: "number" }, contains: { const: 2 } }, input: [1], expected: true },
  { name: "minProperties", schema: { type: "object", minProperties: 2 }, input: {}, expected: true },
  { name: "required", schema: { type: "object", properties: { value: { type: "number" } }, required: ["value"], additionalProperties: false }, input: {}, expected: false },
  { name: "minimum", schema: { type: "number", minimum: 0 }, input: -1, expected: false },
  { name: "additionalProperties", schema: { type: "object", properties: { value: { type: "number" } }, required: ["value"], additionalProperties: false }, input: { value: 1, extra: 2 }, expected: false },
  // biome-ignore lint/suspicious/noThenProperty: JSON Schema's conditional keyword is the probe's input.
  { name: "if-then", schema: { type: "number", if: { minimum: 0 }, then: { minimum: 10 } }, input: 1, expected: "Conditional schemas (if/then/else) are not supported" },
];

const converter = validationCases.map(({ name, schema, input, expected }) => {
  let result: { accepted: boolean } | { error: string };
  try {
    result = { accepted: z.fromJSONSchema(schema).safeParse(input).success };
  } catch (error) {
    result = { error: error instanceof Error ? error.message : String(error) };
  }
  assert.deepEqual(result, typeof expected === "boolean" ? { accepted: expected } : { error: expected });
  return { name, ...result };
});

const newer = new Y.Doc();
initDoc(newer, { uuid: "d44d8c9a-67e5-4c91-a373-123456789012", title: "Synthetic compatibility probe" });
const before = decisionApprovalFingerprint(newer);
const syntheticArea = {
  version: 1,
  collections: {
    points: [{ id: "point-a", value: 42, note: "synthetic-value-42" }],
    labels: [{ id: "label-a", label: "synthetic label" }],
  },
};
newer.getMap("spikeData").set("area", syntheticArea);
getMetaMap(newer).set("unknownSyntheticField", "preserve");
const dataOnlyFingerprintUnchanged = before === decisionApprovalFingerprint(newer);

// Emulate the current client's normal read/write APIs and full-state persistence.
const currentClient = new Y.Doc();
Y.applyUpdate(currentClient, Y.encodeStateAsUpdate(newer));
setTitle(currentClient, "Edited by existing title API");
const roundTrip = new Y.Doc();
Y.applyUpdate(roundTrip, Y.encodeStateAsUpdate(currentClient));
const dataRootSurvivesExistingTitleWrite = roundTrip.getMap("spikeData").get("area");
const unknownMetaSurvives = getMetaMap(roundTrip).get("unknownSyntheticField");
const getMetaExposesUnknown = Object.hasOwn(getMeta(roundTrip), "unknownSyntheticField");
const markdownExposesData = exportMarkdown(roundTrip).includes("synthetic-value-42");
assert.equal(dataOnlyFingerprintUnchanged, true);
assert.deepEqual(dataRootSurvivesExistingTitleWrite, syntheticArea);
assert.equal(unknownMetaSurvives, "preserve");
assert.equal(getMetaExposesUnknown, false);
assert.equal(markdownExposesData, false);

// The schema projection used by MCP hides the unknown node name as paragraph.
const foreign = new Y.XmlElement("synthetic-chart");
foreign.setAttribute("id", "foreign-a");
const text = new Y.XmlText();
text.insert(0, "synthetic chart text");
foreign.insert(0, [text]);
getBlocksFragment(newer).insert(0, [foreign]);
const unknownNodeProjection = getBlocks(newer).map(({ id, type, text }) => ({ id, type, text }));
assert.deepEqual(unknownNodeProjection, [{ id: "foreign-a", type: "paragraph", text: "synthetic chart text" }]);

const result = {
  method: "In-memory schema API and Yjs full-state roundtrip; no hub, browser or historical client binary",
  versions: { yjs: "13.6.32", zod: "4.4.3" },
  converter,
  compatibility: {
    dataOnlyFingerprintUnchanged,
    dataRootSurvivesExistingTitleWrite,
    unknownMetaSurvives,
    getMetaExposesUnknown,
    markdownExposesData,
    unknownNodeProjection,
  },
};
newer.destroy();
currentClient.destroy();
roundTrip.destroy();
console.log(JSON.stringify(result, null, 2));
