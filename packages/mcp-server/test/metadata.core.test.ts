/** Combined metadata writes retain the field rules and refuse before mutation. */
import { randomUUID } from "node:crypto";

import { docRev, EXAMPLE_TAGS, getDirectoryEntry, getDirectoryMap, getMetaMap, setCodeCheck, setLinks, setTldrOptOut, upsertDirectoryEntry } from "@uberblick/schema";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { directoryStub, readBlocks, removeTempDirs, startServer, testConfig } from "./core-helpers.js";
import type { Rig } from "./core-helpers.js";

const rigs: Rig[] = [];
const DESCRIPTION = "Metadata contract fixture.";
const AUTH = { ...EXAMPLE_TAGS[0] };
const MCP = { ...EXAMPLE_TAGS[2] };
const COMMIT = "33086e02eb66f2e32dcce67a21c6c8ece9cf9ae4";
const CHECK = { repository: "uberblick-ai/uberblick-2", commit: COMMIT, result: "matches" } as const;

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
    ...(read.discussion === undefined ? {} : { discussion: read.discussion }),
    ...(read.code_check === undefined ? {} : { code_check: read.code_check }),
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
  vi.useRealTimers();
});
afterAll(removeTempDirs);

describe("set_metadata", () => {
  it.each(["regular", "decision"])("returns the shared page revision for %s documents and every content edit", async (kind) => {
    const rig = await localRig();
    const source = await document(rig, {
      ...(kind === "decision" ? { kind, status: "open" } : {}),
      blocks: [{ type: "paragraph", text: "first" }, { type: "paragraph", text: "second" }],
    });
    const ydoc = rig.instance.replicas.replica(source.uuid).doc;
    let read = await rig.ok("get_doc", { uuid: source.uuid });
    expect(read.rev).toBe(docRev(ydoc));
    expect(read.rev).toMatch(/^[0-9a-f]{16}$/);
    for (const original of await readBlocks(rig, source.uuid, source.blocks)) {
      await rig.ok("edit_block", {
        uuid: source.uuid, block_id: original.id, old_text: original.text,
        new_text: `${original.text} edited`, rev: original.rev,
      });
      const edited = await rig.ok("get_doc", { uuid: source.uuid });
      expect(edited.rev).toBe(docRev(ydoc));
      expect(edited.rev).not.toBe(read.rev);
      read = edited;
    }
    await rig.ok("set_metadata", { uuid: source.uuid, title: "A different title", description: "Changed metadata." });
    expect((await rig.ok("get_doc", { uuid: source.uuid })).rev).toBe(read.rev);
  });

  it("refuses missing and stale check revisions atomically and requires a fresh comparison", async () => {
    const rig = await localRig();
    const source = await document(rig);
    const original = await rig.ok("get_doc", { uuid: source.uuid });
    await rig.ok("edit_block", {
      uuid: source.uuid, block_id: original.blocks[0].id, old_text: original.blocks[0].text,
      new_text: "The page changed after it was compared.", rev: original.blocks[0].rev,
    });
    for (const code_check of [CHECK, { ...CHECK, rev: original.rev }]) {
      const refused = await refuseUnchanged(rig, {
        uuid: source.uuid, title: "Must not change", tags: [MCP.id], code_check,
      }, "invalid_code_check", source.uuid);
      expect(refused).toMatchObject({ field: "code_check", recoveryClass: "manual" });
      expect(refused.recovery).toMatch(/get_doc/);
      expect(refused.recovery).toMatch(/compar/i);
    }
    const reread = await rig.ok("get_doc", { uuid: source.uuid });
    const written = await rig.ok("set_metadata", {
      uuid: source.uuid, code_check: { ...CHECK, rev: reread.rev },
    });
    expect(written.code_check).toEqual([{ ...CHECK, rev: reread.rev, checked_at: expect.any(String) }]);
  });

  it("validates path hints before any write and accepts their count and length boundaries", async () => {
    const rig = await localRig();
    const source = await document(rig);
    const { rev } = await rig.ok("get_doc", { uuid: source.uuid });
    for (const paths of [
      null, "packages/schema/", [], [""], [17], Array.from({ length: 21 }, (_, index) => `file-${index}`),
      ["x".repeat(201)], ["/absolute"], [".."], ["../parent"], ["packages/../parent"], ["packages/.."],
      ...["*", "?", "[", "]", "{", "}"].map((glob) => [`packages/${glob}name`]),
    ]) {
      const refused = await refuseUnchanged(rig, {
        uuid: source.uuid, title: "Must not change", code_check: { ...CHECK, rev, paths },
      }, "invalid_code_check", source.uuid);
      expect(refused.field).toBe("code_check");
    }
    const paths = ["x".repeat(200), ...Array.from({ length: 19 }, (_, index) => `packages/folder-${index}/`)];
    const written = await rig.ok("set_metadata", { uuid: source.uuid, code_check: { ...CHECK, rev, paths } });
    expect(written.code_check[0].paths).toEqual(paths);
    expect((await rig.ok("get_doc", { uuid: source.uuid })).code_check).toEqual(written.code_check);
    expect(directoryStub(rig.instance, source.uuid)?.code_check).toEqual(written.code_check);
  });

  it("publishes check changes confined to paths or revision in the next directory listing", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.UTC(2031, 0, 1));
    const rig = await localRig();
    const source = await document(rig);
    let read = await rig.ok("get_doc", { uuid: source.uuid });
    const first = await rig.ok("set_metadata", { uuid: source.uuid, code_check: { ...CHECK, rev: read.rev } });
    const paths = ["packages/schema/"];
    const withPaths = await rig.ok("set_metadata", {
      uuid: source.uuid, code_check: { ...CHECK, rev: read.rev, paths },
    });
    expect(withPaths.code_check).toEqual([{ ...first.code_check[0], paths }]);
    expect(directoryStub(rig.instance, source.uuid)?.code_check)
      .toEqual(withPaths.code_check);
    await rig.ok("edit_block", {
      uuid: source.uuid, block_id: read.blocks[0].id, old_text: read.blocks[0].text,
      new_text: "Changed page revision only.", rev: read.blocks[0].rev,
    });
    read = await rig.ok("get_doc", { uuid: source.uuid });
    const withRev = await rig.ok("set_metadata", {
      uuid: source.uuid, code_check: { ...CHECK, rev: read.rev, paths },
    });
    expect(withRev.code_check).toEqual([{ ...withPaths.code_check[0], rev: read.rev }]);
    expect(withRev.code_check[0].rev).not.toBe(withPaths.code_check[0].rev);
    expect(directoryStub(rig.instance, source.uuid)?.code_check)
      .toEqual(withRev.code_check);
  });

  it("returns legacy checks and tolerates older replicas dropping revision and path extensions", async () => {
    const rig = await localRig();
    const source = await document(rig);
    const ydoc = rig.instance.replicas.replica(source.uuid).doc;
    setCodeCheck(ydoc, CHECK);
    const legacy = getMetaMap(ydoc).get(`code-check:${CHECK.repository}`);
    expect((await rig.ok("get_doc", { uuid: source.uuid })).code_check).toEqual([legacy]);
    expect(directoryStub(rig.instance, source.uuid)?.code_check)
      .toEqual([legacy]);
    const { rev } = await rig.ok("get_doc", { uuid: source.uuid });
    const written = await rig.ok("set_metadata", {
      uuid: source.uuid, code_check: { ...CHECK, rev, paths: ["packages/schema/"] },
    });
    await rig.instance.replicas.settle();
    const { rev: _rev, paths: _paths, ...oldEntry } = written.code_check[0];
    const directory = rig.instance.replicas.directory().doc;
    const map = getDirectoryMap(directory);
    map.set(source.uuid, { ...map.get(source.uuid) as Record<string, unknown>, code_check: [oldEntry] });
    expect(directoryStub(rig.instance, source.uuid)?.code_check)
      .toEqual([oldEntry]);
    getMetaMap(ydoc).set(`code-check:${CHECK.repository}`, oldEntry);
    expect((await rig.ok("get_doc", { uuid: source.uuid })).code_check).toEqual([oldEntry]);
    expect(directoryStub(rig.instance, source.uuid)?.code_check)
      .toEqual([oldEntry]);
  });

  it("records UTC checks, replaces case-insensitive repository entries and preserves other checks and content", async () => {
    const rig = await localRig();
    const source = await document(rig);
    const initial = await rig.ok("get_doc", { uuid: source.uuid });
    expect(initial).toHaveProperty("code_check", []);
    const check = { ...CHECK, rev: initial.rev, paths: ["packages/schema/", "packages/schema/src/doc.ts"] };
    const beforeExport = await rig.ok("export_markdown", { uuid: source.uuid });
    const before = Date.now();
    const first = await rig.ok("set_metadata", {
      uuid: source.uuid,
      code_check: { ...check, repository: "Uberblick-AI/Uberblick-2", commit: COMMIT.toUpperCase(), paths: [...check.paths, check.paths[0]] },
    });
    expect(first.code_check).toEqual([{ ...check, checked_at: expect.any(String) }]);
    const firstTime = first.code_check[0].checked_at;
    expect(new Date(firstTime).toISOString()).toBe(firstTime);
    expect(Date.parse(firstTime)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(firstTime)).toBeLessThanOrEqual(Date.now());

    const second = await rig.ok("set_metadata", {
      uuid: source.uuid,
      code_check: { ...check, repository: "uberblick-ai/ub-agents", result: "ahead" },
    });
    const other = second.code_check.find((entry: any) => entry.repository === "uberblick-ai/ub-agents");
    const replaced = await rig.ok("set_metadata", {
      uuid: source.uuid,
      code_check: { ...check, repository: "UBERBLICK-AI/UBERBLICK-2", commit: "a".repeat(64), result: "drift" },
    });
    expect(replaced.code_check).toEqual([
      other,
      { ...check, commit: "a".repeat(64), result: "drift", checked_at: expect.any(String) },
    ]);
    const read = await rig.ok("get_doc", { uuid: source.uuid });
    expect(read.code_check).toEqual(replaced.code_check);
    expect(read.blocks).toMatchObject(source.blocks);
    expect(await rig.ok("export_markdown", { uuid: source.uuid })).toEqual(beforeExport);
    expect(directoryStub(rig.instance, source.uuid)?.code_check)
      .toEqual(replaced.code_check);
    expect((await rig.ok("search", { query: "aardvark" })).hits[0]).not.toHaveProperty("code_check");
  });

  it("leaves checks unchanged through metadata and block edits and out of Markdown and block content", async () => {
    const rig = await localRig();
    const source = await document(rig);
    const { rev } = await rig.ok("get_doc", { uuid: source.uuid });
    const written = await rig.ok("set_metadata", { uuid: source.uuid, code_check: { ...CHECK, rev } });
    await rig.ok("set_metadata", {
      uuid: source.uuid, title: "Renamed page", description: "Changed descriptive fields.",
      tldr: "A summary.", tags: [MCP.id], links: [],
    });
    const [original] = await readBlocks(rig, source.uuid, source.blocks);
    await rig.ok("edit_block", {
      uuid: source.uuid, block_id: original.id, old_text: original.text,
      new_text: "Changed content", rev: original.rev,
    });
    const inserted = await rig.ok("insert_block", { uuid: source.uuid, blocks: [{ type: "paragraph", text: "Temporary block" }] });
    await rig.ok("delete_block", { uuid: source.uuid, block_id: inserted.blocks[0].id });
    const read = await rig.ok("get_doc", { uuid: source.uuid });
    expect(read.code_check).toEqual(written.code_check);
    expect(read.blocks).toEqual([expect.objectContaining({ text: "Changed content" })]);
    expect(JSON.stringify(read.blocks)).not.toContain("code_check");
    const exported = await rig.ok("export_markdown", { uuid: source.uuid });
    expect(exported.markdown).not.toContain("code_check");
    expect(exported.markdown).not.toContain(COMMIT);
    expect(directoryStub(rig.instance, source.uuid)?.code_check)
      .toEqual(written.code_check);
  });

  it("keeps checks out of listings, caches them on stubs without opening rooms, and repairs a dropped cache on a write", async () => {
    const rig = await localRig();
    const source = await document(rig);
    const uuid = randomUUID();
    const cached = { ...CHECK, checked_at: "2026-10-16T12:00:00.000Z" };
    const unknown = randomUUID();
    const directory = rig.instance.replicas.directory().doc;
    upsertDirectoryEntry(directory, { uuid, title: "Cached elsewhere", code_check: [cached] });
    upsertDirectoryEntry(directory, { uuid: unknown, title: "Not cached yet" });
    await rig.instance.replicas.settle();
    const opening = vi.spyOn(rig.instance.replicas, "replica");
    const listing = await rig.ok("list_docs");
    for (const entry of listing.docs) expect(entry).not.toHaveProperty("code_check");
    expect(listing.docs.map((entry: any) => entry.uuid)).toEqual(expect.arrayContaining([uuid, unknown, source.uuid]));
    expect(opening).not.toHaveBeenCalled();
    expect(directoryStub(rig.instance, uuid)).toHaveProperty("code_check", [cached]);
    expect(directoryStub(rig.instance, unknown)).not.toHaveProperty("code_check");
    expect(directoryStub(rig.instance, source.uuid)).toHaveProperty("code_check", []);
    opening.mockRestore();
    expect(rig.instance.replicas.hydrated(uuid)).toBe(false);
    expect(rig.instance.replicas.hydrated(unknown)).toBe(false);

    const { rev } = await rig.ok("get_doc", { uuid: source.uuid });
    const written = await rig.ok("set_metadata", { uuid: source.uuid, code_check: { ...CHECK, rev } });
    await rig.instance.replicas.settle();
    const map = getDirectoryMap(directory);
    const { code_check: _cache, ...oldClient } = map.get(source.uuid) as Record<string, unknown>;
    map.set(source.uuid, oldClient);
    expect(getDirectoryEntry(directory, source.uuid)).not.toHaveProperty("code_check");
    await rig.ok("set_metadata", { uuid: source.uuid, description: "An authored change repairs the cache." });
    expect(directoryStub(rig.instance, source.uuid)?.code_check)
      .toEqual(written.code_check);
  });

  it("names malformed checks and decision writes without changing any field, room or index", async () => {
    const rig = await localRig();
    const source = await document(rig);
    const { rev } = await rig.ok("get_doc", { uuid: source.uuid });
    const check = { ...CHECK, rev };
    for (const code_check of [
      null, [], "matches", {},
      { ...check, repository: "https://github.com/uberblick-ai/uberblick-2" },
      { ...check, repository: "owner/repo/extra" },
      { ...check, repository: 17 },
      { ...check, commit: "33086e0" },
      { ...check, commit: "z".repeat(40) },
      { ...check, commit: 17 },
      { ...check, result: "aligned" },
      { ...check, result: null },
      { ...check, checked_at: "2026-10-16T12:00:00.000Z" },
    ]) {
      const refused = await refuseUnchanged(rig, {
        uuid: source.uuid, title: "Must not change", tags: [MCP.id], code_check,
      }, "invalid_code_check", source.uuid);
      expect(refused).toMatchObject({ field: "code_check", recoveryClass: "manual" });
    }
    for (const status of ["open", "decided", "rejected", "withdrawn"]) {
      const decision = await document(rig, { kind: "decision", status: status === "decided" ? "decided" : "open" });
      if (status === "rejected") {
        await rig.ok("set_status", {
          uuid: decision.uuid, status,
          reason: "Another proposal was chosen.",
          answer: { who: "A maintainer", when: "2026-10-16T12:00:00Z", where: "A discussion." },
        });
      } else if (status === "withdrawn") await rig.ok("set_status", { uuid: decision.uuid, status });
      const decisionRead = await rig.ok("get_doc", { uuid: decision.uuid });
      const refused = await refuseUnchanged(rig, {
        uuid: decision.uuid, title: "Must not change", tags: [MCP.id], code_check: { ...check, rev: decisionRead.rev },
      }, "decision_code_check_unsupported", decision.uuid);
      expect(refused).toMatchObject({ field: "code_check", kind: "decision", status });
      expect(await rig.ok("get_doc", { uuid: decision.uuid })).not.toHaveProperty("code_check");
    }
    const decisions = (await rig.ok("list_docs", { kind: "decision", include_superseded: true })).docs;
    for (const entry of decisions) expect(entry).not.toHaveProperty("code_check");
    const refused = await refuseUnchanged(rig, {
      uuid: source.uuid, code_check: check, tags: ["missing-metadata-tag"],
    }, "invalid_tag_assignment", source.uuid);
    expect(refused.field).toBe("tags");
    expect(await rig.ok("get_doc", { uuid: source.uuid })).toHaveProperty("code_check", []);
  });

  it("refuses a deliberate TL;DR replacement before changing any metadata, room or index", async () => {
    const rig = await localRig();
    const target = await document(rig, { title: "Curated target" });
    const source = await document(rig);
    setTldrOptOut(rig.instance.replicas.replica(source.uuid).doc, true);

    for (const optIn of [undefined, false]) {
      const refused = await refuseUnchanged(rig, {
        uuid: source.uuid,
        title: "Refused rename",
        description: "Refused description.",
        tldr: "Refused summary.",
        ...(optIn === undefined ? {} : { tldr_opt_in: optIn }),
        tags: [AUTH.id],
        links: [target.uuid],
      }, "tldr_opted_out", source.uuid);
      expect(refused).toMatchObject({
        field: "tldr",
        message: "A person removed this page's TL;DR on purpose.",
        recoveryClass: "manual",
      });
      expect(refused.recovery).toContain("tldr_opt_in: true");
    }
    expect(await rig.ok("get_doc", { uuid: source.uuid })).toMatchObject({ tldr: null, tldrOptOut: true });

    const beforeUpdates = rig.instance.store.updateCount(rig.instance.replicas.replica(source.uuid).room);
    const written = await rig.ok("set_metadata", {
      uuid: source.uuid, title: "Accepted rename", tldr: "  Opted back in.  ", tldr_opt_in: true,
      tags: [AUTH.id], links: [target.uuid],
    });
    expect(written).toMatchObject({ title: "Accepted rename", tldr: "Opted back in.", applied: true });
    expect(written).not.toHaveProperty("tldrOptOut");
    expect((await rig.ok("get_doc", { uuid: source.uuid }))).not.toHaveProperty("tldrOptOut");
    expect(rig.instance.store.updateCount(rig.instance.replicas.replica(source.uuid).room)).toBe(beforeUpdates + 1);
  });

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
    expect(read.blocks).toMatchObject(source.blocks);
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
    // Updating declared fields preserves stored changelog metadata.
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

  it("refuses each locked decision field atomically but accepts descriptive metadata", async () => {
    const rig = await localRig();
    const target = await document(rig, { title: "Decision reference" });
    const decided = await document(rig, { kind: "decision", status: "decided" });
    const before = await rig.ok("get_doc", { uuid: decided.uuid });
    for (const [field, value] of [["tldr", null], ["discussion", null]] as const) {
      const refused = await refuseUnchanged(rig, {
        uuid: decided.uuid,
        title: "Must stay unchanged",
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
    const renamed = await rig.ok("set_metadata", { uuid: decided.uuid, title: "Reworded topic" });
    expect(metadata(renamed)).toEqual({ ...metadata(before), title: "Reworded topic" });
    const allowed = await rig.ok("set_metadata", {
      uuid: decided.uuid,
      title: "Updated topic question",
      description: "Updated decision discovery copy.",
      tags: [MCP.name],
      links: [target.uuid],
    });
    const read = await rig.ok("get_doc", { uuid: decided.uuid });
    expect(metadata(allowed)).toEqual(metadata(read));
    expect(read).toMatchObject({
      title: "Updated topic question",
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
    expect(tags).toMatchObject({ field: "tags", unknown: ["missing-metadata-tag"] });
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
      { discussion: null },
      { code_check: CHECK },
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
