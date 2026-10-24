import { getBlockInline, INLINE_ICONS, validateCollectionSchema } from "@uberblick/schema";
import { afterEach, expect, it, vi } from "vitest";

import { readBlocks, removeTempDirs, startServer, testConfig, type FailingStore } from "./core-helpers.js";
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

it("documents the zoned decision-answer time and current-time guidance", async () => {
  const rig = await local();
  const { text } = await rig.ok("get_help", { topic: "decisions" });
  expect(text).toContain("`when` is an ISO 8601 date-time with a time zone");
  expect(text).toContain("`2026-10-24T10:55:00Z`");
  expect(text).toContain("pass the current time if the answer was given just now");
  expect(text).toContain("normalises it to UTC");
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

it("documents inline icon names, source preservation, card labels and literal MCP emoji names", async () => {
  const rig = await local();
  const { text } = await rig.ok("get_help", { topic: "markdown" });
  for (const name of Object.keys(INLINE_ICONS)) expect(text).toContain(`\`:${name}:\``);
  for (const rule of [
    "`:name:`", "lowercase kebab case", "`:rocket:`", "literal, unchanged text",
    "code, terminal and chart source never render icons", "Markdown import/export keep the literal",
    "button: [:claude: Discuss with Claude](claude://code/new?prompt=Review)",
    "Write emoji as characters", "MCP never converts `:name:` to emoji",
    "`:smiley:` and `:rocket:` remain literal",
  ]) expect(text, rule).toContain(rule);
});

it("writes the markdown help's GitHub reference example as an ordinary external link", async () => {
  const rig = await local();
  const { text } = await rig.ok("get_help", { topic: "markdown" });
  const references = text.split("### GitHub references\n")[1]?.split("### Inline icons")[0];
  expect(references).toBeDefined();
  for (const rule of [
    "`github.com`", "`owner/repo#n`", "`repo#n`", "`#n`", "the URL itself",
    "same item as the address", "web shows it as a pill", "everywhere else it stays an ordinary link",
    "no special syntax or mark", "`/pull/<n>`", "`/issues/<n>`", "icon follows the address",
    "Link the reference, not a title", "linked title stays a plain link",
    "text renders as text", "`find_decisions` does not find it",
  ]) expect(references, rule).toContain(rule);
  const example = references!.match(/```json\n([\s\S]*?)\n```/)?.[1];
  expect(example).toBeDefined();
  const { inline } = JSON.parse(`{${example}}`);
  expect(inline).toEqual([
    { text: "Make caret placement deterministic (", marks: {} },
    { text: "app#2005", marks: { link: "https://github.com/acme/app/pull/2005" } },
    { text: ").", marks: {} },
  ]);
  const block = { type: "paragraph", text: "", inline };
  const created = await rig.ok("create_doc", {
    title: "GitHub reference example", description: "The inline example from markdown help.",
    blocks: [block],
  });
  const inserted = await rig.ok("insert_block", {
    uuid: created.uuid, after_block_id: created.blocks[0].id, blocks: [block],
  });
  const doc = rig.instance.replicas.replica(created.uuid).doc;
  for (const written of await readBlocks(rig, created.uuid, [created.blocks[0], inserted.blocks[0]])) {
    expect(written.text).toBe("Make caret placement deterministic (app#2005).");
    expect(getBlockInline(doc, written.id)).toEqual(inline);
  }
  const { markdown } = await rig.ok("export_markdown", { uuid: created.uuid, frontmatter: false });
  expect(markdown).toBe("Make caret placement deterministic ([app#2005](https://github.com/acme/app/pull/2005)).\n\n" +
    "Make caret placement deterministic ([app#2005](https://github.com/acme/app/pull/2005)).\n");
});
