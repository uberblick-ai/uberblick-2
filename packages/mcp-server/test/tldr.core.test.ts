/** The person-facing summary and the narrow reminder attached to content edits. */
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { MAX_TLDR_LENGTH, getMetaMap, setTldrOptOut } from "@uberblick/schema";
import { removeTempDirs, startServer, testConfig } from "./core-helpers.js";
import type { Rig } from "./core-helpers.js";

const rigs: Rig[] = [];

async function localRig(): Promise<Rig> {
  const rig = await startServer(testConfig());
  rigs.push(rig);
  return rig;
}

afterEach(async () => {
  for (const rig of rigs.splice(0)) {
    await rig.close();
  }
});

afterAll(() => {
  removeTempDirs();
});

describe("set_metadata", () => {
  it("preserves deliberate removal when clearing and reports it only in get_doc", async () => {
    const rig = await localRig();
    const doc = await rig.ok("create_doc", {
      title: "Short reference", description: "A compact reference.",
      blocks: [{ type: "paragraph", text: "One example." }],
    });
    expect(await rig.ok("get_doc", { uuid: doc.uuid })).not.toHaveProperty("tldrOptOut");
    setTldrOptOut(rig.instance.replicas.replica(doc.uuid).doc, true);
    expect(await rig.ok("get_doc", { uuid: doc.uuid })).toMatchObject({ tldr: null, tldrOptOut: true });
    const cleared = await rig.ok("set_metadata", { uuid: doc.uuid, tldr: null });
    expect(cleared).toMatchObject({ tldr: null, applied: true });
    expect(cleared).not.toHaveProperty("tldrOptOut");
    expect(await rig.ok("get_doc", { uuid: doc.uuid })).toMatchObject({ tldr: null, tldrOptOut: true });
    for (const result of [
      cleared,
      ...(await rig.ok("list_docs")).docs,
      ...(await rig.ok("search", { query: "reference" })).hits,
      await rig.ok("export_markdown", { uuid: doc.uuid }),
      await rig.ok("get_sidebar"),
    ]) expect(result).not.toHaveProperty("tldrOptOut");
    expect((await rig.ok("export_markdown", { uuid: doc.uuid })).markdown).not.toContain("tldrOptOut");
  });

  it("accepts opt-in on an unmarked page without affecting any other metadata", async () => {
    const rig = await localRig();
    const doc = await rig.ok("create_doc", { title: "Unmarked", description: "Plain document." });
    for (const tldr_opt_in of [true, false]) {
      await rig.ok("set_metadata", { uuid: doc.uuid, tldr: "A summary.", tldr_opt_in });
      const read = await rig.ok("get_doc", { uuid: doc.uuid });
      expect(read).toMatchObject({ title: "Unmarked", description: "Plain document.", tldr: "A summary." });
      expect(read).not.toHaveProperty("tldrOptOut");
    }
  });

  it("ignores an older writer's retained mark when summary text is present", async () => {
    const rig = await localRig();
    const doc = await rig.ok("create_doc", {
      title: "Older writer", description: "A compatibility fixture.",
      blocks: [{ type: "paragraph", text: "Before" }],
    });
    const replica = rig.instance.replicas.replica(doc.uuid);
    setTldrOptOut(replica.doc, true);
    getMetaMap(replica.doc).set("tldr", "Summary from an older client.");
    const read = await rig.ok("get_doc", { uuid: doc.uuid });
    expect(read.tldr).toBe("Summary from an older client.");
    expect(read).not.toHaveProperty("tldrOptOut");
    const edited = await rig.ok("edit_block", {
      uuid: doc.uuid, block_id: read.blocks[0].id, old_text: read.blocks[0].text,
      new_text: "After", rev: read.blocks[0].rev,
    });
    expect(edited.tldrHint).toContain("review its TL;DR");
    await rig.ok("set_metadata", { uuid: doc.uuid, tldr: "Updated without opt-in." });
    expect((await rig.ok("get_doc", { uuid: doc.uuid })).tldr).toBe("Updated without opt-in.");
  });

  it("keeps decision exclusions and TL;DR refusals even if raw metadata has a mark", async () => {
    const rig = await localRig();
    const doc = await rig.ok("create_doc", {
      title: "Open decision", description: "A decision fixture.", kind: "decision", status: "open",
      blocks: [{ type: "paragraph", text: "A short answer." }],
    });
    const raw = getMetaMap(rig.instance.replicas.replica(doc.uuid).doc);
    raw.set("tldrOptOut", true);
    const read = await rig.ok("get_doc", { uuid: doc.uuid });
    expect(read).not.toHaveProperty("tldrOptOut");
    for (const optIn of [undefined, true]) {
      const refused = await rig.call("set_metadata", {
        uuid: doc.uuid, tldr: "Forbidden summary.",
        ...(optIn === undefined ? {} : { tldr_opt_in: optIn }),
      });
      expect(refused).toMatchObject({ isError: true, payload: { error: "decision_tldr_unsupported", field: "tldr" } });
    }
    raw.set("tldr", "Legacy summary.");
    expect(await rig.ok("get_doc", { uuid: doc.uuid })).toMatchObject({ tldr: null });
    expect(await rig.ok("get_doc", { uuid: doc.uuid })).not.toHaveProperty("tldrOptOut");
    await rig.ok("set_metadata", { uuid: doc.uuid, tldr: null });
    expect(await rig.ok("get_doc", { uuid: doc.uuid })).toMatchObject({ tldr: null });
    expect(await rig.ok("get_doc", { uuid: doc.uuid })).not.toHaveProperty("tldrOptOut");
  });

  it("sets, trims and explicitly clears the summary without touching description", async () => {
    const rig = await localRig();
    const doc = await rig.ok("create_doc", {
      title: "Reader guide",
      description: "Agent-facing discovery copy.",
    });

    expect((await rig.ok("get_doc", { uuid: doc.uuid })).tldr).toBeNull();

    const written = await rig.ok("set_metadata", {
      uuid: doc.uuid,
      tldr: "  A quick summary for a person.  ",
    });
    expect(written).toMatchObject({
      uuid: doc.uuid,
      tldr: "A quick summary for a person.",
      applied: true,
      synced: false,
    });
    expect(written).not.toHaveProperty("tldrHint");
    expect(await rig.ok("get_doc", { uuid: doc.uuid })).toMatchObject({
      description: "Agent-facing discovery copy.",
      tldr: "A quick summary for a person.",
    });

    await rig.ok("set_metadata", {
      uuid: doc.uuid,
      description: "Rewritten agent-facing copy.",
    });
    expect((await rig.ok("get_doc", { uuid: doc.uuid })).tldr).toBe(
      "A quick summary for a person.",
    );

    for (const tldr of ["", "   ", "x".repeat(MAX_TLDR_LENGTH + 1)]) {
      expect((await rig.call("set_metadata", { uuid: doc.uuid, tldr })).isError).toBe(
        true,
      );
    }
    expect((await rig.ok("get_doc", { uuid: doc.uuid })).tldr).toBe(
      "A quick summary for a person.",
    );

    const cleared = await rig.ok("set_metadata", { uuid: doc.uuid, tldr: null });
    expect(cleared).toMatchObject({ tldr: null, applied: true, synced: false });
    expect((await rig.ok("get_doc", { uuid: doc.uuid })).tldr).toBeNull();
    expect(
      getMetaMap(rig.instance.replicas.replica(doc.uuid).doc).get("tldr"),
    ).toBeNull();
  });

  it("stays out of discovery, search and Markdown", async () => {
    const rig = await localRig();
    const doc = await rig.ok("create_doc", {
      title: "Opaque summary",
      description: "Discovery copy without the unusual summary word.",
      blocks: [{ type: "paragraph", text: "ordinary content" }],
    });
    await rig.ok("set_metadata", {
      uuid: doc.uuid,
      tldr: "A quokka-only summary for a person.",
    });

    expect((await rig.ok("list_docs")).docs[0]).not.toHaveProperty("tldr");
    expect((await rig.ok("search", { query: "quokka" })).hits).toEqual([]);
    expect(
      (await rig.ok("export_markdown", { uuid: doc.uuid })).markdown,
    ).not.toContain("quokka");
  });
});

describe("the TL;DR review reminder", () => {
  it("omits hints and missing-summary fields from all content writes on a marked page", async () => {
    const rig = await localRig();
    const doc = await rig.ok("create_doc", {
      title: "Examples only", description: "No summary needed.",
      blocks: [{ type: "paragraph", text: "Before" }],
    });
    setTldrOptOut(rig.instance.replicas.replica(doc.uuid).doc, true);
    const first = doc.blocks[0];
    const edited = await rig.ok("edit_block", {
      uuid: doc.uuid, block_id: first.id, old_text: first.text, new_text: "After", rev: first.rev,
    });
    const inserted = await rig.ok("insert_block", { uuid: doc.uuid, after_block_id: first.id, blocks: [{ type: "paragraph", text: "Temporary" }] });
    const deleted = await rig.ok("delete_block", { uuid: doc.uuid, block_id: inserted.blocks[0].id });
    for (const result of [edited, inserted, deleted]) {
      expect(result).not.toHaveProperty("tldrHint");
      expect(result).not.toHaveProperty("tldr");
      expect(result).not.toHaveProperty("tldrOptOut");
    }
    setTldrOptOut(rig.instance.replicas.replica(doc.uuid).doc, false);
    const unmarked = await rig.ok("insert_block", { uuid: doc.uuid, blocks: [{ type: "paragraph", text: "Now unmarked" }] });
    expect(unmarked).toMatchObject({ tldr: null, tldrHint: expect.any(String) });
  });

  it("follows only successful block-content mutations", async () => {
    const rig = await localRig();
    const metadataOnly = await rig.ok("create_doc", {
      title: "Metadata only",
      description: "A document with no seeded blocks.",
    });
    expect(metadataOnly).not.toHaveProperty("tldr");
    expect(metadataOnly).not.toHaveProperty("tldrHint");

    const target = await rig.ok("create_doc", {
      title: "Target",
      description: "A link target.",
    });
    const source = await rig.ok("create_doc", {
      title: "Source",
      description: "A document whose content changes.",
      blocks: [{ type: "paragraph", text: "Read the target" }],
    });
    expect(source).toMatchObject({ tldr: null });
    expect(source.tldrHint).toContain("set_metadata");

    const first = source.blocks[0];
    const edited = await rig.ok("edit_block", {
      uuid: source.uuid,
      block_id: first.id,
      old_text: first.text,
      new_text: "Read the target now",
      rev: first.rev,
    });
    const inserted = await rig.ok("insert_block", {
      uuid: source.uuid, after_block_id: first.id,
      blocks: [{ type: "paragraph", text: "Temporary" }],
    });
    const deleted = await rig.ok("delete_block", {
      uuid: source.uuid,
      block_id: inserted.blocks[0].id,
    });
    for (const result of [edited, inserted, deleted]) {
      expect(result).toMatchObject({ tldr: null });
      expect(result.tldrHint).toContain("set_metadata");
    }

    await rig.ok("set_metadata", {
      uuid: source.uuid,
      tldr: "A summary that may now be stale.",
    });
    const read = await rig.ok("get_doc", { uuid: source.uuid });
    const reviewed = await rig.ok("edit_block", {
      uuid: source.uuid,
      block_id: read.blocks[0].id,
      old_text: read.blocks[0].text,
      new_text: "Read the target again",
      rev: read.blocks[0].rev,
    });
    expect(reviewed).not.toHaveProperty("tldr");
    expect(reviewed.tldrHint).toContain("review its TL;DR");

    const metadataResults = [
      await rig.ok("set_metadata", { uuid: source.uuid, tags: ["auth"] }),
      await rig.ok("set_metadata", { uuid: source.uuid, links: [target.uuid] }),
      await rig.ok("set_metadata", { uuid: source.uuid, title: "Renamed source" }),
      await rig.ok("set_metadata", {
        uuid: source.uuid,
        description: "Rewritten discovery copy.",
      }),
      await rig.ok("set_status", { uuid: source.uuid, status: "open" }),
      await rig.ok("annotate", {
        uuid: source.uuid,
        block_id: read.blocks[0].id,
        start: 0,
        end: 4,
        text: "Check this.",
      }),
      await rig.ok("link_range", {
        uuid: source.uuid,
        block_id: read.blocks[0].id,
        start: 5,
        end: 15,
        doc_id: target.uuid,
        rev: reviewed.block.rev,
      }),
      await rig.ok("pin_doc", { uuid: source.uuid, group: "Reference" }),
      await rig.ok("unpin_doc", { uuid: source.uuid }),
      await rig.ok("archive_doc", { uuid: source.uuid }),
      await rig.ok("restore_doc", { uuid: source.uuid }),
    ];
    for (const result of metadataResults) {
      expect(result).not.toHaveProperty("tldrHint");
    }
  });
});
