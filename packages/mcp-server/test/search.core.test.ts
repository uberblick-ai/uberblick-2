/** The shared matching rules and MCP search's catalog, kind and state contract. */
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { EXAMPLE_TAGS, getDirectoryEntry, getMetaMap, upsertDirectoryEntry } from "@uberblick/schema";
import { outputSchemas } from "../src/outputs.js";
import { removeTempDirs, startServer, testConfig } from "./core-helpers.js";
import type { Rig } from "./core-helpers.js";

const rigs: Rig[] = [];
const answer = { who: "A person", when: "2026-10-04T12:00:00Z", where: "A recorded team discussion." };
const blocks = [{ type: "paragraph", text: "Use the current recorded policy." }];

async function localRig(): Promise<Rig> {
  const rig = await startServer(testConfig());
  rigs.push(rig);
  return rig;
}

async function hits(rig: Rig, query: string): Promise<string[]> {
  const found = await rig.ok("search", { query });
  return found.hits.map((hit: { title: string }) => hit.title);
}

afterEach(async () => {
  for (const rig of rigs.splice(0)) await rig.close();
});
afterAll(removeTempDirs);

describe("search", () => {
  it("matches any word, English forms, accents, prefixes and underscore adjacency", async () => {
    const rig = await localRig();
    for (const [title, description, text] of [
      ["Presence", "How a client announces itself.", "Launching and launched clients withdraw."],
      ["Awareness", "The peer list every client publishes.", "Names and colors travel with it."],
      ["Adjacent", "How to list docs from the directory.", ""],
      ["Separated", "How to list all kinds of docs from the directory.", ""],
      ["École", "An accented title.", ""],
      ["Worktree", "A workspace command.", ""],
    ]) {
      await rig.ok("create_doc", { title, description, blocks: [{ type: "paragraph", text }] });
    }
    expect((await hits(rig, "presence awareness")).sort()).toEqual(["Awareness", "Presence"]);
    expect(await hits(rig, "launch")).toEqual(["Presence"]);
    expect(await hits(rig, "ecole")).toEqual(["École"]);
    expect(await hits(rig, "work*")).toEqual(["Worktree"]);
    expect(await hits(rig, "list_docs")).toEqual(["Adjacent"]);
    expect(await hits(rig, "?!,; 🦦")).toEqual([]);
  });

  it("accepts tag lists by id or name, resolves every tag, and boosts distinct assignments", async () => {
    const rig = await localRig();
    const auth = EXAMPLE_TAGS[0]!;
    const mcp = EXAMPLE_TAGS[2]!;
    const first = await rig.ok("create_doc", { title: "Aardvark guide", description: "A fixture.", tags: [auth.id] });
    const both = await rig.ok("create_doc", { title: "Aardvark guide", description: "A fixture.", tags: [auth.id, mcp.id] });
    const other = await rig.ok("create_doc", { title: "Aardvark guide", description: "A fixture.", tags: [mcp.id] });
    await rig.ok("create_doc", { title: "Aardvark guide", description: "A fixture." });
    const tag = [auth.name, mcp.id, auth.id];
    const found = await rig.ok("search", { query: "aardvark", tag });
    expect(found.tag).toEqual(tag);
    expect(found.hits[0].uuid).toBe(both.uuid);
    expect(found.hits.map((hit: { uuid: string }) => hit.uuid).sort()).toEqual([first.uuid, both.uuid, other.uuid].sort());
    const single = await rig.ok("search", { query: "aardvark", tag: auth.name });
    expect(single.tag).toBe(auth.name);
    expect(single.hits.map((hit: { uuid: string }) => hit.uuid).sort()).toEqual([first.uuid, both.uuid].sort());
    const refused = await rig.call("search", { query: "aardvark", tag: [auth.name, "unknown-tag"] });
    expect(refused.isError).toBe(true);
    expect(refused.payload.error).toBe("invalid_tag_assignment");
    expect((await rig.call("search", { query: "aardvark", tag: [] })).isError).toBe(true);
  });

  it("filters kind before limit and labels stored requirements as regular", async () => {
    const rig = await localRig();
    const regular = await rig.ok("create_doc", { title: "Capybara", description: "A regular document." });
    const requirement = await rig.ok("create_doc", { title: "Capybara requirement", description: "A stored legacy requirement." });
    getMetaMap(rig.instance.replicas.replica(requirement.uuid).doc).set("kind", "requirement");
    const decision = await rig.ok("create_doc", { title: "Capybara decision", description: "A decision record.", kind: "decision" });
    const found = await rig.ok("search", { query: "capybara", kind: "decision", limit: 1 });
    expect(found).toMatchObject({ kind: "decision", hits: [{ uuid: decision.uuid, kind: "decision", state: "open" }] });
    const pages = await rig.ok("search", { query: "capybara", kind: "regular", limit: 100 });
    expect(pages.hits.map((hit: { uuid: string }) => hit.uuid).sort()).toEqual([regular.uuid, requirement.uuid].sort());
    for (const hit of pages.hits) {
      expect(hit.kind).toBe("regular");
      expect(hit).not.toHaveProperty("state");
    }
    expect((await rig.call("search", { query: "capybara", kind: "requirement" })).isError).toBe(true);
  });

  it("resolves current state without editing an indexed answer or hydrating new records", async () => {
    const rig = await localRig();
    const first = await rig.ok("create_doc", { title: "Wombat policy", description: "A decision record.", kind: "decision", status: "decided", blocks });
    const before = rig.instance.store.search("wombat", 100);
    expect((await rig.ok("search", { query: "wombat" })).hits[0]).toMatchObject({ uuid: first.uuid, state: "in-force" });
    const directory = rig.instance.replicas.directory().doc;
    const replacement = randomUUID();
    upsertDirectoryEntry(directory, { uuid: replacement, title: "Replacement", kind: "decision", status: "decided", topic: first.uuid, supersedes: first.uuid, tags: [] });
    expect((await rig.ok("search", { query: "wombat" })).hits[0]).toMatchObject({ uuid: first.uuid, state: "superseded" });
    expect(rig.instance.store.search("wombat", 100)).toEqual(before);
    expect(rig.instance.replicas.hydrated(replacement)).toBe(false);
    const sibling = randomUUID();
    upsertDirectoryEntry(directory, { uuid: sibling, title: "Conflict", kind: "decision", status: "decided", topic: first.uuid, tags: [] });
    const replacementStub = getDirectoryEntry(directory, replacement)!;
    upsertDirectoryEntry(directory, { ...replacementStub, supersedes: "" });
    expect((await rig.ok("search", { query: "wombat" })).hits[0]).toMatchObject({ uuid: first.uuid, state: "conflict" });
    expect(rig.instance.replicas.hydrated(sibling)).toBe(false);
  });

  it("includes every live decision lifecycle state and preserves archived exclusion", async () => {
    const rig = await localRig();
    const first = await rig.ok("create_doc", { title: "Otter policy", description: "A decision record.", kind: "decision", status: "decided", blocks });
    const decided = await rig.ok("create_doc", { title: "Otter policy", description: "An accepted replacement.", kind: "decision", supersedes: first.uuid, status: "decided", answer, blocks });
    const open = await rig.ok("create_doc", { title: "Otter policy", description: "An open proposal.", kind: "decision", supersedes: decided.uuid });
    const rejected = await rig.ok("create_doc", { title: "Otter policy", description: "A rejected proposal.", kind: "decision", supersedes: decided.uuid });
    await rig.ok("set_status", { uuid: rejected.uuid, status: "rejected", reason: "Keep the current answer.", answer });
    const withdrawn = await rig.ok("create_doc", { title: "Otter policy", description: "A withdrawn proposal.", kind: "decision", supersedes: decided.uuid });
    await rig.ok("set_status", { uuid: withdrawn.uuid, status: "withdrawn" });
    const found = await rig.ok("search", { query: "otter", kind: "decision" });
    expect(Object.fromEntries(found.hits.map((hit: { uuid: string; state: string }) => [hit.uuid, hit.state]))).toEqual({
      [first.uuid]: "superseded", [decided.uuid]: "in-force", [open.uuid]: "open", [rejected.uuid]: "rejected", [withdrawn.uuid]: "withdrawn",
    });
    await rig.ok("archive_doc", { uuid: first.uuid });
    expect((await rig.ok("search", { query: "otter", kind: "decision" })).hits).toEqual([]);
    await rig.ok("restore_doc", { uuid: first.uuid });
    expect((await rig.ok("search", { query: "otter", kind: "decision" })).hits).toHaveLength(5);
  });

  it("declares state as required only for decision hits", () => {
    const base = { uuid: randomUUID(), title: "Fixture", description: null, tags: [], snippet: "" };
    expect(outputSchemas.search.safeParse({ query: "fixture", hits: [{ ...base, kind: "regular" }] }).success).toBe(true);
    expect(outputSchemas.search.safeParse({ query: "fixture", hits: [{ ...base, kind: "decision", state: "conflict" }] }).success).toBe(true);
    expect(outputSchemas.search.safeParse({ query: "fixture", hits: [{ ...base, kind: "decision" }] }).success).toBe(false);
    expect(outputSchemas.search.safeParse({ query: "fixture", hits: [{ ...base, kind: "regular", state: "in-force" }] }).success).toBe(false);
  });
});
