/** The MCP server's read-only, catalog-aware tag boundary. */
import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  EXAMPLE_TAGS, createTagCatalogEntry, deleteTagCatalogEntry, getDirectoryEntry,
  getMeta, setTags, settingsRoom, setTagCatalogDescription, tombstoneDecisionRecord,
} from "@uberblick/schema";
import { cleanupTestResources, startServer, testConfig, WORKSPACE } from "./core-helpers.js";
import type { Rig } from "./core-helpers.js";

const rigs: Rig[] = [];
const AUTH = EXAMPLE_TAGS[0];
const MCP = EXAMPLE_TAGS[2];
const OFF_CATALOG = "3f5c0b1e-6f6a-4a2b-9c1d-0e7a5b3c9d21";

async function local(): Promise<Rig> {
  const rig = await startServer(testConfig());
  rigs.push(rig);
  return rig;
}

afterEach(async () => {
  await cleanupTestResources({ clients: rigs.splice(0).map((rig) => () => rig.close()) });
});

describe("the workspace tag catalog", () => {
  it("includes descriptions in every structured projection and names only in Markdown", async () => {
    const rig = await local();
    setTagCatalogDescription(rig.instance.replicas.settings().doc, AUTH.id, "Authentication work");
    const auth = { ...AUTH, description: "Authentication work" };
    expect((await rig.ok("list_tags")).tags).toContainEqual(auth);
    const created = await rig.ok("create_doc", {
      title: "Catalog contract", description: "Catalog projections.", tags: ["MCP", AUTH.id, "AUTH"],
      blocks: [{ type: "paragraph", text: "catalog capybara" }],
    });
    expect(created.tags).toEqual([auth, MCP]);
    expect((await rig.ok("get_doc", { uuid: created.uuid })).tags).toEqual([auth, MCP]);
    for (const tag of ["AUTH", AUTH.id]) {
      expect((await rig.ok("list_docs", { tag })).docs)
        .toEqual([expect.objectContaining({ uuid: created.uuid, tags: [auth, MCP] })]);
      expect((await rig.ok("search", { query: "capybara", tag })).hits)
        .toEqual([expect.objectContaining({ uuid: created.uuid, tags: [auth, MCP] })]);
    }
    const exported = await rig.ok("export_markdown", { uuid: created.uuid });
    expect(exported.markdown).toContain("tags: [auth, mcp]");
    expect(exported.markdown).not.toContain("Authentication work");
    expect(exported.markdown).not.toContain(AUTH.id);
  });

  it("reindexes converged aliases without rewriting the document", async () => {
    const rig = await local();
    const mine = "ffffffff-0000-4000-8000-000000000001";
    const theirs = "11111111-0000-4000-8000-000000000001";
    createTagCatalogEntry(rig.instance.replicas.settings().doc, "collision", mine);
    const created = await rig.ok("create_doc", {
      title: "Converging identities", description: "A catalog identity arrives separately.", tags: [mine],
      blocks: [{ type: "paragraph", text: "collision aardvark" }],
    });
    const doc = rig.instance.replicas.replica(created.uuid).doc;
    const before = Y.encodeStateAsUpdate(doc);
    const peer = new Y.Doc();
    createTagCatalogEntry(peer, "collision", theirs);
    rig.instance.store.appendUpdate(settingsRoom(WORKSPACE), Y.encodeStateAsUpdate(peer), "remote");
    peer.destroy();
    for (const tag of ["COLLISION", mine, theirs]) {
      expect((await rig.ok("search", { query: "aardvark", tag })).hits)
        .toEqual([expect.objectContaining({ uuid: created.uuid, tags: [{ id: theirs, name: "collision" }] })]);
    }
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
  });

  it("hides deleted and delayed references on reads without changing stored assignments", async () => {
    const rig = await local();
    const created = await rig.ok("create_doc", {
      title: "Hidden references", description: "Read paths preserve stored references.", tags: [AUTH.id, MCP.id],
      blocks: [{ type: "paragraph", text: "hidden wombat" }],
    });
    const doc = rig.instance.replicas.replica(created.uuid).doc;
    setTags(doc, [AUTH.id, MCP.id, OFF_CATALOG]);
    const before = Y.encodeStateAsUpdate(doc);
    deleteTagCatalogEntry(rig.instance.replicas.settings().doc, AUTH.id);
    expect((await rig.ok("get_doc", { uuid: created.uuid })).tags).toEqual([MCP]);
    expect((await rig.ok("list_docs")).docs[0].tags).toEqual([MCP]);
    expect((await rig.ok("search", { query: "wombat" })).hits[0].tags).toEqual([MCP]);
    expect((await rig.ok("export_markdown", { uuid: created.uuid })).markdown).toContain("tags: [mcp]");
    rig.instance.replicas.rebuildIndex();
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    expect(getMeta(doc).tags).toEqual([AUTH.id, MCP.id, OFF_CATALOG]);
    for (const tag of [AUTH.id, "auth", "AUTH", OFF_CATALOG]) {
      expect((await rig.call("list_docs", { tag })).payload)
        .toMatchObject({ error: "invalid_tag_assignment", unknown: [tag] });
      expect((await rig.call("search", { query: "wombat", tag })).payload)
        .toMatchObject({ error: "invalid_tag_assignment", unknown: [tag] });
    }
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    createTagCatalogEntry(rig.instance.replicas.settings().doc, "delayed", OFF_CATALOG);
    expect((await rig.ok("get_doc", { uuid: created.uuid })).tags).toEqual([MCP, { id: OFF_CATALOG, name: "delayed" }]);
  });

  it("whole-set writes replace existing assignments and preserve delayed identities, even with an empty set", async () => {
    const rig = await local();
    const created = await rig.ok("create_doc", { title: "Keeper", description: "Whole-set write.", tags: [AUTH.id] });
    const doc = rig.instance.replicas.replica(created.uuid).doc;
    setTags(doc, [AUTH.id, OFF_CATALOG, "provisional-name"]);
    deleteTagCatalogEntry(rig.instance.replicas.settings().doc, AUTH.id);
    expect((await rig.ok("set_metadata", { uuid: created.uuid, tags: ["MCP"] })).tags).toEqual([MCP]);
    expect(getMeta(doc).tags).toEqual([MCP.id, OFF_CATALOG]);
    expect((await rig.ok("set_metadata", { uuid: created.uuid, tags: [] })).tags).toEqual([]);
    expect(getMeta(doc).tags).toEqual([OFF_CATALOG]);
    createTagCatalogEntry(rig.instance.replicas.settings().doc, "delayed", OFF_CATALOG);
    expect((await rig.ok("get_doc", { uuid: created.uuid })).tags).toEqual([{ id: OFF_CATALOG, name: "delayed" }]);
  });

  it("invalid tags refuse all metadata and creation atomically, including an already-stored unknown identity", async () => {
    const rig = await local();
    const created = await rig.ok("create_doc", { title: "Atomic target", description: "A refused write changes nothing.", tags: [AUTH.id] });
    const doc = rig.instance.replicas.replica(created.uuid).doc;
    setTags(doc, [AUTH.id, OFF_CATALOG]);
    deleteTagCatalogEntry(rig.instance.replicas.settings().doc, AUTH.id);
    const before = Y.encodeStateAsUpdate(doc);
    const beforeStub = getDirectoryEntry(rig.instance.replicas.directory().doc, created.uuid);
    const selectors = ["missing", AUTH.id, "AUTH", OFF_CATALOG, " mcp "];
    const refused = await rig.call("set_metadata", { uuid: created.uuid, title: "Must not change", tags: selectors });
    expect(refused.payload).toMatchObject({ error: "invalid_tag_assignment", field: "tags", unknown: selectors, applied: false, partial: false });
    expect(refused.payload.recovery).toContain("list_tags");
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    expect(getDirectoryEntry(rig.instance.replicas.directory().doc, created.uuid)).toEqual(beforeStub);
    const beforeList = (await rig.ok("list_docs")).docs;
    expect((await rig.call("create_doc", { title: "Must not exist", description: "Refused creation.", tags: selectors })).payload)
      .toMatchObject({ error: "invalid_tag_assignment", unknown: selectors, applied: false });
    expect((await rig.ok("list_docs")).docs).toEqual(beforeList);
  });

  it("cleans deleted references only after a successful document write and respects archive and content locks", async () => {
    const rig = await local();
    const created = await rig.ok("create_doc", {
      title: "Write boundary", description: "Cleanup belongs to authored writes.", tags: [AUTH.id],
      blocks: [{ type: "paragraph", text: "Original content" }],
    });
    const doc = rig.instance.replicas.replica(created.uuid).doc;
    setTags(doc, [AUTH.id, OFF_CATALOG]);
    deleteTagCatalogEntry(rig.instance.replicas.settings().doc, AUTH.id);
    const before = Y.encodeStateAsUpdate(doc);
    expect((await rig.call("edit_block", { uuid: created.uuid, block_id: "missing", old_text: "", new_text: "refused" })).isError).toBe(true);
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    await rig.ok("archive_doc", { uuid: created.uuid });
    expect((await rig.call("set_metadata", { uuid: created.uuid, title: "Refused" })).payload.error).toBe("doc_archived");
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    await rig.ok("restore_doc", { uuid: created.uuid });
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    await rig.ok("insert_block", { uuid: created.uuid, blocks: [{ type: "paragraph", text: "Authored content" }] });
    expect(getMeta(doc).tags).toEqual([OFF_CATALOG]);

    const decision = await rig.ok("create_doc", { title: "Locked", description: "Decided answer.", kind: "decision", status: "decided", tags: [MCP.id], blocks: [{ type: "paragraph", text: "Answer" }] });
    const locked = rig.instance.replicas.replica(decision.uuid).doc;
    deleteTagCatalogEntry(rig.instance.replicas.settings().doc, MCP.id);
    const lockedBefore = Y.encodeStateAsUpdate(locked);
    expect((await rig.call("insert_block", { uuid: decision.uuid, blocks: [{ type: "paragraph", text: "Refused" }] })).payload.error).toBe("decision_read_only");
    expect(Y.encodeStateAsUpdate(locked)).toEqual(lockedBefore);
    await rig.ok("set_metadata", { uuid: decision.uuid, description: "Permitted metadata." });
    expect(getMeta(locked).tags).toEqual([]);
  });

  it("does not clean deleted references during replayed or locally repaired changes", async () => {
    const rig = await local();
    const created = await rig.ok("create_doc", { title: "Remote writer", description: "A sync update cannot authorize cleanup.", tags: [AUTH.id] });
    const replica = rig.instance.replicas.replica(created.uuid);
    deleteTagCatalogEntry(rig.instance.replicas.settings().doc, AUTH.id);
    const peer = new Y.Doc();
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(replica.doc));
    peer.getMap("meta").set("title", "Synced title");
    rig.instance.store.appendUpdate(replica.room, Y.encodeStateAsUpdate(peer), "remote");
    peer.destroy();
    expect((await rig.ok("get_doc", { uuid: created.uuid })).tags).toEqual([]);
    expect(getMeta(replica.doc).tags).toEqual([AUTH.id]);
    await rig.ok("set_metadata", { uuid: created.uuid, description: "A later permitted write." });
    expect(getMeta(replica.doc).tags).toEqual([]);
  });

  it("keeps an archived first record's assignments when a live successor renames its topic", async () => {
    const rig = await local();
    const first = await rig.ok("create_doc", { title: "Topic", description: "First record.", kind: "decision", tags: [AUTH.id] });
    const next = await rig.ok("create_doc", { description: "Live successor.", kind: "decision", supersedes: first.uuid });
    expect(tombstoneDecisionRecord(rig.instance.replicas.directory().doc, first.uuid)).toBe(true);
    deleteTagCatalogEntry(rig.instance.replicas.settings().doc, AUTH.id);
    await rig.ok("set_metadata", { uuid: next.uuid, title: "Renamed topic" });
    expect(getMeta(rig.instance.replicas.replica(first.uuid).doc).tags).toEqual([AUTH.id]);
  });
});
