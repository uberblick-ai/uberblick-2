

import { validateCollectionSchema } from "@uberblick/schema";
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

it("explains when a decision record is useful without turning examples into project policy", async () => {
  const rig = await local();
  const lifecycle = (await rig.ok("get_help", { topic: "lifecycle" })).text;
  const guidance = lifecycle.split("### When to create a decision record\n")[1]?.split("\n## ")[0];
  for (const rule of [
    "deliberate architectural, product or UX choice", "its enduring reason",
    "guidance future work should follow", "code or configuration alone cannot tell you",
    "guide multiple tasks", "prevent a consequential accidental reversal",
    "repeatedly debated or reconsidered", "A rarely consulted record can still be valuable",
    "compatibility, security or product commitment", "they do not prove historical intent",
    "**Do not** create a record just to describe existing code, configuration, a routine fix",
    "a temporary workaround or implementation mechanics", "Do not turn every changed detail into policy",
    "leaving its implementation flexible",
    "What concrete future choice would it guide, or what consequential mistake would it prevent?",
    "ordinary documentation, code comments, an issue or a PR", "Check existing decision topics first",
    "Reuse the current topic", "follow the successor lifecycle",
    "not automatically authorized for creation", "follow the project’s approval rules",
    "they do not establish policies for your project",
  ]) expect(guidance, rule).toContain(rule);

  const examples = guidance!.split("\n").filter((line: string) => line.startsWith("| ")).slice(2);
  expect(examples).toHaveLength(4);
  for (const [index, choice, description] of [
    [0, "users’ devices and maintenance budget", "The deployment target is set to this version."],
    [1, "read and edit previously opened documents offline", "This function reads from the local database."],
    [2, "shadcn/ui as the sole component library", "This screen imports a Button component from shadcn/ui."],
    [3, "shared service rather than directly with each other", "A list of endpoints, classes or dependencies."],
  ] as const) {
    const cells = examples[index]!.split("|");
    expect(cells[1]).toContain(choice);
    expect(cells[2]?.trim()).toBe(description);
  }
  expect(examples[0]).toContain("minimum support, an explicit set or tested versions");
  expect(examples[2]).toContain("Custom alternatives require clear justification and human approval");
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
