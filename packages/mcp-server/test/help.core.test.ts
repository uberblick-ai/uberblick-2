import { INLINE_ICONS, validateCollectionSchema } from "@uberblick/schema";
import { afterEach, expect, it, vi } from "vitest";

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
