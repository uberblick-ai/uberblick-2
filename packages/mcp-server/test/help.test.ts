import { randomUUID } from "node:crypto";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import { createTagCatalogEntry, setTags, validateCollectionSchema } from "@uberblick/schema";
import { afterEach, expect, it, vi } from "vitest";
import { FAILURE_INSTRUCTIONS, READ_ONLY_TOOLS } from "../src/failures.js";
import { GUIDANCE_INSTRUCTIONS } from "../src/briefing.js";
import { toolHelpEntries } from "../src/help-examples.js";
import { HelpCatalog } from "../src/help.js";
import { log } from "../src/log.js";
import { INTERNAL_RESOURCE_ERROR_MESSAGE } from "../src/resource-adapter.js";
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
  expect(topics.find(({ id }: { id: string }) => id === "lifecycle")?.description)
    .toContain("when to create decision records");
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
    expect(help.text, id).not.toMatch(/set_(title|description|tldr|tags|links|changelog_suggestion)\b/);
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
    code: -32002, data: { uri }, message: `MCP error -32002: MCP error -32002: Resource not found: ${uri}`,
  });
});

it("documents only regular pages and decision lifecycle values in product help", async () => {
  const rig = await local();
  const { topics } = await rig.ok("get_help");
  const lifecycle = topics.find((topic: { id: string }) => topic.id === "lifecycle");
  expect(lifecycle.description).not.toMatch(/requirement/i);
  for (const topic of ["lifecycle", "create_doc", "get_doc", "list_docs", "set_status", "set_metadata", "markdown", "export_markdown"]) {
    const { text } = await rig.ok("get_help", { topic });
    expect(text, topic).not.toMatch(/requirement|\bplanned\b|\bimplementing\b|\bdone\b/i);
    expect(text, topic).not.toMatch(/`draft`|"draft"/);
  }
  expect((await rig.ok("get_help", { topic: "markdown" })).text).toContain("decision log of any regular page");
});

it.each(["list", "read"] as const)("contains an unexpected help resource %s failure and logs its original cause", async (route) => {
  const rig = await local();
  const cause = new Error("Private database path: /private/workspace.sqlite; SELECT secret FROM records");
  const reported = vi.spyOn(log, "error");
  const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(HelpCatalog.prototype, route === "list" ? "list" : "get").mockImplementation(() => {
    throw cause;
  });

  const response = route === "list"
    ? rig.client.listResources()
    : rig.client.readResource({ uri: "uberblick://help/orientation" });
  await expect(response).rejects.toMatchObject({
    code: -32603,
    message: `MCP error -32603: ${INTERNAL_RESOURCE_ERROR_MESSAGE}`,
    data: undefined,
  });
  expect(reported).toHaveBeenCalledWith("resource call failed", cause);
  expect(stderr).toHaveBeenCalledWith(expect.stringContaining(cause.stack!));
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
    ["set_metadata", "workspaces"], ["get_sidebar", "workspaces"],
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

it("describes short decision answers, page context and previews without repository authority", async () => {
  const rig = await local();
  const { tools } = await rig.client.listTools();
  for (const topic of ["lifecycle", "create_doc", "get_doc", "list_docs", "set_metadata", "update_data"]) {
    const { text } = await rig.ok("get_help", { topic });
    for (const rule of ["answer blocks", "brief reason", "related", "linked", "answerPreview", "RFC"]) {
      expect(text, `${topic}: ${rule}`).toContain(rule);
    }
    expect(text, topic).not.toMatch(/decision line|boundary table|owner's recorded GitHub decision|reasons and guidance/);
    const description = tools.find((tool) => tool.name === topic)?.description;
    if (description !== undefined) {
      for (const rule of ["related", "linked", "answerPreview"]) expect(description, topic).toContain(rule);
      expect(description, topic).not.toMatch(/decision line|boundary table|governs requires/);
    }
  }
  const lifecycle = (await rig.ok("get_help", { topic: "lifecycle" })).text;
  for (const code of [
    "decision_block_unsupported", "decision_answer_too_long", "decision_answer_empty",
    "decision_tldr_unsupported", "decision_data_unsupported", "related_not_regular_document",
  ]) expect(lifecycle, code).toContain(code);
  expect(lifecycle).toContain("answer: {who, when, where}");
  expect(lifecycle).toContain("missing preview is unknown");
});

it("explains deliberate TL;DR removal and explicit opt-in in help and field contracts", async () => {
  const rig = await local();
  const { tools } = await rig.client.listTools();
  const getDoc = tools.find(tool => tool.name === "get_doc")!;
  const setMetadata = tools.find(tool => tool.name === "set_metadata")!;
  const mark = (getDoc.outputSchema as any).properties.tldrOptOut;
  expect(mark).toMatchObject({ type: "boolean", const: true });
  expect(mark.description).toContain("on purpose");
  expect(mark.description).toContain("tldr_opt_in: true");
  expect((setMetadata.inputSchema as any).properties.tldr_opt_in.description).toContain("non-null tldr");
  for (const topic of ["workspaces", "get_doc", "set_metadata"]) {
    const { text } = await rig.ok("get_help", { topic });
    expect(text, topic).toContain("tldrOptOut");
    expect(text, topic).toContain("tldr_opt_in: true");
    expect(text, topic).toContain("non-null");
  }
  const { text } = await rig.ok("get_help", { topic: "set_metadata" });
  expect(text).toContain("tldr_opted_out");
  expect(text).toContain("field: \"tldr\"");
  expect(text).toContain("MCP cannot set that mark");
});

it("explains explicit RFC connections, open-only corrections and cached discussion reads", async () => {
  const rig = await local();
  const lifecycle = (await rig.ok("get_help", { topic: "lifecycle" })).text;
  for (const rule of [
    "Create or reuse the RFC first as an ordinary regular document",
    "ordinary `rfc` tag that can be applied deliberately", "no tool requires it",
    "open first record with `related` and `discussion`", "no answer until one is recorded",
    "open successor with `supersedes` and `discussion`", "current answer stays in force",
    "A successor never inherits its predecessor's discussion",
    "`discussion: null`", "fixed once the record leaves `open`",
    "Settle, reject or withdraw with `set_status`", "recorded-answer contract",
    "discussion_not_regular_document", "discussion_not_writable",
    "never creates a document, tags or edits the RFC or related page",
    "or changes `approvalFingerprint` or `approvalChanged`",
    "A null discussion means no reference", "missing value means the cache is unknown",
    "backlinks on an RFC finds its connected records", "unless the RFC is also its related page",
  ]) expect(lifecycle, rule).toContain(rule);

  const { tools } = await rig.client.listTools();
  for (const topic of ["create_doc", "set_metadata", "get_doc", "list_docs"]) {
    const { text } = await rig.ok("get_help", { topic });
    const constraints = text.split("## Constraints\n")[1]?.split("\n## ")[0];
    for (const rule of ["discussion", "RFC", "curated links", "recorded answer"]) {
      expect(constraints, `${topic}: ${rule}`).toContain(rule);
      expect(tools.find((tool) => tool.name === topic)?.description, `${topic}: ${rule}`).toContain(rule);
    }
  }
  for (const topic of ["create_doc", "set_metadata"]) {
    const { text } = await rig.ok("get_help", { topic });
    for (const rule of ["discussion_not_regular_document", "doc_archived", "doc_not_found", "doc_not_hydrated"]) {
      expect(text, `${topic}: ${rule}`).toContain(rule);
    }
  }
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

it("advertises the server identity and instructions in initialize", async () => {
  const rig = await local();
  expect({
    serverInfo: rig.client.getServerVersion(),
    instructions: rig.client.getInstructions(),
  }).toMatchInlineSnapshot({ instructions: expect.any(String) }, `
    {
      "instructions": Any<String>,
      "serverInfo": {
        "name": "uberblick",
        "title": "Uberblick",
        "version": "0.0.0",
        "websiteUrl": "https://github.com/uberblick-ai/uberblick-2",
      },
    }
  `);
  expect(rig.client.getInstructions()?.trim()).toBeTruthy();
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
  expect((await workspace.call("set_metadata", { uuid: doc.uuid, title: "Blocked" })).payload.error)
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
  expect((await rig.call("set_metadata", { uuid: doc.uuid, title: "Refused" })).payload.error)
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
    sort: { field: "day", direction: "desc" },
  });
  expect(JSON.parse(source!)).not.toHaveProperty("pageSize");
  expect(section).toContain("Without limit, every valid record appears in one continuous native table");
  expect(section).toContain("Generated from document data · read-only");
  expect(section).toContain("never affect display; omit pageSize from new mappings");
  expect(section).not.toContain("Page controls");
  expect(section).not.toContain("paging stays available");
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
    "sort (one column field, direction asc or desc)", "supplies only the table's accessible name",
    "Without limit, every valid record appears in one continuous native table", "Generated from document data · read-only",
    "Open table source appears on hover or keyboard focus and stays reachable without hover",
    "Unknown mapping keys and options are invalid", "contain no record values",
  ]) expect(constraints, guidance).toContain(guidance);
  const insertSource = constraints?.match(/`(\{"version":1,"type":"table"[^`]+)`/)?.[1];
  expect(insertSource).toBeDefined();
  expect(JSON.parse(insertSource!)).not.toHaveProperty("pageSize");
  expect((await rig.client.readResource({ uri: "uberblick://help/insert_block" })).contents[0])
    .toMatchObject({ text: insertHelp.text });
});

it("documents optional record limits for both views through data and insert_block help", async () => {
  const rig = await local();
  for (const topic of ["data", "insert_block"]) {
    const { text } = await rig.ok("get_help", { topic });
    for (const guidance of [
      "Optional limit is an integer of 1 or more",
      "selects the latest N records with a valid x in x-then-record-id order, still at most 5,000",
      "shows only the first N valid rows in sort order (record-id order without sort)",
      "limit has no upper bound of its own", "Records hidden by the author limit are not omissions",
      "no pager or page state", "footnote includes shown and total valid-record counts",
      "when it hides nothing, no count appears", "notice and diagnostics when N exceeds 5,000",
    ]) expect(text, `${topic}: ${guidance}`).toContain(guidance);
    expect((await rig.client.readResource({ uri: `uberblick://help/${topic}` })).contents[0])
      .toMatchObject({ text });
  }
});

it("documents opt-in line panels through data and insert_block help", async () => {
  const rig = await local();
  for (const topic of ["data", "insert_block"]) {
    const { text } = await rig.ok("get_help", { topic });
    for (const guidance of [
      "Optional layout is overlay or panels, default overlay",
      "panels draws one compact line chart per y series in mapping order, in a responsive grid",
      "each panel shows its label and latest plotted value",
      "Panels share the x range and share y ranges within each unit group",
      "layout is invalid for table mappings",
    ]) expect(text, `${topic}: ${guidance}`).toContain(guidance);
    expect((await rig.client.readResource({ uri: `uberblick://help/${topic}` })).contents[0])
      .toMatchObject({ text });
  }
});
