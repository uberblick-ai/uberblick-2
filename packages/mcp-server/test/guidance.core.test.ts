import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { createTagCatalogEntry, deleteTagCatalogEntry, tombstoneDirectoryEntry, upsertDirectoryEntry } from "@uberblick/schema";
import { STARTUP_ORIENTATION } from "../src/help-topics.js";
import { startupInstructions } from "../src/startup-instructions.js";
import { tools } from "../src/tool-table.js";
import { removeTempDirs, startServer } from "./core-helpers.js";
import type { Rig } from "./core-helpers.js";

const rigs: Rig[] = [];
const marker = "5a7808ea-1c79-4330-af35-3f67f9f38a3b";
async function local(): Promise<Rig> {
  const rig = await startServer();
  rigs.push(rig);
  return rig;
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const rig of rigs.splice(0)) await rig.close();
  removeTempDirs();
});

it("selects only the ten most recently updated live guidance pointers from local directory stubs", async () => {
  const rig = await local();
  const { replicas } = rig.instance;
  createTagCatalogEntry(replicas.settings().doc, "guidance", marker);
  const directory = replicas.directory().doc;
  const documents = Array.from({ length: 12 }, (_, index) => ({
    uuid: randomUUID(), title: `Guide ${index}`, tags: [marker], updatedAt: 100 + index,
    description: "Do not inject this description.",
  }));
  for (const entry of documents) upsertDirectoryEntry(directory, entry);
  const archived = randomUUID();
  upsertDirectoryEntry(directory, { uuid: archived, title: "Archived guide", tags: [marker], updatedAt: 1000 });
  tombstoneDirectoryEntry(directory, archived);
  upsertDirectoryEntry(directory, { uuid: randomUUID(), title: "Other page", tags: [], updatedAt: 2000 });

  // Any hydration, refresh or settle would make this lookup depend on more than local stubs.
  for (const method of ["replica", "refresh", "settle"] as const) {
    vi.spyOn(replicas, method).mockImplementation(() => { throw new Error(`Unexpected ${method}`); });
  }
  const pointers = documents.slice(2).reverse().map(({ title, uuid }) => `${title} (\`${uuid}\`)`).join(", ");
  expect(startupInstructions(replicas)).toBe(`${STARTUP_ORIENTATION}\n\nWorkspace guidance: before your first write, read the pages that apply to your change with \`get_doc\`: ${pointers}.`);
  for (const method of ["replica", "refresh", "settle"] as const) expect(replicas[method]).not.toHaveBeenCalled();
});

it("keeps the plain orientation for an empty replica, absent or deleted tag, and archived guidance", async () => {
  const rig = await local();
  const { replicas } = rig.instance;
  expect(startupInstructions(replicas)).toBe(STARTUP_ORIENTATION);
  const uuid = randomUUID();
  upsertDirectoryEntry(replicas.directory().doc, { uuid, title: "Guide", tags: [marker] });
  expect(startupInstructions(replicas)).toBe(STARTUP_ORIENTATION);
  createTagCatalogEntry(replicas.settings().doc, "guidance", marker);
  expect(startupInstructions(replicas)).toContain(uuid);
  deleteTagCatalogEntry(replicas.settings().doc, marker);
  expect(startupInstructions(replicas)).toBe(STARTUP_ORIENTATION);
  const replacement = createTagCatalogEntry(replicas.settings().doc, "guidance");
  upsertDirectoryEntry(replicas.directory().doc, { uuid, title: "Guide", tags: [replacement.id] });
  tombstoneDirectoryEntry(replicas.directory().doc, uuid);
  expect(startupInstructions(replicas)).toBe(STARTUP_ORIENTATION);
});

it("falls back to the plain orientation when local guidance discovery fails", async () => {
  const rig = await local();
  const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(rig.instance.replicas, "settings").mockImplementation(() => { throw new Error("local catalog unavailable"); });
  expect(startupInstructions(rig.instance.replicas)).toBe(STARTUP_ORIENTATION);
  expect(stderr.mock.calls.flat().join("\n")).toContain("could not build the startup guidance pointers");
});

it("allows every document mutation while guidance remains unread", async () => {
  const rig = await local();
  const guide = await rig.ok("create_doc", {
    title: "Unread guidance", description: "Do not require this read.",
  });
  createTagCatalogEntry(rig.instance.replicas.settings().doc, "guidance", marker);
  await rig.ok("set_metadata", { uuid: guide.uuid, tags: [marker] });
  const target = await rig.ok("create_doc", {
    title: "Target", description: "Mutable fixture.", blocks: [
      { type: "paragraph", text: "First paragraph." }, { type: "paragraph", text: "Second paragraph." },
    ],
  });
  const { uuid } = target;
  const block = target.blocks[0];
  const called = new Set(["create_doc", "set_metadata"]);
  const write = async (name: string, args: Record<string, unknown>) => {
    expect(await rig.ok(name, args), name).toMatchObject({ applied: true });
    called.add(name);
  };
  await write("link_range", { uuid, block_id: block.id, start: 0, end: 5, doc_id: guide.uuid, rev: block.rev });
  await write("annotate", { uuid, block_id: target.blocks[1].id, start: 0, end: 6, text: "Comment" });
  await write("edit_block", { uuid, block_id: block.id, old_text: block.text, new_text: "Changed paragraph.", rev: block.rev });
  await write("insert_block", { uuid, blocks: [{ type: "paragraph", text: "Third paragraph." }] });
  await write("move_block", { uuid, block_ids: [block.id], after_block_id: target.blocks[1].id });
  await write("delete_block", { uuid, block_id: block.id });
  await write("update_data", { uuid, operations: [{ collection: "notes", schema: { version: 1, schema: { type: "object" } } }] });
  // This local-only fixture reaches naming's hub requirement without a guidance gate;
  // revision-tools covers successful naming against a team hub.
  expect(await rig.call("name_revision", { uuid, name: "Reviewed" })).toMatchObject({ isError: true,
    payload: { error: "revisions_local_only", applied: false, partial: false, synced: false } });
  called.add("name_revision");
  const decision = await rig.ok("create_doc", { title: "A question", description: "Open proposal.", kind: "decision", status: "open" });
  await write("set_status", { uuid: decision.uuid, status: "withdrawn" });
  await write("archive_doc", { uuid });
  await write("restore_doc", { uuid });
  await rig.ok("archive_doc", { uuid });
  await write("delete_doc", { uuid });
  expect([...called].sort()).toEqual(tools.filter(({ writes }) => writes === "document").map(({ name }) => name).sort());
});
