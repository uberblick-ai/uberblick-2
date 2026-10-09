/** Combined metadata writes retain the field rules and refuse before mutation. */

import { randomUUID } from "node:crypto";
import {
  EXAMPLE_TAGS,
  getDirectoryEntry,
  getMetaMap,
  setLinks,
  upsertDirectoryEntry,
} from "@uberblick/schema";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { removeTempDirs, startServer, testConfig } from "./helpers.js";
import type { Rig } from "./helpers.js";

const rigs: Rig[] = [];
const DESCRIPTION = "Metadata contract fixture.";
const AUTH = { ...EXAMPLE_TAGS[0], state: "active" };
const MCP = { ...EXAMPLE_TAGS[2], state: "active" };

async function localRig(): Promise<Rig> {
  const rig = await startServer(testConfig());
  rigs.push(rig);
  return rig;
}

async function document(rig: Rig, fields: Record<string, unknown> = {}) {
  return rig.ok("create_doc", {
    title: "Metadata fixture",
    description: DESCRIPTION,
    blocks: [{ type: "paragraph", text: "metadata aardvark" }],
    ...fields,
  });
}

/** Exactly the read-back fields set_metadata promises, including absent values. */
function metadata(read: any) {
  return {
    uuid: read.uuid,
    title: read.title,
    description: read.description,
    tldr: read.tldr,
    tags: read.tags,
    links: read.links,
  };
}

/** Both authoritative rooms and the durable log must survive a refusal intact. */
function state(rig: Rig, uuid?: string) {
  return {
    directory: Y.encodeStateAsUpdate(rig.instance.replicas.directory().doc),
    ...(uuid === undefined
      ? {}
      : { document: Y.encodeStateAsUpdate(rig.instance.replicas.replica(uuid).doc) }),
    log: rig.instance.store.logSize(),
    index: rig.instance.store.search("aardvark", 10),
  };
}

async function refuseUnchanged(
  rig: Rig,
  args: Record<string, unknown>,
  error: string,
  uuid?: string,
) {
  const before = state(rig, uuid);
  const refused = await rig.call("set_metadata", args);
  expect(refused.isError).toBe(true);
  expect(refused.payload).toMatchObject({
    error,
    applied: false,
    partial: false,
    synced: false,
  });
  expect(state(rig, uuid)).toEqual(before);
  return refused.payload;
}

afterEach(async () => {
  for (const rig of rigs.splice(0)) await rig.close();
});
afterAll(removeTempDirs);

describe("set_metadata", () => {
  it("writes all five fields in one document and directory update, with complete read-back and discovery follow-up", async () => {
    const rig = await localRig();
    const target = await document(rig, { title: "Curated target" });
    const source = await document(rig, { title: "Before", tags: [AUTH.id] });
    const replica = rig.instance.replicas.replica(source.uuid);
    const directory = rig.instance.replicas.directory();
    const beforeDocument = rig.instance.store.updateCount(replica.room);
    const beforeDirectory = rig.instance.store.updateCount(directory.room);
    let documentUpdates = 0;
    let directoryUpdates = 0;
    replica.doc.on("update", () => { documentUpdates += 1; });
    directory.doc.on("update", () => { directoryUpdates += 1; });

    const written = await rig.ok("set_metadata", {
      uuid: source.uuid,
      title: "  Renamed raptor  ",
      description: "  Discovery narwhal.  ",
      tldr: "  A concise person-facing summary.  ",
      tags: [MCP.name],
      links: [target.uuid],
    });

    expect(written).toMatchObject({
      uuid: source.uuid,
      title: "Renamed raptor",
      description: "Discovery narwhal.",
      tldr: "A concise person-facing summary.",
      tags: [MCP],
      links: [target.uuid],
      applied: true,
      synced: false,
      hub: { status: "disabled" },
    });
    expect(written).not.toHaveProperty("tldrHint");
    expect(documentUpdates).toBe(1);
    expect(directoryUpdates).toBe(1);
    expect(rig.instance.store.updateCount(replica.room)).toBe(beforeDocument + 1);
    expect(rig.instance.store.updateCount(directory.room)).toBe(beforeDirectory + 1);
    const read = await rig.ok("get_doc", { uuid: source.uuid });
    expect(metadata(written)).toEqual(metadata(read));
    expect(read.blocks).toEqual(source.blocks);
    expect(getDirectoryEntry(directory.doc, source.uuid)).toMatchObject({
      title: written.title,
      description: written.description,
      tags: [MCP.id],
    });
    const listed = await rig.ok("list_docs", { tag: MCP.name });
    expect(listed.docs).toEqual([
      expect.objectContaining({
        uuid: source.uuid,
        title: written.title,
        description: written.description,
        tags: written.tags,
      }),
    ]);
    const searched = await rig.ok("search", { query: "narwhal", tag: MCP.name });
    expect(searched.hits).toEqual([
      expect.objectContaining({ uuid: source.uuid, title: written.title, description: written.description }),
    ]);
    expect((await rig.ok("backlinks", { uuid: target.uuid })).backlinks).toEqual([
      expect.objectContaining({ uuid: source.uuid, title: written.title, description: written.description }),
    ]);
    expect((await rig.ok("search", { query: "aardvark", tag: AUTH.name })).hits)
      .not.toContainEqual(expect.objectContaining({ uuid: source.uuid }));
  });

  it("returns every current field for a subset, preserves unnamed fields and clears only with the declared values", async () => {
    const rig = await localRig();
    const target = await document(rig, { title: "Linked target" });
    const source = await document(rig, { tags: [AUTH.id] });
    await rig.ok("set_metadata", {
      uuid: source.uuid,
      tldr: "Keep this summary.",
      links: [target.uuid],
    });
    // Stored changelog metadata belongs to a separate issue and is not changed
    // by replacing the tool which used to write it.
    getMetaMap(rig.instance.replicas.replica(source.uuid).doc)
      .set("changelogSuggestion", "Keep this existing suggestion.");
    const before = await rig.ok("get_doc", { uuid: source.uuid });
    const renamed = await rig.ok("set_metadata", { uuid: source.uuid, title: "Only title changes" });
    const after = await rig.ok("get_doc", { uuid: source.uuid });
    expect(metadata(renamed)).toEqual({ ...metadata(before), title: "Only title changes" });
    expect(metadata(renamed)).toEqual(metadata(after));
    expect(after.changelogSuggestion).toBe(before.changelogSuggestion);
    expect(renamed).not.toHaveProperty("tldrHint");

    const cleared = await rig.ok("set_metadata", { uuid: source.uuid, tldr: null, tags: [], links: [] });
    expect(metadata(cleared)).toEqual({
      ...metadata(after),
      tldr: null,
      tags: [],
      links: [],
    });
    expect(metadata(cleared)).toEqual(metadata(await rig.ok("get_doc", { uuid: source.uuid })));
    expect(getMetaMap(rig.instance.replicas.replica(source.uuid).doc).get("tldr")).toBeNull();
    expect(cleared).not.toHaveProperty("tldrHint");
    expect((await rig.ok("backlinks", { uuid: target.uuid })).backlinks).toEqual([]);
    expect((await rig.ok("search", { query: "aardvark", tag: AUTH.name })).hits)
      .not.toContainEqual(expect.objectContaining({ uuid: source.uuid }));
  });

  it("advertises and enforces a non-empty strict subset before any mutation", async () => {
    const rig = await localRig();
    const source = await document(rig);
    const { tools } = await rig.client.listTools();
    const schema = tools.find(({ name }) => name === "set_metadata")?.inputSchema as any;
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(["uuid"]);
    expect(schema.anyOf).toEqual([
      { required: ["title"] },
      { required: ["description"] },
      { required: ["tldr"] },
      { required: ["tags"] },
      { required: ["links"] },
    ]);
    const before = state(rig, source.uuid);
    const empty = await rig.call("set_metadata", { uuid: source.uuid });
    expect(empty.payload.error).toBe("schema_validation");
    for (const [field, value] of [
      ["changelog_suggestion", "Unsupported suggestion"],
      ["titel", "Misspelled title"],
    ] as const) {
      const refused = await rig.call("set_metadata", {
        uuid: source.uuid,
        description: "This valid field must not be written.",
        [field]: value,
      });
      expect(refused.isError).toBe(true);
      expect(refused.payload.error).toBe("schema_validation");
      expect(refused.payload.message).toContain(field);
    }
    // A bad named field must also stop individually valid fields at the input
    // boundary. The exhaustive limits remain in the existing field suites.
    for (const field of ["title", "description"]) {
      for (const value of ["", "   ", null]) {
        const refused = await rig.call("set_metadata", {
          uuid: source.uuid,
          tldr: "Must not be written.",
          [field]: value,
        });
        expect(refused.isError).toBe(true);
        expect(refused.payload.error).toBe("schema_validation");
        expect(refused.payload.message).toContain(field);
      }
    }
    expect(state(rig, source.uuid)).toEqual(before);
  });

  it("refuses each locked decision field atomically but accepts descriptive metadata", async () => {
    const rig = await localRig();
    const target = await document(rig, { title: "Decision reference" });
    const decided = await document(rig, { kind: "decision", status: "decided" });
    const before = await rig.ok("get_doc", { uuid: decided.uuid });
    for (const [field, value] of [["title", "Refused rename"], ["tldr", null]] as const) {
      const refused = await refuseUnchanged(rig, {
        uuid: decided.uuid,
        description: "An otherwise valid description.",
        tags: [MCP.name],
        links: [target.uuid],
        [field]: value,
      }, "decision_read_only", decided.uuid);
      expect(refused).toMatchObject({
        field,
        uuid: decided.uuid,
        kind: "decision",
        status: "decided",
      });
      expect(await rig.ok("get_doc", { uuid: decided.uuid })).toEqual(before);
    }
    const allowed = await rig.ok("set_metadata", {
      uuid: decided.uuid,
      description: "Updated decision discovery copy.",
      tags: [MCP.name],
      links: [target.uuid],
    });
    const read = await rig.ok("get_doc", { uuid: decided.uuid });
    expect(metadata(allowed)).toEqual(metadata(read));
    expect(read).toMatchObject({
      title: before.title,
      tldr: before.tldr,
      description: "Updated decision discovery copy.",
      tags: [MCP],
      links: [target.uuid],
      status: "decided",
      approvalChanged: false,
    });
  });

  it("names invalid tags and unknown newly curated targets without changing accepted fields or the index", async () => {
    const rig = await localRig();
    const source = await document(rig, { tags: [AUTH.id] });
    const before = await rig.ok("get_doc", { uuid: source.uuid });
    const tags = await refuseUnchanged(rig, {
      uuid: source.uuid,
      title: "Must stay unchanged",
      description: "Must stay unchanged too.",
      tldr: "An otherwise valid summary.",
      tags: [MCP.name, "missing-metadata-tag"],
    }, "invalid_tag_assignment", source.uuid);
    expect(tags).toMatchObject({ field: "tags", unknown: ["missing-metadata-tag"], retired: [] });
    const unknown = randomUUID();
    const links = await refuseUnchanged(rig, {
      uuid: source.uuid,
      title: "Must stay unchanged",
      description: "Must stay unchanged too.",
      tldr: "An otherwise valid summary.",
      tags: [MCP.name],
      links: [unknown],
    }, "doclink_target_not_known_locally", source.uuid);
    expect(links).toMatchObject({ field: "links", docId: unknown, inDirectory: false, hub: { status: "disabled" } });
    expect(await rig.ok("get_doc", { uuid: source.uuid })).toEqual(before);
  });

  it("accepts an archived target and preserves an already curated target absent from the directory", async () => {
    const rig = await localRig();
    const archived = await document(rig, { title: "Archived target" });
    await rig.ok("archive_doc", { uuid: archived.uuid });
    const source = await document(rig);
    const unknown = randomUUID();
    // A link received from a client with a larger directory stays preservable;
    // only targets introduced by this call need local lookup.
    setLinks(rig.instance.replicas.replica(source.uuid).doc, [unknown]);
    const written = await rig.ok("set_metadata", {
      uuid: source.uuid,
      description: "Existing and archived references are acceptable.",
      links: [unknown, archived.uuid],
    });
    expect(written.links).toEqual([unknown, archived.uuid]);
    expect(metadata(written)).toEqual(metadata(await rig.ok("get_doc", { uuid: source.uuid })));
    await rig.ok("set_metadata", { uuid: source.uuid, links: [unknown, archived.uuid] });
    const cleared = await rig.ok("set_metadata", { uuid: source.uuid, links: [] });
    expect(cleared.links).toEqual([]);
  });

  it("returns effective decision links but does not treat a derived target as already curated", async () => {
    const rig = await localRig();
    const source = await document(rig, { kind: "decision" });
    const unknown = randomUUID();
    const meta = getMetaMap(rig.instance.replicas.replica(source.uuid).doc);
    // A decision delivered ahead of its governing target has an effective
    // edge, while its independently editable curated set is still empty.
    meta.set("governs", unknown);
    expect(meta.get("links")).toEqual([]);
    const described = await rig.ok("set_metadata", {
      uuid: source.uuid,
      description: "The target has not reached this directory yet.",
    });
    expect(described.links).toEqual([unknown]);
    expect(metadata(described)).toEqual(metadata(await rig.ok("get_doc", { uuid: source.uuid })));

    const refused = await refuseUnchanged(rig, {
      uuid: source.uuid,
      description: "This description must not be written.",
      links: described.links,
    }, "doclink_target_not_known_locally", source.uuid);
    expect(refused).toMatchObject({ field: "links", docId: unknown });
    expect(meta.get("links")).toEqual([]);
    const cleared = await rig.ok("set_metadata", { uuid: source.uuid, links: [] });
    expect(cleared.links).toEqual([unknown]);
    expect(metadata(cleared)).toEqual(metadata(await rig.ok("get_doc", { uuid: source.uuid })));
  });

  it("keeps document-level failures free of field details and refuses every archived subset", async () => {
    const rig = await localRig();
    const archived = await document(rig);
    await rig.ok("archive_doc", { uuid: archived.uuid });
    for (const args of [
      { title: "Archived title" },
      { description: "Archived description." },
      { tldr: null },
      { tags: [] },
      { links: [] },
      { title: "Archived title", description: "Archived description.", tldr: null, tags: [], links: [] },
    ]) {
      const refused = await refuseUnchanged(rig, { uuid: archived.uuid, ...args }, "doc_archived", archived.uuid);
      expect(refused).toMatchObject({ uuid: archived.uuid, archived: true });
      expect(refused).not.toHaveProperty("field");
    }

    const absent = randomUUID();
    const missing = await refuseUnchanged(rig, { uuid: absent, title: "No document" }, "doc_not_found");
    expect(missing).toMatchObject({ uuid: absent, inDirectory: false, hub: { status: "disabled" } });
    expect(missing).not.toHaveProperty("field");

    const unhydrated = randomUUID();
    upsertDirectoryEntry(rig.instance.replicas.directory().doc, { uuid: unhydrated, title: "Known elsewhere" });
    const waiting = await refuseUnchanged(rig, { uuid: unhydrated, description: "No local room." }, "doc_not_hydrated");
    expect(waiting).toMatchObject({ uuid: unhydrated, inDirectory: true, hub: { status: "disabled" } });
    expect(waiting).not.toHaveProperty("field");
  });
});
