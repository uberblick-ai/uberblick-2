/**
 * The changelog suggestion: draft release-note copy an agent leaves behind when
 * delivered work makes it update a document.
 *
 * What this suite defends is the three-state contract, because the states are
 * what the field is for. Absent means nobody has written one; null is the
 * deliberate decision that this work needs no user-facing entry; a string is the
 * copy. If a clear left null behind, every internal-only change would claim a
 * decision nobody made — and if null read as absent, the decision would be
 * unrecordable. The rest is the metadata discipline the description already has:
 * the tool trims, bounds the length, refuses an archived document, and says what
 * became of the write.
 */

import { afterAll, afterEach, describe, expect, it } from "vitest";
import { MAX_DESCRIPTION_LENGTH } from "@uberblick/schema";
import { removeTempDirs, startServer, testConfig } from "./helpers.js";
import type { Rig } from "./helpers.js";

const rigs: Rig[] = [];

async function localRig(): Promise<Rig> {
  const rig = await startServer(testConfig());
  rigs.push(rig);
  return rig;
}

async function describedDoc(rig: Rig): Promise<string> {
  const doc = await rig.ok("create_doc", {
    title: "Agent presence",
    description: "How agent cursors appear and when they disappear.",
  });
  return doc.uuid;
}

afterEach(async () => {
  for (const rig of rigs.splice(0)) {
    await rig.close();
  }
});

afterAll(() => {
  removeTempDirs();
});

describe("set_changelog_suggestion", () => {
  it("reaches all three states, and get_doc reads back the one it wrote", async () => {
    const rig = await localRig();
    const uuid = await describedDoc(rig);

    // Nobody has written one: the key is absent from the document, not null.
    expect(await rig.ok("get_doc", { uuid })).not.toHaveProperty(
      "changelogSuggestion",
    );

    const written = await rig.ok("set_changelog_suggestion", {
      uuid,
      suggestion: "  Agent bubbles now appear only while an agent is working.  ",
    });
    expect(written).toMatchObject({
      uuid,
      // Trimmed before it was measured, so what is stored is what was checked.
      changelogSuggestion:
        "Agent bubbles now appear only while an agent is working.",
      applied: true,
      // Local-only rig: applied is the durable half, and synced is honest about
      // the hub it never reached.
      synced: false,
    });
    expect(
      (await rig.ok("get_doc", { uuid })).changelogSuggestion,
    ).toBe("Agent bubbles now appear only while an agent is working.");

    const none = await rig.ok("set_changelog_suggestion", {
      uuid,
      suggestion: null,
    });
    expect(none).toMatchObject({ changelogSuggestion: null, applied: true });
    expect((await rig.ok("get_doc", { uuid })).changelogSuggestion).toBeNull();

    // The empty string is not a fourth state: it takes the document back to one
    // nobody has written a suggestion for, key and all.
    const cleared = await rig.ok("set_changelog_suggestion", {
      uuid,
      suggestion: "   ",
    });
    expect(cleared).not.toHaveProperty("changelogSuggestion");
    expect(await rig.ok("get_doc", { uuid })).not.toHaveProperty(
      "changelogSuggestion",
    );
  });

  it("reaches neither the listing nor the search index", async () => {
    const rig = await localRig();
    const uuid = await describedDoc(rig);

    await rig.ok("set_changelog_suggestion", {
      uuid,
      suggestion: "Agent bubbles now appear only while an agent is working.",
    });

    // Nothing caches it: the listing and the index are the description's
    // surfaces, not this field's. Metadata isolation itself is the schema
    // suite's — every setter writes one key of the same `meta` map — so this
    // suite defends only the boundary the MCP layer owns.
    const listed = (await rig.ok("list_docs")).docs[0];
    expect(listed).not.toHaveProperty("changelogSuggestion");
    expect((await rig.ok("search", { query: "bubbles" })).hits).toEqual([]);
  });

  it("refuses more than a description's worth, and an archived document", async () => {
    const rig = await localRig();
    const uuid = await describedDoc(rig);

    const tooLong = await rig.call("set_changelog_suggestion", {
      uuid,
      suggestion: "x".repeat(MAX_DESCRIPTION_LENGTH + 1),
    });
    expect(tooLong.isError).toBe(true);
    expect(await rig.ok("get_doc", { uuid })).not.toHaveProperty(
      "changelogSuggestion",
    );

    await rig.ok("archive_doc", { uuid });
    const archived = await rig.call("set_changelog_suggestion", {
      uuid,
      suggestion: "Should not land.",
    });
    expect(archived.payload).toMatchObject({
      error: "doc_archived",
      applied: false,
    });
  });
});
