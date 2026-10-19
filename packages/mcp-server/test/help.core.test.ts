

import { INLINE_ICONS, validateCollectionSchema } from "@uberblick/schema";
import { afterEach, expect, it, vi } from "vitest";

import { GUIDANCE_INSTRUCTIONS } from "../src/briefing.js";
import { type FailingStore, removeTempDirs, startServer, testConfig } from "./core-helpers.js";
import type { Rig } from "./core-helpers.js";

const rigs: Rig[] = [];

async function local(config = testConfig(), store?: FailingStore): Promise<Rig> {
  const rig = await startServer(config, store);
  rigs.push(rig);
  return rig;
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const rig of rigs.splice(0)) await rig.close();
  removeTempDirs();
});

/** Extract the documented JSON itself so it can be checked as a caller would use it. */

it("keeps shared guarantees in the owning topics after shortening descriptions", async () => {
  const rig = await local();
  const lifecycle = (await rig.ok("get_help", { topic: "lifecycle" })).text;
  for (const rule of [
    "decision_read_only", "doc_archived", "answer: {who, when, where}", "approvalFingerprint",
    "cross-replica lock", "structured-data reads available", "maximal decided record",
    'list_docs({kind: "decision"})', "include_deleted: true", "predicate",
  ]) expect(lifecycle, rule).toContain(rule);

  const workspaces = (await rig.ok("get_help", { topic: "workspaces" })).text;
  for (const rule of ["whole sidebar", "directory stubs", "left visible so it can be unpinned"]) {
    expect(workspaces, rule).toContain(rule);
  }
  const contracts = (await rig.ok("get_help", { topic: "tool-contracts" })).text;
  expect(contracts).toContain(GUIDANCE_INSTRUCTIONS);
  expect(contracts).toContain("does NOT mean the hub has stored it");
  expect(contracts).toContain("no rollback or cross-room remote atomicity");
  expect(contracts).toContain("re-sends it on reconnect");
});


it("documents the closed version-1 data vocabulary and demonstrates a schema the validator accepts", async () => {
  const rig = await local();
  const { text } = await rig.ok("get_help", { topic: "data" });
  for (const keyword of [
    "type", "properties", "required", "additionalProperties", "items", "enum", "const",
    "minimum", "maximum", "minLength", "maxLength", "minItems", "maxItems",
  ]) expect(text, keyword).toContain(keyword);
  for (const type of ["object", "array", "string", "number", "integer", "boolean", "null"]) {
    expect(text, type).toContain(type);
  }
  const example = text.match(/```json\n([\s\S]*?)\n```/)?.[1];
  expect(example).toBeDefined();
  expect(() => validateCollectionSchema(JSON.parse(example!))).not.toThrow();
});

it("documents inline icon names, literal fallback, source preservation and card labels", async () => {
  const rig = await local();
  const { text } = await rig.ok("get_help", { topic: "markdown" });
  for (const name of Object.keys(INLINE_ICONS)) expect(text).toContain(`\`:${name}:\``);
  for (const rule of [
    "`:name:`", "lowercase kebab case", "`:rocket:`", "literal, unchanged text",
    "code, terminal and chart source never render icons", "Markdown import/export keep the literal",
    "button: [:claude: Discuss with Claude](claude://code/new?prompt=Review)",
  ]) expect(text, rule).toContain(rule);
});
