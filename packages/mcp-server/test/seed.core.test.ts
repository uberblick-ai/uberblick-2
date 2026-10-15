/**
 * The markdown template import — contract level.
 *
 * This path is private: `ub workspace create` writes the two starter templates that ship in
 * `@uberblick/cli` through it, and nothing else does. Its job is that a
 * template becomes a discoverable document and then stops being a template — a
 * second run writes nothing, the link graph is real, and a live edit is never
 * reached into. Each test here is one of those.
 *
 * The fixture corpus below is this suite's own. The repository holds no
 * snapshot of the project's documents — they live in the live workspace — so a
 * contract here is defended against files this file writes rather than against
 * whatever a product document happens to say today. The starter templates
 * themselves are proved end to end by the CLI's own suite.
 *
 * The assertions go through the real MCP tools wherever one names the contract
 * (list_docs, search, backlinks, export_markdown), on a server opened over the
 * same database the importer wrote — which is also the proof that the write
 * went into the shared update log and not somewhere private.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getMeta } from "@uberblick/schema";
import { PersistenceError, Replicas } from "../src/replica.js";

import { importSeedDocs, readSeedDocs } from "../src/seed.js";

import { cleanupTestResources, FailingStore, WORKSPACE, tempDir, testConfig } from "./core-helpers.js";

/**
 * Run the importer over a database the way the CLI does: its own store, its own
 * replica set, closed afterwards. Two runs against one path are therefore two
 * independent processes as far as the log is concerned.
 *
 * With no `port` the config points at a dead address and carries no secret, so
 * the run is the offline one — the path that must always work.
 */

const OVERVIEW = "a1e7d3f0-4c62-4b18-9d05-7e2a6b41c93d";
const INSTALL = "c48b2a95-6f13-4d70-8b2e-1a5c09e7d284";
const NOTES = "e37c9d21-0b48-4a6e-95f3-2d81b4c06fa7";

/**
 * Three documents in a throwaway directory, one citing another by uuid — enough
 * corpus for "imports all of them", "writes nothing twice" and "links resolve"
 * to mean something, and small enough to read.
 */
function writeCorpus(): string {
  const dir = tempDir();
  const files: [string, string, string, string][] = [
    ["overview.md", OVERVIEW, "Overview", `links:\n  - ${INSTALL}\n`],
    ["install.md", INSTALL, "Install and run", ""],
    ["notes.md", NOTES, "Notes", ""],
  ];
  for (const [file, uuid, title, extra] of files) {
    writeFileSync(
      join(dir, file),
      `---\nuuid: ${uuid}\ntitle: ${title}\ndescription: What ${title} is for.\ntags: [reference]\n${extra}---\n\n` +
        `## ${title}\n\nOne paragraph in ${title}.\n`,
    );
  }
  return dir;
}

let corpusDir: string;
let seeds: ReturnType<typeof readSeedDocs>;
beforeEach(() => {
  corpusDir = writeCorpus();
  seeds = readSeedDocs(corpusDir);
});

afterEach(async () => {
  await cleanupTestResources({
  });
});

describe("seed import", () => {
  // Identity comes from the file and is never invented: a generated uuid would
  // make every `ub workspace create` write the starter documents again, as new ones.
  it("refuses a template without identity rather than inventing one", () => {
    const nameless = tempDir();
    writeFileSync(
      join(nameless, "nameless.md"),
      "## No frontmatter\n\nProse.\n",
    );
    expect(() => readSeedDocs(nameless)).toThrow(/no `uuid` in frontmatter/);

    const untitled = tempDir();
    writeFileSync(
      join(untitled, "untitled.md"),
      `---\nuuid: ${NOTES}\ntags: [reference]\n---\n\nProse.\n`,
    );
    expect(() => readSeedDocs(untitled)).toThrow(/no `title` in frontmatter/);
  });

  // Sorting a listing by age is the whole reason the stamps exist, and a
  // corpus that arrived through the importer rather than through create_doc
  // must be sortable too.

  // The failure this defends against is the expensive one: a second machine
  // running the importer against a hub that already holds the corpus must not
  // append a second copy of every block into the very same rooms. "Does this
  // document exist?" has to be asked of the hub, not of the local database.

  // The same protection one level down, for the case the two-pass wait cannot
  // cover: the directory named a document but its room never arrived. Writing
  // then is what duplicates a corpus, so the importer refuses instead.

  // The write is one-time: after it, the document belongs to whoever edits it
  // through the MCP tools. A re-run — even against a template that has since
  // changed — must not reach into a live document, because the importer cannot
  // tell an edited file from an edited document.

  // The log is the authoritative replica, so an append it refuses means the
  // documents in memory are ahead of the only durable copy. Reporting them as
  // imported would be a lie a teardown then throws away.
  it("fails the run when the log refuses a write", async () => {
    const databasePath = ":memory:";
    const faulty = new FailingStore(databasePath, WORKSPACE);
    const replicas = new Replicas(testConfig({ databasePath }), faulty);
    try {
      faulty.failing = true;
      await expect(importSeedDocs(replicas, seeds)).rejects.toThrow(
        PersistenceError,
      );
      // Nothing was made durable, so nothing may be reported as imported.
      expect(faulty.logSize()).toBe(0);
      // And it stopped at the first failure rather than working through the rest:
      // the second document was never written.
      const later = seeds[1];
      if (later === undefined)
        throw new Error("expected more than one fixture doc");
      expect(getMeta(replicas.replica(later.uuid).doc).uuid).toBe("");
    } finally {
      await replicas.destroy();
      faulty.close();
    }
  });

  // The whole export round trip on one fixture this test owns: frontmatter, a
  // heading, an unlabelled fence and a mermaid fence.
  
});

/**
 * The starter sidebar an `ub workspace create` asks {@link importSeedDir} for.
 *
 * The CLI owns the real one and proves the whole path end to end; this suite
 * owns the boundary the CLI cannot reach from outside, which is what happens
 * when the layout the pins describe is not actually there.
 */
