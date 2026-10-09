import { randomUUID } from "node:crypto";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import { createTagCatalogEntry, setTags, validateCollectionSchema } from "@uberblick/schema";
import { afterEach, expect, it, vi } from "vitest";
import { FAILURE_INSTRUCTIONS, READ_ONLY_TOOLS } from "../src/failures.js";
import { GUIDANCE_INSTRUCTIONS } from "../src/briefing.js";
import { toolHelpEntries } from "../src/help-examples.js";
import {
  FailingStore, removeTempDirs, startServer, TEST_SECRET, testConfig,
} from "./helpers.js";
import type { Rig } from "./helpers.js";

const concepts = ["orientation", "workspaces", "lifecycle", "markdown", "data", "tools", "tool-contracts"];
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
function jsonSection(text: string, heading: string): any {
  const section = text.split(`## ${heading}\n`)[1]?.split("\n## ")[0];
  const json = section?.match(/```json\n([\s\S]*?)\n```/)?.[1];
  if (json === undefined) throw new Error(`Help has no JSON in its ${heading} section`);
  return JSON.parse(json);
}

it("lists every concept and registered tool once, with the same Markdown through both read routes", async () => {
  const rig = await local();
  const { tools } = await rig.client.listTools();
  const { topics } = await rig.ok("get_help");
  expect(topics.map(({ id }: { id: string }) => id).sort()).toEqual(
    [...concepts, ...tools.map(({ name }) => name)].sort(),
  );
  const resources = (await rig.client.listResources()).resources
    .filter(({ uri }) => uri.startsWith("uberblick://help/"));
  expect(resources.map(({ uri, title, description, mimeType }) => ({
    id: uri.slice("uberblick://help/".length), uri, title, description, mimeType,
  }))).toEqual(topics.map((topic: object) => ({ ...topic, mimeType: "text/markdown" })));

  for (const { id, title, description, uri } of topics) {
    expect(title.length).toBeGreaterThan(0);
    expect(description.length).toBeGreaterThan(0);
    expect(uri).toBe(`uberblick://help/${id}`);
    const help = await rig.ok("get_help", { topic: id });
    expect(help).toMatchObject({ topic: id, title, description, uri, text: expect.any(String) });
    expect(help.text.length).toBeGreaterThan(0);
    expect((await rig.client.readResource({ uri })).contents).toEqual([
      { uri, mimeType: "text/markdown", text: help.text },
    ]);
  }
});

it("refuses unknown topics through the tool failure contract and the resource-not-found protocol error", async () => {
  const rig = await local();
  const { topics } = await rig.ok("get_help");
  const topic = "no-such-help-topic";
  const refused = await rig.call("get_help", { topic });
  expect(refused).toMatchObject({ isError: true, payload: {
    error: "unknown_help_topic", topics: topics.map(({ id }: { id: string }) => id),
    message: expect.any(String), recoveryClass: "manual", recovery: expect.any(String),
  } });
  for (const key of ["applied", "partial", "synced"]) expect(refused.payload).not.toHaveProperty(key);
  expect(READ_ONLY_TOOLS.has("get_help")).toBe(true);
  const uri = `uberblick://help/${topic}`;
  await expect(rig.client.readResource({ uri })).rejects.toMatchObject({
    code: -32002, data: { uri }, message: expect.stringContaining(uri),
  });
});

it("renders each tool's actual full description and schemas, with an accepted example and owning-topic links", async () => {
  const rig = await local();
  const { tools } = await rig.client.listTools();
  const validator = new AjvJsonSchemaValidator();
  const index = (await rig.ok("get_help", { topic: "tools" })).text;
  for (const tool of tools) {
    const { text } = await rig.ok("get_help", { topic: tool.name });
    expect(text, tool.name).toContain(tool.title);
    expect(text, tool.name).toContain(tool.description);
    const inputSchema = jsonSection(text, "Arguments");
    expect(inputSchema, tool.name).toEqual(tool.inputSchema);
    expect(jsonSection(text, "Output"), tool.name).toEqual(tool.outputSchema);
    const entry = toolHelpEntries[tool.name];
    expect(entry, `${tool.name} has no per-tool help entry`).toBeDefined();
    const details = entry!.details;
    if (details !== undefined) {
      const constraints = text.split("## Constraints\n")[1]?.split("\n## ")[0];
      expect(constraints, `${tool.name} loses its expanded tool-specific contract`).toContain(details);
    }
    const checked = validator.getValidator(inputSchema)(jsonSection(text, "Example"));
    expect(checked.valid, `${tool.name}: ${checked.errorMessage ?? "invalid example"}`).toBe(true);
    const related = text.split("## Related\n")[1] ?? "";
    expect(related, tool.name).toContain("uberblick://help/tool-contracts");
    expect(index, tool.name).toContain(`uberblick://help/${tool.name}`);
  }
  for (const [tool, topic] of [
    ["set_tags", "workspaces"], ["set_title", "workspaces"], ["get_sidebar", "workspaces"],
    ["edit_block", "lifecycle"], ["archive_doc", "lifecycle"], ["set_status", "lifecycle"],
    ["get_data", "data"], ["update_data", "data"], ["export_markdown", "markdown"],
  ]) {
    expect((await rig.ok("get_help", { topic: tool })).text.split("## Related\n")[1])
      .toContain(`uberblick://help/${topic}`);
  }
});

it("keeps tool-specific modes, refusals and recovery in the tool's own expanded help", async () => {
  const rig = await local();
  for (const [tool, guidance] of [
    ["create_doc", "before a UUID is allocated or a room is written"],
    ["create_doc", "rooms already `completed`"],
    ["edit_block", "strictly inside unmarked text"],
    ["edit_block", "invalid_table_mapping"],
    ["edit_block", "currentText` and `currentRev"],
    ["archive_doc", "rolledBack: false"],
    ["archive_doc", "a later call retries it"],
    ["get_data", "first remaining record"],
    ["get_data", "Cursors are not snapshots"],
    ["link_range", "decision_read_only"],
  ]) {
    const { text } = await rig.ok("get_help", { topic: tool });
    const constraints = text.split("## Constraints\n")[1]?.split("\n## ")[0];
    expect(constraints, `${tool}: ${guidance}`).toContain(guidance);
  }
});

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

it("serves the short startup orientation verbatim and directs clients to the complete help catalog", async () => {
  const rig = await local();
  const instructions = rig.client.getInstructions()!;
  const corpusOrientation = "Uberblick organizes local-first workspaces into documents, blocks and decision records. " +
    "Document tools operate on your selected workspace: discover with `get_sidebar`, " +
    "`list_docs` or `search`, then read with `get_doc` before editing. Use returned text " +
    "and rev for block edits. Structured data has dedicated tools and can supply document " +
    "views. Discover version-matched product help through MCP resources, or call " +
    "`get_help(topic)`, for concepts, lifecycle, supported Markdown syntax and tool usage. " +
    "Built-in help is workspace-agnostic; workspace conventions are ordinary documents, " +
    "not initialization instructions or help resources. Follow recovery guidance on failures.";
  expect(instructions.replace(/\s+/g, " ")).toContain(corpusOrientation);
  expect(instructions.length).toBeLessThanOrEqual(1_000);
  expect((await rig.ok("get_help", { topic: "orientation" })).text).toBe(instructions);
  for (const id of concepts) expect(instructions).toContain(id);
  expect(instructions).toContain("uberblick://help/{topic}");
  expect(instructions).toContain("get_help({})");
  expect(instructions).toMatch(/tool names.*topic ids/i);
  expect(instructions).not.toContain(FAILURE_INSTRUCTIONS);
  expect(instructions).not.toContain(GUIDANCE_INSTRUCTIONS);
  expect(instructions).not.toContain("recoveryClass");
});

it("keeps every topic workspace-independent and reads help without settling or opening replicas", async () => {
  const empty = await local(testConfig({ authSecret: TEST_SECRET }));
  const workspace = await local(testConfig({ workspaceId: randomUUID() }));
  const secret = "PRIVATE_WORKSPACE_HELP_MUST_NOT_INCLUDE_THIS";
  const doc = await workspace.ok("create_doc", {
    title: secret, description: secret, blocks: [{ type: "paragraph", text: secret }],
  });
  const tag = createTagCatalogEntry(workspace.instance.replicas.settings().doc, "guidance");
  setTags(workspace.instance.replicas.replica(doc.uuid).doc, [tag.id]);
  expect((await workspace.call("set_title", { uuid: doc.uuid, title: "Blocked" })).payload.error)
    .toBe("guidance_required");
  const before = workspace.instance.store.logSize();
  const catalog = await empty.ok("get_help");
  expect(await workspace.ok("get_help")).toEqual(catalog);

  // Any accidental access is a hard failure, even if it would read a cached
  // replica successfully. An unreachable hub and an unread briefing are real.
  const spies = ["settle", "refresh", "directory", "settings", "sidebar", "replica"] as const;
  for (const rig of [empty, workspace]) {
    for (const method of spies) {
      vi.spyOn(rig.instance.replicas, method).mockImplementation(() => {
        throw new Error(`Static help must not access replicas.${method}`);
      });
    }
  }
  expect(await workspace.ok("get_help")).toEqual(catalog);
  for (const { id, uri } of catalog.topics) {
    const help = await empty.ok("get_help", { topic: id });
    expect(await workspace.ok("get_help", { topic: id })).toEqual(help);
    expect(help.text).not.toContain(secret);
    expect(await workspace.client.readResource({ uri })).toEqual(await empty.client.readResource({ uri }));
  }
  for (const rig of [empty, workspace]) {
    for (const method of spies) expect(rig.instance.replicas[method]).not.toHaveBeenCalled();
  }
  expect(workspace.instance.store.logSize()).toBe(before);
});

it("keeps help readable after a persistence failure quarantines ordinary replica reads", async () => {
  const config = testConfig();
  const store = new FailingStore(config.databasePath, config.workspaceId);
  const rig = await local(config, store);
  const catalog = await rig.ok("get_help");
  const doc = await rig.ok("create_doc", { title: "Persistence fixture", description: "A refused write." });
  store.failing = true;
  expect((await rig.call("set_title", { uuid: doc.uuid, title: "Refused" })).payload.error)
    .toBe("persistence_failed");
  expect((await rig.call("get_doc", { uuid: doc.uuid })).payload.error).toBe("persistence_failed");
  expect(await rig.ok("get_help")).toEqual(catalog);
  for (const { id, uri } of catalog.topics) {
    const { text } = await rig.ok("get_help", { topic: id });
    expect((await rig.client.readResource({ uri })).contents[0]).toMatchObject({ text });
  }
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

it("documents the table mapping through both help routes and accepts its source as ordinary chart text", async () => {
  const rig = await local();
  const { text } = await rig.ok("get_help", { topic: "data" });
  const section = text.split("### Data tables\n")[1];
  const source = section?.match(/```json\n([\s\S]*?)\n```/)?.[1];
  expect(source).toBeDefined();
  expect(JSON.parse(source!)).toMatchObject({
    version: 1, type: "table", collection: "observations",
    columns: [
      { field: "day", label: "Day", format: "date" },
      { field: "count", label: "Count", format: "number", decimals: 0 },
      { field: "run_h", label: "Run time", format: "number", unit: "h", decimals: 1 },
      { field: "url", format: "link" },
    ],
    sort: { field: "day", direction: "desc" }, pageSize: 25,
  });
  const created = await rig.ok("create_doc", {
    title: "Help table example", description: "A synthetic help example.",
    blocks: [{ type: "chart", text: source }],
  });
  expect((await rig.ok("get_doc", { uuid: created.uuid })).blocks[0]).toMatchObject({ type: "chart", text: source });
  expect((await rig.client.readResource({ uri: "uberblick://help/data" })).contents[0]).toMatchObject({ text });
  const insertHelp = await rig.ok("get_help", { topic: "insert_block" });
  const constraints = insertHelp.text.split("## Constraints\n")[1]?.split("\n## ")[0];
  for (const guidance of [
    '"type":"table"', "one to thirty ordered columns", "text (default), number, date or link",
    "Only number accepts unit (a suffix) and decimals (an integer from zero to ten)",
    "sort (one column field, direction asc or desc)", "pageSize (one to one hundred, default twenty-five)",
    "Unknown mapping keys and options are invalid", "contain no record values",
  ]) expect(constraints, guidance).toContain(guidance);
  expect((await rig.client.readResource({ uri: "uberblick://help/insert_block" })).contents[0])
    .toMatchObject({ text: insertHelp.text });
});
