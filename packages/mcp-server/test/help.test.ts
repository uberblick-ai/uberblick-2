import { randomUUID } from "node:crypto";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import { createTagCatalogEntry, setTags } from "@uberblick/schema";
import { afterEach, expect, it, vi } from "vitest";
import { FAILURE_INSTRUCTIONS } from "../src/failures.js";
import { GUIDANCE_INSTRUCTIONS } from "../src/briefing.js";
import { HelpCatalog } from "../src/help.js";
import { log } from "../src/log.js";
import { INTERNAL_RESOURCE_ERROR_MESSAGE } from "../src/resource-adapter.js";
import { FailingStore, removeTempDirs, startServer, TEST_SECRET, testConfig, toolNamed } from "./helpers.js";
import type { Rig } from "./helpers.js";

const concepts = ["orientation", "workspaces", "lifecycle", "markdown", "ablauf", "data", "tools", "tool-contracts"];
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

it("points Markdown authors to Ablauf help and requires checking edits in the web editor", () => {
  const help = new HelpCatalog();
  const markdown = help.read("markdown").text;
  expect(markdown).toContain("[Ablauf diagrams](uberblick://help/ablauf)");
  expect(markdown).not.toContain("github.com/uberblick-ai/ablauf");
  const ablauf = help.read("ablauf").text.replace(/\s+/g, " ");
  expect(ablauf).toContain("After every edit, check the drawing in the web editor.");
  expect(ablauf).toContain("MCP does not return the renderer's diagnostics");
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
  const uri = `uberblick://help/${topic}`;
  await expect(rig.client.readResource({ uri })).rejects.toMatchObject({
    code: -32002, data: { uri }, message: `MCP error -32002: MCP error -32002: Resource not found: ${uri}`,
  });
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
    const { details } = toolNamed(tool.name);
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

it("creates and re-indents list items using the published help examples", async () => {
  const rig = await local();
  const createHelp = await rig.ok("get_help", { topic: "create_doc" });
  const created = await rig.ok("create_doc", jsonSection(createHelp.text, "Example"));
  const seed = (await rig.ok("get_doc", { uuid: created.uuid })).blocks[0];
  expect(seed).toMatchObject({ type: "list-item", list: "ordered", indent: 0 });

  const insertHelp = await rig.ok("get_help", { topic: "insert_block" });
  const inserted = await rig.ok("insert_block", {
    ...jsonSection(insertHelp.text, "Example"), uuid: created.uuid, after_block_id: seed.id,
  });
  expect(inserted.blocks[0]).toMatchObject({ type: "list-item", list: "ordered", indent: 2 });

  const editHelp = await rig.ok("get_help", { topic: "edit_block" });
  const edited = await rig.ok("edit_block", {
    ...jsonSection(editHelp.text, "Example"), uuid: created.uuid,
    block_id: inserted.blocks[0].id, rev: inserted.blocks[0].rev,
  });
  expect(edited.block).toMatchObject({
    id: inserted.blocks[0].id, text: inserted.blocks[0].text, list: "ordered", indent: 1,
  });
  expect(edited.block.rev).not.toBe(inserted.blocks[0].rev);
  expect((await rig.ok("get_doc", { uuid: created.uuid })).blocks).toEqual([seed, edited.block]);
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
    "Before you change anything in this repo, consult the corpus and its decision records for relevant documents: " +
    "use `search` with a query or tags. If the request conflicts with a decision in force, ask before building. " +
    "Document tools operate on your selected workspace: discover with `get_sidebar`, " +
    "`list_docs` or `search`, then read with `get_doc` before editing. Use returned text " +
    "and rev for block edits. Structured data has dedicated tools and can supply document " +
    "views. Discover version-matched product help through MCP resources, or call " +
    "`get_help(topic)`, for concepts, lifecycle, supported Markdown syntax and tool usage. " +
    "Built-in help is workspace-agnostic; workspace conventions are ordinary documents, " +
    "not initialization instructions or help resources. Follow recovery guidance on failures.";
  expect(instructions.replace(/\s+/g, " ")).toContain(corpusOrientation);
  expect(instructions.length).toBeLessThanOrEqual(1_200);
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
