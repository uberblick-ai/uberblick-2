import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import type { DecisionStatus } from "../src/index.js";
import {
  InvalidDecisionReferenceError,
  addDecision,
  appendBlock,
  exportMarkdown,
  getDecisionsArray,
  getMeta,
  importMarkdown,
  initDoc,
  readDecisions,
  removeDecision,
  reorderDecisions,
  setLinks,
  tombstoneDirectoryEntry,
  upsertDirectoryEntry,
} from "../src/index.js";
import { syncDocs } from "./helpers.js";

const REQUIREMENT = "11111111-1111-4111-8111-111111111111";
const SLUGS = "22222222-2222-4222-8222-222222222222";
const TOKENS = "33333333-3333-4333-8333-333333333333";
const ROOMS = "44444444-4444-4444-8444-444444444444";

/** A requirement document with one paragraph and an empty decision log. */
function requirement(): Y.Doc {
  const doc = new Y.Doc();
  initDoc(doc, {
    uuid: REQUIREMENT,
    title: "Workspace identity",
    tags: ["product"],
  });
  appendBlock(doc, { type: "paragraph", text: "A workspace id is a uuid." });
  return doc;
}

/** A directory holding a live stub per uuid given, each `kind: decision`. */
function directory(
  entries: Array<{ uuid: string; title: string; status?: DecisionStatus }>,
): Y.Doc {
  const dir = new Y.Doc();
  for (const entry of entries) {
    upsertDirectoryEntry(dir, {
      uuid: entry.uuid,
      title: entry.title,
      tags: ["decision"],
      kind: "decision",
      ...(entry.status === undefined ? {} : { status: entry.status }),
    });
  }
  return dir;
}

function uuids(doc: Y.Doc): string[] {
  return readDecisions(doc).map((reference) => reference.uuid);
}

describe("the decision log", () => {
  it("appends references and reads them back in insertion order", () => {
    const doc = requirement();
    addDecision(doc, SLUGS);
    addDecision(doc, TOKENS);
    addDecision(doc, ROOMS);

    expect(uuids(doc)).toEqual([SLUGS, TOKENS, ROOMS]);
  });

  it("canonicalizes an upper-cased uuid rather than storing a second identity", () => {
    const doc = requirement();
    addDecision(doc, SLUGS.toUpperCase());

    expect(uuids(doc)).toEqual([SLUGS]);
    expect(() => addDecision(doc, SLUGS)).toThrow(
      InvalidDecisionReferenceError,
    );
  });

  it("adds the canonical graph edge atomically without disturbing other links", () => {
    const doc = requirement();
    setLinks(doc, [ROOMS, SLUGS.toUpperCase(), SLUGS]);
    let updates = 0;
    doc.on("update", () => {
      updates += 1;
    });

    addDecision(doc, SLUGS);

    expect(uuids(doc)).toEqual([SLUGS]);
    expect(getMeta(doc).links).toEqual([ROOMS, SLUGS]);
    expect(updates).toBe(1);
  });

  it("refuses a non-uuid, a reserved room name and a duplicate, storing nothing", () => {
    const doc = requirement();
    addDecision(doc, SLUGS);

    for (const value of ["Slug is display", "_directory", "not-a-uuid"]) {
      let thrown: unknown;
      try {
        addDecision(doc, value);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(InvalidDecisionReferenceError);
      expect((thrown as InvalidDecisionReferenceError).reason).toBe(
        "not-a-document",
      );
    }

    let duplicate: unknown;
    try {
      addDecision(doc, SLUGS);
    } catch (error) {
      duplicate = error;
    }
    expect(duplicate).toBeInstanceOf(InvalidDecisionReferenceError);
    expect((duplicate as InvalidDecisionReferenceError).reason).toBe(
      "duplicate",
    );

    // Every refusal happened before any write: the log still holds exactly the
    // one reference that was legally added.
    expect(getDecisionsArray(doc).toArray()).toEqual([SLUGS]);
  });

  it("removes exactly one reference and leaves the referenced document alone", () => {
    const doc = requirement();
    addDecision(doc, SLUGS);
    addDecision(doc, TOKENS);

    const decision = new Y.Doc();
    initDoc(decision, { uuid: SLUGS, title: "Slug is display" });
    appendBlock(decision, { type: "paragraph", text: "uuid is identity." });
    const before = Y.encodeStateAsUpdate(decision);

    removeDecision(doc, SLUGS);

    expect(uuids(doc)).toEqual([TOKENS]);
    expect(Y.encodeStateAsUpdate(decision)).toEqual(before);
  });

  it("moves a reference, and a concurrent add on a second replica survives the merge", () => {
    const a = requirement();
    addDecision(a, SLUGS);
    addDecision(a, TOKENS);
    const b = new Y.Doc();
    syncDocs(a, b);

    // Neither replica sees the other's write until the merge below. This is the
    // test that fails if the array held decision entries rather than uuids: the
    // reorder would clone-and-destroy the moved element, taking the concurrent
    // write with it.
    reorderDecisions(a, TOKENS, 0);
    addDecision(b, ROOMS);
    syncDocs(a, b);

    expect(uuids(a)).toEqual([TOKENS, SLUGS, ROOMS]);
    expect(uuids(b)).toEqual(uuids(a));
  });

  it("converges when two replicas reorder the same reference concurrently", () => {
    const a = requirement();
    addDecision(a, SLUGS);
    addDecision(a, TOKENS);
    addDecision(a, ROOMS);
    const b = new Y.Doc();
    syncDocs(a, b);

    reorderDecisions(a, ROOMS, 0);
    reorderDecisions(b, ROOMS, 1);
    syncDocs(a, b);

    // A move is a delete plus an insert, so the deletes commute and both
    // inserts survive: storage holds the uuid twice on purpose. The read rule
    // is what makes both replicas answer the same, and it is a position rather
    // than a timestamp, so the winner does not depend on integration order.
    expect(getDecisionsArray(a).toArray()).toEqual(
      getDecisionsArray(b).toArray(),
    );
    expect(
      getDecisionsArray(a).toArray().filter((uuid) => uuid === ROOMS),
    ).toHaveLength(2);
    expect(uuids(a)).toEqual(uuids(b));
    expect(uuids(a)).toHaveLength(3);
  });

  it("keeps a removal hidden when it races a reorder, then permits a deliberate re-add", () => {
    const a = requirement();
    addDecision(a, SLUGS);
    addDecision(a, TOKENS);
    const b = new Y.Doc();
    syncDocs(a, b);

    removeDecision(a, SLUGS);
    reorderDecisions(b, SLUGS, 1);
    syncDocs(a, b);

    expect(uuids(a)).toEqual([TOKENS]);
    expect(uuids(b)).toEqual([TOKENS]);

    addDecision(a, SLUGS);
    syncDocs(a, b);
    expect(uuids(a)).toEqual([TOKENS, SLUGS]);
    expect(uuids(b)).toEqual([TOKENS, SLUGS]);

    reorderDecisions(a, SLUGS, 0);
    syncDocs(a, b);
    expect(uuids(a)).toEqual([SLUGS, TOKENS]);
    expect(uuids(b)).toEqual([SLUGS, TOKENS]);
  });

  it("lets a deliberate re-add append after an unseen stale reorder", () => {
    const a = requirement();
    addDecision(a, SLUGS);
    addDecision(a, TOKENS);
    const b = new Y.Doc();
    syncDocs(a, b);

    removeDecision(a, SLUGS);
    addDecision(a, SLUGS);
    reorderDecisions(b, SLUGS, 0);
    syncDocs(a, b);

    expect(uuids(a)).toEqual([TOKENS, SLUGS]);
    expect(uuids(b)).toEqual([TOKENS, SLUGS]);
  });

  it("keeps decision graph edges through curated-link replacement", () => {
    const doc = requirement();
    addDecision(doc, SLUGS);

    setLinks(doc, [ROOMS]);

    expect(getMeta(doc).links).toEqual([ROOMS, SLUGS]);
  });

  it("converges decision and curated edges from concurrent writers", () => {
    const a = requirement();
    const b = new Y.Doc();
    syncDocs(a, b);

    addDecision(a, SLUGS);
    setLinks(b, [ROOMS]);
    syncDocs(a, b);

    expect(getMeta(a).links).toEqual([ROOMS, SLUGS]);
    expect(getMeta(b).links).toEqual([ROOMS, SLUGS]);
  });

  it("keeps a reference whose document is missing or archived, flagged unavailable", () => {
    const doc = requirement();
    addDecision(doc, SLUGS);
    addDecision(doc, TOKENS);
    addDecision(doc, ROOMS);

    const dir = directory([
      { uuid: SLUGS, title: "Slug is display", status: "decided" },
      { uuid: TOKENS, title: "Room-token audience", status: "open" },
    ]);
    tombstoneDirectoryEntry(dir, TOKENS);

    expect(readDecisions(doc, dir)).toEqual([
      {
        uuid: SLUGS,
        title: "Slug is display",
        status: "decided",
        available: true,
      },
      {
        uuid: TOKENS,
        title: "Room-token audience",
        status: "open",
        available: false,
      },
      { uuid: ROOMS, title: null, status: null, available: false },
    ]);
  });
});

describe("the decision log in markdown", () => {
  it("emits the stored order with each entry's state, and no section when empty", () => {
    const doc = requirement();
    const plain = exportMarkdown(doc);
    expect(plain).not.toContain("## Decisions");

    addDecision(doc, TOKENS);
    addDecision(doc, SLUGS);
    const dir = directory([
      { uuid: SLUGS, title: "Slug is display", status: "decided" },
      { uuid: TOKENS, title: "Room-token audience", status: "open" },
      { uuid: ROOMS, title: "Unreferenced" },
    ]);

    const markdown = exportMarkdown(doc, { directory: dir });

    // The rest of the document is untouched: the section is appended whole.
    expect(markdown).toBe(
      [
        plain.trimEnd(),
        "",
        "## Decisions",
        "",
        "<!-- decisions: references to decision documents, in stored order. " +
          "Importing this file does not restore them. -->",
        "",
        `- ${TOKENS} — Room-token audience — open`,
        `- ${SLUGS} — Slug is display — decided`,
        "",
      ].join("\n"),
    );
  });

  it("does not claim a reference is unavailable when it was given no directory", () => {
    const doc = requirement();
    addDecision(doc, SLUGS);

    const markdown = exportMarkdown(doc);

    expect(markdown).toContain(`- ${SLUGS}\n`);
    expect(markdown).not.toContain("(unavailable)");
  });

  it("folds line breaks and renders a title as literal inline markdown", () => {
    const doc = requirement();
    addDecision(doc, SLUGS);
    const dir = directory([
      {
        uuid: SLUGS,
        title:
          "Decision\n## Injected *bold* [link](https://example.com) `code` _em_ ~~strike~~",
        status: "decided",
      },
    ]);

    const markdown = exportMarkdown(doc, { directory: dir });
    const rows = markdown
      .split("\n")
      .filter((line) => line.startsWith(`- ${SLUGS}`));

    expect(rows).toEqual([
      `- ${SLUGS} — ` +
        "Decision ## Injected \\*bold\\* \\[link](https://example.com) " +
        "\\`code\\` \\_em\\_ \\~\\~strike\\~\\~ — decided",
    ]);
    expect(markdown).not.toMatch(/^## Injected/m);
  });

  it("does not reconstruct the slot on import, and says so in the export", () => {
    const doc = requirement();
    addDecision(doc, SLUGS);
    const dir = directory([{ uuid: SLUGS, title: "Slug is display" }]);

    const markdown = exportMarkdown(doc, { directory: dir });
    expect(markdown).toContain("Importing this file does not restore them.");

    const imported = importMarkdown(markdown);
    const rebuilt = new Y.Doc();
    initDoc(rebuilt, { uuid: imported.uuid ?? "", title: imported.title });
    for (const block of imported.blocks) appendBlock(rebuilt, block);

    expect(readDecisions(rebuilt)).toEqual([]);
    // The section came back as ordinary prose — the documented loss path.
    expect(imported.blocks.at(-1)?.text).toContain(SLUGS);
  });
});

describe("a client that never opens the slot", () => {
  it("preserves it across an edit-and-sync cycle", () => {
    const author = requirement();
    addDecision(author, SLUGS);
    addDecision(author, TOKENS);

    // A replica that only ever touches `meta` and `blocks` — root types are
    // independent, so it neither reads nor rewrites the decision log.
    const older = new Y.Doc();
    syncDocs(author, older);
    appendBlock(older, { type: "paragraph", text: "Edited elsewhere." });
    syncDocs(author, older);

    expect(uuids(older)).toEqual([SLUGS, TOKENS]);
    expect(uuids(author)).toEqual([SLUGS, TOKENS]);
    expect(exportMarkdown(author)).toContain("Edited elsewhere.");
  });
});
