/**
 * Inline document references, through the tools.
 *
 * The contract this suite defends: `text` and `rev` are exactly what they have
 * always been — plain and mark-blind — while the references a block carries are
 * additive alongside them; a label is display text resolved once, at the moment
 * the link is written; and a reference to a document this replica cannot
 * resolve is refused with nothing written, rather than persisted as a uuid
 * nothing answers to.
 */

import { randomUUID } from "node:crypto";
import { upsertDirectoryEntry } from "@uberblick/schema";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { removeTempDirs, startServer, testConfig } from "./helpers.js";
import type { Rig } from "./helpers.js";

const rigs: Rig[] = [];

async function localRig(): Promise<Rig> {
  const rig = await startServer(testConfig());
  rigs.push(rig);
  return rig;
}

const DESCRIPTION = "A test document.";

afterEach(async () => {
  for (const rig of rigs.splice(0)) {
    await rig.close();
  }
});

afterAll(() => {
  removeTempDirs();
});

describe("inline document references", () => {
  it("reports them on a read, leaving text and rev exactly as they were", async () => {
    const rig = await localRig();
    const target = await rig.ok("create_doc", {
      title: "Hub",
      description: DESCRIPTION,
    });
    const source = await rig.ok("create_doc", {
      title: "Source",
      description: DESCRIPTION,
      blocks: [
        { type: "paragraph", text: "See the hub docs" },
        { type: "code", text: "const x = 1;", language: "ts" },
      ],
    });

    const before = await rig.ok("get_doc", { uuid: source.uuid });
    const [prose, code] = before.blocks;
    // Absent, not empty: a block with no references carries no field at all.
    expect(prose.doc_links).toBeUndefined();

    const linked = await rig.ok("link_range", {
      uuid: source.uuid,
      block_id: prose.id,
      start: 4,
      end: 11,
      doc_id: target.uuid,
      rev: prose.rev,
    });
    expect(linked).toMatchObject({
      applied: true,
      docId: target.uuid,
      title: "Hub",
      // Unchanged by construction: a rev hashes text and attributes, never marks.
      rev: prose.rev,
    });

    const after = await rig.ok("get_doc", { uuid: source.uuid });
    expect(after.blocks[0]).toEqual({
      ...prose,
      doc_links: [{ start: 4, end: 11, docId: target.uuid }],
    });
    expect(after.blocks[1]).toEqual(code);
    expect(
      (await rig.ok("export_markdown", { uuid: source.uuid, frontmatter: false }))
        .markdown,
    ).toContain(`See [the hub](${target.uuid}) docs`);
  });

  it("honours inline runs on a write, and fills an empty label from the target", async () => {
    const rig = await localRig();
    const target = await rig.ok("create_doc", {
      title: "Hub",
      description: DESCRIPTION,
    });
    await rig.ok("set_metadata", { uuid: target.uuid, title: "The Hub" });
    // The stub is a cache and the document's own title is authoritative, so a
    // stale stub must not be what a label is resolved from.
    upsertDirectoryEntry(rig.instance.replicas.directory().doc, {
      uuid: target.uuid,
      title: "Stale stub title",
    });

    const created = await rig.ok("create_doc", {
      title: "Citing",
      description: DESCRIPTION,
      blocks: [
        {
          type: "paragraph",
          inline: [
            { text: "See ", marks: {} },
            { text: "", marks: { docLink: target.uuid } },
            { text: " for details", marks: {} },
          ],
        },
      ],
    });
    expect(created.blocks[0].text).toBe("See The Hub for details");
    expect(created.blocks[0].doc_links).toEqual([
      { start: 4, end: 11, docId: target.uuid },
    ]);

    // A label the caller wrote is kept, and a reference sits beside the other
    // marks rather than instead of them.
    await rig.ok("insert_block", {
      uuid: created.uuid,
      after_block_id: created.blocks[0].id,
      type: "paragraph",
      inline: [
        { text: "the hub itself", marks: { docLink: target.uuid, bold: true } },
      ],
    });
    const read = await rig.ok("get_doc", { uuid: created.uuid });
    expect(read.blocks[1].text).toBe("the hub itself");
    expect(read.blocks[1].doc_links).toEqual([
      { start: 0, end: 14, docId: target.uuid },
    ]);
  });

  it("takes a target in any case, and stores the one spelling", async () => {
    const rig = await localRig();
    const target = await rig.ok("create_doc", {
      title: "Hub",
      description: DESCRIPTION,
    });
    const shouted = target.uuid.toUpperCase();
    const source = await rig.ok("create_doc", {
      title: "Source",
      description: DESCRIPTION,
      blocks: [
        { type: "paragraph", text: "See the hub docs" },
        {
          type: "paragraph",
          inline: [{ text: "", marks: { docLink: shouted } }],
        },
      ],
    });

    // Upper-cased in, canonical out — of the resolution, the write and the
    // answer alike. A second spelling would be a second document to everything
    // that compares ids, starting with the room name.
    expect(source.blocks[1].text).toBe("Hub");
    expect(source.blocks[1].doc_links).toEqual([
      { start: 0, end: 3, docId: target.uuid },
    ]);

    const linked = await rig.ok("link_range", {
      uuid: source.uuid,
      block_id: source.blocks[0].id,
      start: 4,
      end: 11,
      doc_id: shouted,
      rev: source.blocks[0].rev,
    });
    expect(linked.docId).toBe(target.uuid);
    expect(linked.title).toBe("Hub");
    const read = await rig.ok("get_doc", { uuid: source.uuid });
    expect(read.blocks[0].doc_links).toEqual([
      { start: 4, end: 11, docId: target.uuid },
    ]);
    expect(
      (await rig.ok("backlinks", { uuid: target.uuid })).backlinks.map(
        (row: { uuid: string }) => row.uuid,
      ),
    ).toEqual([source.uuid]);
  });

  it("refuses a run that is both an external link and a reference, at the boundary", async () => {
    const rig = await localRig();
    const target = await rig.ok("create_doc", {
      title: "Hub",
      description: DESCRIPTION,
    });
    const doc = await rig.ok("create_doc", {
      title: "Citing",
      description: DESCRIPTION,
    });

    // Not a range conflict to re-read: the argument itself has no honest
    // meaning, so it never reaches a handler.
    const refused = await rig.call("insert_block", {
      uuid: doc.uuid,
      type: "paragraph",
      inline: [
        {
          text: "both at once",
          marks: { link: "https://example.com/hub", docLink: target.uuid },
        },
      ],
    });
    expect(refused.isError).toBe(true);
    expect(refused.payload.error).toBe("schema_validation");
    expect((await rig.ok("get_doc", { uuid: doc.uuid })).blocks).toEqual([]);
  });

  it("refuses a stale rev without inventing a text the caller never passed", async () => {
    const rig = await localRig();
    const target = await rig.ok("create_doc", {
      title: "Hub",
      description: DESCRIPTION,
    });
    const doc = await rig.ok("create_doc", {
      title: "Citing",
      description: DESCRIPTION,
      blocks: [{ type: "paragraph", text: "See the hub docs" }],
    });
    const block = doc.blocks[0];
    await rig.ok("edit_block", {
      uuid: doc.uuid,
      block_id: block.id,
      old_text: "See the hub docs",
      new_text: "See the hub document",
      rev: block.rev,
    });

    const refused = await rig.call("link_range", {
      uuid: doc.uuid,
      block_id: block.id,
      start: 4,
      end: 11,
      doc_id: target.uuid,
      rev: block.rev,
    });
    expect(refused.payload.error).toBe("stale_block");
    // A link asserts a rev and nothing else, so the answer says so rather than
    // reporting a text the caller never claimed.
    expect(refused.payload.expectedText).toBeNull();
    expect(refused.payload.expectedRev).toBe(block.rev);
    expect(refused.payload.currentText).toBe("See the hub document");
    expect(refused.payload.currentRev).toBeTruthy();
  });

  it("refuses a target this replica cannot resolve, and accepts an archived one", async () => {
    const rig = await localRig();
    const doc = await rig.ok("create_doc", {
      title: "Citing",
      description: DESCRIPTION,
      blocks: [{ type: "paragraph", text: "See the hub docs" }],
    });
    const block = doc.blocks[0];
    const unknown = randomUUID();

    const refusedInsert = await rig.call("insert_block", {
      uuid: doc.uuid,
      type: "paragraph",
      inline: [{ text: "x", marks: { docLink: unknown } }],
    });
    expect(refusedInsert.payload.error).toBe("doclink_target_not_known_locally");
    expect(refusedInsert.payload.applied).toBe(false);
    // The hub state is part of the answer: "unknown here" is not "absent".
    expect(refusedInsert.payload.hub).toBeDefined();

    const refusedLink = await rig.call("link_range", {
      uuid: doc.uuid,
      block_id: block.id,
      start: 4,
      end: 11,
      doc_id: unknown,
      rev: block.rev,
    });
    expect(refusedLink.payload.error).toBe("doclink_target_not_known_locally");

    // Nothing was written by either refusal.
    const untouched = await rig.ok("get_doc", { uuid: doc.uuid });
    expect(untouched.blocks).toEqual([block]);

    // An archived document is still a document, and reading one is allowed, so
    // a reference to one is too.
    const retired = await rig.ok("create_doc", {
      title: "Retired",
      description: DESCRIPTION,
    });
    await rig.ok("archive_doc", { uuid: retired.uuid });
    const linked = await rig.ok("link_range", {
      uuid: doc.uuid,
      block_id: block.id,
      start: 4,
      end: 11,
      doc_id: retired.uuid,
      rev: block.rev,
    });
    expect(linked.title).toBe("Retired");
  });

  it("ignores inline on a source block rather than refusing its target", async () => {
    const rig = await localRig();
    const doc = await rig.ok("create_doc", {
      title: "Citing",
      description: DESCRIPTION,
    });

    // A code block carries no marks — the tool description says so and the
    // schema writes its `text` — so resolving a reference that is never going
    // to be written would refuse the call over an argument it discards.
    // `create_doc` takes the same path, so one handler proves both.
    const inserted = await rig.ok("insert_block", {
      uuid: doc.uuid,
      type: "code",
      text: "const x = 1;",
      language: "ts",
      inline: [{ text: "x", marks: { docLink: randomUUID() } }],
    });
    expect(inserted.applied).toBe(true);

    const read = await rig.ok("get_doc", { uuid: doc.uuid });
    expect(read.blocks).toHaveLength(1);
    expect(read.blocks[0].text).toBe("const x = 1;");
    expect(read.blocks[0].doc_links).toBeUndefined();
  });
});
