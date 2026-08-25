/**
 * Archiving a document: what stops seeing it, what keeps seeing it, and what
 * comes back.
 *
 * The tombstone itself belongs to the schema package — that a tombstone is
 * sticky, and that restoring is the one thing that lifts it, are pinned in
 * `packages/schema/test/directory.test.ts`. What this suite defends is the tool
 * contract an agent actually relies on: archiving removes a document from
 * discovery and from search without touching a byte of it, and restoring is a
 * true reversal.
 */

import { afterAll, afterEach, describe, expect, it } from "vitest";
import { removeTempDirs, startServer, testConfig } from "./helpers.js";
import type { Rig } from "./helpers.js";

const rigs: Rig[] = [];

async function localRig(): Promise<Rig> {
  const rig = await startServer(testConfig());
  rigs.push(rig);
  return rig;
}

const BODY = "A glossary of the terms this system keeps using.";

async function seedDoc(rig: Rig): Promise<any> {
  return rig.ok("create_doc", {
    title: "Concepts",
    tags: ["reference"],
    blocks: [{ type: "paragraph", text: BODY }],
  });
}

afterEach(async () => {
  for (const rig of rigs.splice(0)) {
    await rig.close();
  }
});

afterAll(() => {
  removeTempDirs();
});

describe("archive_doc", () => {
  it("drops a document from discovery and search, and from nothing else", async () => {
    const rig = await localRig();
    const doc = await seedDoc(rig);

    const archived = await rig.ok("archive_doc", { uuid: doc.uuid });
    expect(archived).toMatchObject({
      uuid: doc.uuid,
      title: "Concepts",
      archived: true,
      applied: true,
    });
    // Durability is reported honestly rather than assumed: with no hub in this
    // rig the local write is applied and demonstrably not synced.
    expect(archived.synced).toBe(false);

    const listed = await rig.ok("list_docs");
    expect(listed.docs.map((entry: any) => entry.uuid)).not.toContain(doc.uuid);

    const withDeleted = await rig.ok("list_docs", { include_deleted: true });
    expect(
      withDeleted.docs.find((entry: any) => entry.uuid === doc.uuid),
    ).toEqual({
      uuid: doc.uuid,
      title: "Concepts",
      tags: ["reference"],
      deleted: true,
    });

    // Search reads the derived index, which a directory write does not itself
    // touch — so this is the assertion that the tool re-derives it.
    const hits = await rig.ok("search", { query: "glossary" });
    expect(hits.hits).toEqual([]);

    // The point of a tombstone: the document is hidden, not erased.
    const read = await rig.ok("get_doc", { uuid: doc.uuid });
    expect(read.title).toBe("Concepts");
    expect(read.blocks.map((block: any) => block.text)).toEqual([BODY]);
  });

  it("refuses a uuid the workspace has never heard of", async () => {
    const rig = await localRig();

    // Tombstoning a typo would publish a directory entry for a document that
    // never existed, and a tombstone is sticky.
    const refused = await rig.call("archive_doc", {
      uuid: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    });
    expect(refused.isError).toBe(true);
    expect(refused.payload.error).toBe("doc_not_found");
  });
});

describe("restore_doc", () => {
  it("reverses an archive, in discovery and in search alike", async () => {
    const rig = await localRig();
    const doc = await seedDoc(rig);
    await rig.ok("archive_doc", { uuid: doc.uuid });

    const restored = await rig.ok("restore_doc", { uuid: doc.uuid });
    expect(restored).toMatchObject({
      uuid: doc.uuid,
      title: "Concepts",
      archived: false,
      applied: true,
    });
    expect(restored.synced).toBe(false);

    const listed = await rig.ok("list_docs");
    expect(listed.docs.find((entry: any) => entry.uuid === doc.uuid)).toEqual({
      uuid: doc.uuid,
      title: "Concepts",
      tags: ["reference"],
    });

    const hits = await rig.ok("search", { query: "glossary" });
    expect(hits.hits.map((hit: any) => hit.uuid)).toEqual([doc.uuid]);
  });
});
