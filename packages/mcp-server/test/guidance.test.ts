import { afterEach, expect, it, vi } from "vitest";
import { createTagCatalogEntry } from "@uberblick/schema";
import { STARTUP_ORIENTATION } from "../src/help-topics.js";
import * as tagCatalog from "../src/tag-catalog.js";
import { removeTempDirs, startServer, testConfig } from "./helpers.js";
import type { Rig } from "./helpers.js";

const rigs: Rig[] = [];
async function local(config = testConfig()): Promise<Rig> {
  const rig = await startServer(config);
  rigs.push(rig);
  return rig;
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const rig of rigs.splice(0)) await rig.close();
  removeTempDirs();
});

it("advertises guidance from the local log once at startup, without adding resources or workspace-specific help", async () => {
  const config = testConfig();
  const writer = await local(config);
  const marker = createTagCatalogEntry(writer.instance.replicas.settings().doc, "guidance");
  const guide = await writer.ok("create_doc", {
    title: "Writing pages", description: "Not part of the startup pointer.", tags: [marker.id],
    blocks: [{ type: "paragraph", text: "Not injected into initialization." }],
  });
  expect(writer.client.getInstructions()).toBe(STARTUP_ORIENTATION);
  await writer.close();

  const reader = await local(config);
  const instructions = `${STARTUP_ORIENTATION}\n\nWorkspace guidance: before your first write, read the pages that apply to your change with \`get_doc\`: Writing pages (\`${guide.uuid}\`).`;
  expect(reader.client.getInstructions()).toBe(instructions);
  expect((await reader.ok("get_help", { topic: "orientation" })).text).toBe(STARTUP_ORIENTATION);
  expect((await reader.client.listResources()).resources.every(({ uri }) => uri.startsWith("uberblick://help/"))).toBe(true);
  expect((await reader.client.listResourceTemplates()).resourceTemplates.map(({ uriTemplate }) => uriTemplate))
    .toEqual(["uberblick://help/{topic}"]);
  await expect(reader.client.readResource({ uri: `uberblick://doc/${guide.uuid}` })).rejects.toMatchObject({ code: -32602 });
  await reader.ok("set_metadata", { uuid: guide.uuid, title: "Updated without reading" });
  expect(reader.client.getInstructions()).toBe(instructions);
  const before = reader.instance.store.logSize();
  await reader.ok("get_doc", { uuid: guide.uuid });
  expect(reader.instance.store.logSize()).toBe(before);
});

it("initializes successfully with plain orientation when building guidance pointers throws", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(tagCatalog, "activeTagCatalog").mockImplementationOnce(() => { throw new Error("local discovery failed"); });
  const rig = await local();
  expect(rig.client.getInstructions()).toBe(STARTUP_ORIENTATION);
  await rig.ok("create_doc", { title: "Still writable", description: "Startup fallback." });
});
