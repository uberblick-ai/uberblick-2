/** The person-facing summary and the narrow reminder attached to content edits. */

import { afterAll, afterEach, describe, expect, it } from "vitest";
import { MAX_TLDR_LENGTH, getMetaMap } from "@uberblick/schema";
import { removeTempDirs, startServer, testConfig } from "./helpers.js";
import type { Rig } from "./helpers.js";

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

describe("set_tldr", () => {
  it("sets, trims and explicitly clears the summary without touching description", async () => {
    const rig = await localRig();
    const doc = await rig.ok("create_doc", {
      title: "Reader guide",
      description: "Agent-facing discovery copy.",
    });

    expect((await rig.ok("get_doc", { uuid: doc.uuid })).tldr).toBeNull();

    const written = await rig.ok("set_tldr", {
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

    await rig.ok("set_description", {
      uuid: doc.uuid,
      description: "Rewritten agent-facing copy.",
    });
    expect((await rig.ok("get_doc", { uuid: doc.uuid })).tldr).toBe(
      "A quick summary for a person.",
    );

    for (const tldr of ["", "   ", "x".repeat(MAX_TLDR_LENGTH + 1)]) {
      expect((await rig.call("set_tldr", { uuid: doc.uuid, tldr })).isError).toBe(
        true,
      );
    }
    expect((await rig.ok("get_doc", { uuid: doc.uuid })).tldr).toBe(
      "A quick summary for a person.",
    );

    const cleared = await rig.ok("set_tldr", { uuid: doc.uuid, tldr: null });
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
    await rig.ok("set_tldr", {
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
    expect(source.tldrHint).toContain("set_tldr");

    const first = source.blocks[0];
    const edited = await rig.ok("edit_block", {
      uuid: source.uuid,
      block_id: first.id,
      old_text: first.text,
      new_text: "Read the target now",
      rev: first.rev,
    });
    const inserted = await rig.ok("insert_block", {
      uuid: source.uuid,
      after_block_id: first.id,
      type: "paragraph",
      text: "Temporary",
    });
    const deleted = await rig.ok("delete_block", {
      uuid: source.uuid,
      block_id: inserted.block.id,
    });
    for (const result of [edited, inserted, deleted]) {
      expect(result).toMatchObject({ tldr: null });
      expect(result.tldrHint).toContain("set_tldr");
    }

    await rig.ok("set_tldr", {
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
      await rig.ok("set_tags", { uuid: source.uuid, tags: ["auth"] }),
      await rig.ok("set_links", { uuid: source.uuid, links: [target.uuid] }),
      await rig.ok("set_title", { uuid: source.uuid, title: "Renamed source" }),
      await rig.ok("set_description", {
        uuid: source.uuid,
        description: "Rewritten discovery copy.",
      }),
      await rig.ok("set_status", { uuid: source.uuid, status: "planned" }),
      await rig.ok("set_changelog_suggestion", {
        uuid: source.uuid,
        suggestion: null,
      }),
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
