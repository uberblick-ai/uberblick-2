/**
 * What `search` matches.
 *
 * The installed tool description promises all-terms matching over one document,
 * no stemming, and a trailing `*` as the way to loosen a term. Nothing else in
 * the suite would notice any of those changing: a multi-term query appears in
 * `title.test.ts` without defending the semantics, and all-terms silently
 * becoming any-term would turn correct empty answers into wrong populated ones
 * while every existing test still passed. #560 exists because a correct zero-hit
 * result was read as a broken index, so the promise is what this defends.
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

async function hits(rig: Rig, query: string): Promise<string[]> {
  const found = await rig.ok("search", { query });
  return found.hits.map((hit: { title: string }) => hit.title);
}

afterEach(async () => {
  for (const rig of rigs.splice(0)) {
    await rig.close();
  }
});

afterAll(() => {
  removeTempDirs();
});

describe("search", () => {
  it("needs every term in one document, stems nothing, and loosens on *", async () => {
    const rig = await localRig();
    await rig.ok("create_doc", {
      title: "Presence",
      description: "How a client announces itself and withdraws.",
      blocks: [{ type: "paragraph", text: "Withdrawing removes the cursor." }],
    });
    await rig.ok("create_doc", {
      title: "Awareness",
      description: "The peer list every client publishes.",
      blocks: [{ type: "paragraph", text: "Names and colors travel with it." }],
    });
    await rig.ok("create_doc", {
      title: "Adjacent",
      description: "How to list docs from the directory.",
      blocks: [],
    });
    await rig.ok("create_doc", {
      title: "Separated",
      description: "How to list all kinds of docs from the directory.",
      blocks: [],
    });

    // All-terms, not any-term: both words exist in the corpus, but no document
    // holds both, so the honest answer is empty. Under any-term matching this
    // returns two hits.
    expect(await hits(rig, "presence awareness")).toEqual([]);
    // The same query shape against one document that does hold both terms —
    // proof the empty answer above is the AND and not a broken index.
    expect(await hits(rig, "presence withdrawing")).toEqual(["Presence"]);

    // Nothing is stemmed or inflection-folded, which is the whole reason the
    // rule is worth stating: this is the query that cost #560 a bug report.
    expect(await hits(rig, "presence withdrawal")).toEqual([]);
    // And the documented way out of it.
    expect(await hits(rig, "presence withdraw*")).toEqual(["Presence"]);

    // FTS5 tokenizes an underscore inside a quoted query token as an adjacent
    // phrase: the separator need not appear, but another word cannot intervene.
    expect(await hits(rig, "list_docs")).toEqual(["Adjacent"]);

    // A query with no searchable term is empty rather than an FTS5 syntax
    // error, so the description's "punctuation and emoji are not terms" holds
    // at the boundary as well as in prose.
    expect(await hits(rig, "?!,;")).toEqual([]);
  });
});
