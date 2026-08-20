/**
 * The seed import — contract level.
 *
 * The importer's job is that the product's own docs end up inside the product
 * and stay there: every seed file becomes a discoverable document, a second run
 * writes nothing, the link graph is real, and the content survives the round
 * trip out to markdown. Each test here is one of those.
 *
 * The assertions go through the real MCP tools wherever an acceptance criterion
 * names one (list_docs, search, backlinks, export_markdown), on a server opened
 * over the same database the importer wrote — which is also the proof that the
 * import went into the shared update log and not somewhere private.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import type { Hub } from "@uberblick/hub";
import { getBlocks, roomForDoc, upsertDirectoryEntry } from "@uberblick/schema";
import { Replicas } from "../src/replica.js";
import { MirrorStore } from "../src/store.js";
import { importSeedDocs, readSeedDocs } from "../src/seed.js";
import type { SeedImport } from "../src/seed.js";
import {
  TEST_SECRET,
  WORKSPACE,
  hubUrl,
  peerClient,
  removeTempDirs,
  startHub,
  startServer,
  tempDatabasePath,
  tempDir,
  testConfig,
} from "./helpers.js";
import type { PeerClient } from "./helpers.js";

interface ImportRun {
  results: SeedImport[];
  /** Log entries after the run — the no-op proof for a re-import. */
  logEntries: number;
}

/**
 * Run the importer over a database the way the CLI does: its own store, its own
 * replica set, closed afterwards. Two runs against one path are therefore two
 * independent processes as far as the log is concerned.
 *
 * With no `port` the config points at a dead address and carries no secret, so
 * the run is the offline one — the path that must always work.
 */
async function runImport(
  databasePath: string,
  dir?: string,
  port?: number,
): Promise<ImportRun> {
  const config = testConfig({
    databasePath,
    ...(port === undefined
      ? {}
      : { hubUrl: hubUrl(port), authSecret: TEST_SECRET }),
  });
  const store = new MirrorStore(databasePath);
  const replicas = new Replicas(config, store);
  try {
    const results = await importSeedDocs(replicas, readSeedDocs(dir));
    return { results, logEntries: store.logSize() };
  } finally {
    replicas.destroy();
    store.close();
  }
}

const seeds = readSeedDocs();

function seedUuid(file: string): string {
  const seed = seeds.find((candidate) => candidate.file === file);
  if (seed === undefined) throw new Error(`no seed file ${file}`);
  return seed.uuid;
}

const hubs: Hub[] = [];
const peers: PeerClient[] = [];

afterEach(async () => {
  for (const peer of peers.splice(0)) {
    peer.destroy();
  }
  for (const hub of hubs.splice(0)) {
    await hub.stop().catch(() => {});
  }
});

afterAll(() => {
  removeTempDirs();
});

describe("seed import", () => {
  it("parses every seed file with identity, a title and a tag", () => {
    expect(seeds.length).toBeGreaterThanOrEqual(9);
    for (const seed of seeds) {
      expect(seed.uuid).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
      expect(seed.title).not.toBe("");
      expect(seed.tags).toHaveLength(1);
      expect(seed.blocks.length).toBeGreaterThan(0);
    }
  });

  it("imports every seed doc, and list_docs finds all of them", async () => {
    const databasePath = tempDatabasePath();
    const run = await runImport(databasePath);

    expect(run.results).toHaveLength(seeds.length);
    expect(run.results.map((result) => result.action)).toEqual(
      seeds.map(() => "created"),
    );

    const rig = await startServer(testConfig({ databasePath }));
    try {
      const listed = await rig.ok("list_docs");
      expect(
        (listed.docs as { uuid: string }[]).map((doc) => doc.uuid).sort(),
      ).toEqual(seeds.map((seed) => seed.uuid).sort());
      // The title in the directory is the title from the file's frontmatter.
      const stubs = new Map(
        (listed.docs as { uuid: string; title: string }[]).map((doc) => [
          doc.uuid,
          doc.title,
        ]),
      );
      for (const seed of seeds) {
        expect(stubs.get(seed.uuid)).toBe(seed.title);
      }
    } finally {
      await rig.close();
    }
  });

  it("re-running writes nothing at all", async () => {
    const databasePath = tempDatabasePath();
    const first = await runImport(databasePath);
    const second = await runImport(databasePath);

    expect(second.results.map((result) => result.action)).toEqual(
      seeds.map(() => "unchanged"),
    );
    // The strong form of "no duplicates": an unchanged re-import appends no
    // updates whatsoever, so there is nothing that could have duplicated.
    expect(second.logEntries).toBe(first.logEntries);

    const rig = await startServer(testConfig({ databasePath }));
    try {
      const listed = await rig.ok("list_docs");
      expect(listed.docs).toHaveLength(seeds.length);
      const doc = await rig.ok("get_doc", { uuid: seedUuid("overview.md") });
      const overview = seeds.find((seed) => seed.file === "overview.md");
      expect(doc.blocks).toHaveLength(overview?.blocks.length ?? -1);
    } finally {
      await rig.close();
    }
  });

  // The failure this defends against is the expensive one: a second machine
  // running the importer against a hub that already holds the corpus must not
  // append a second copy of every block into the very same rooms. "Does this
  // document exist?" has to be asked of the hub, not of the local database.
  it("does not duplicate a corpus the hub already holds", async () => {
    const hub = await startHub();
    hubs.push(hub);

    const first = await runImport(tempDatabasePath(), undefined, hub.port);
    expect(first.results.map((result) => result.action)).toEqual(
      seeds.map(() => "created"),
    );
    expect(first.results.every((result) => result.synced)).toBe(true);
    await hub.flush();

    // A different machine: empty database, same hub.
    const second = await runImport(tempDatabasePath(), undefined, hub.port);
    expect(second.results.map((result) => result.action)).toEqual(
      seeds.map(() => "unchanged"),
    );

    // What the hub holds is the proof — one copy of each block, not two merged.
    for (const seed of seeds) {
      const client = await peerClient(hub.port, roomForDoc(WORKSPACE, seed.uuid));
      peers.push(client);
      await client.synced;
      expect(getBlocks(client.doc).map((block) => block.text)).toEqual(
        seed.blocks.map((block) => block.text),
      );
    }
  });

  // The same protection one level down, for the case the two-pass wait cannot
  // cover: the directory named a document but its room never arrived. Writing
  // then is what duplicates a corpus, so the importer refuses instead.
  it("skips a doc the directory knows but this replica never received", async () => {
    const databasePath = tempDatabasePath();
    const store = new MirrorStore(databasePath);
    // A secret with an unreachable hub: sync is enabled, so a stub with no
    // document means "somewhere else has it", not "it does not exist".
    const replicas = new Replicas(
      testConfig({ databasePath, authSecret: TEST_SECRET }),
      store,
    );
    try {
      const seed = seeds[0];
      if (seed === undefined) throw new Error("no seed docs");
      upsertDirectoryEntry(replicas.directory().doc, {
        uuid: seed.uuid,
        title: seed.title,
        tags: seed.tags,
      });

      const results = await importSeedDocs(replicas, [seed]);
      expect(results[0]?.action).toBe("skipped");
      // Nothing was written into the room it refused to touch.
      expect(getBlocks(replicas.replica(seed.uuid).doc)).toHaveLength(0);
    } finally {
      replicas.destroy();
      store.close();
    }
  });

  it("reconciles a changed file in place, keeping block ids", async () => {
    const dir = tempDir();
    const uuid = "1f4a2c7e-1b3d-4f9a-8c21-9b6d0e5a7c33";
    const write = (body: string): void => {
      writeFileSync(
        join(dir, "doc.md"),
        `---\nuuid: ${uuid}\ntitle: Reconciled\ntags: [reference]\n---\n\n${body}`,
      );
    };

    write("## First\n\nOriginal prose.\n");
    const databasePath = tempDatabasePath();
    await runImport(databasePath, dir);

    const before = await startServer(testConfig({ databasePath }));
    const ids = await before
      .ok("get_doc", { uuid })
      .then((doc) => (doc.blocks as { id: string }[]).map((block) => block.id));
    await before.close();

    write("## First\n\nEdited prose.\n\nA new paragraph.\n");
    const second = await runImport(databasePath, dir);
    expect(second.results[0]?.action).toBe("updated");

    const rig = await startServer(testConfig({ databasePath }));
    try {
      const doc = await rig.ok("get_doc", { uuid });
      const blocks = doc.blocks as { id: string; type: string; text: string }[];
      expect(blocks.map((block) => block.text)).toEqual([
        "First",
        "Edited prose.",
        "A new paragraph.",
      ]);
      // An edit is an edit, not a replacement: the blocks that existed keep the
      // ids every annotation anchor and inbound reference depends on.
      expect(blocks.slice(0, 2).map((block) => block.id)).toEqual(ids);
    } finally {
      await rig.close();
    }
  });

  it("makes seed docs findable by a distinctive phrase", async () => {
    const databasePath = tempDatabasePath();
    await runImport(databasePath);

    const rig = await startServer(testConfig({ databasePath }));
    try {
      const found = await rig.ok("search", { query: "clobbering" });
      expect((found.hits as { uuid: string }[]).map((hit) => hit.uuid)).toEqual([
        seedUuid("overview.md"),
      ]);

      const phrase = await rig.ok("search", {
        query: "Hocuspocus hub with SQLite persistence",
      });
      expect((phrase.hits as { uuid: string }[]).map((hit) => hit.uuid)).toContain(
        seedUuid("overview.md"),
      );
    } finally {
      await rig.close();
    }
  });

  it("resolves inter-doc links to UUIDs, so backlinks names the citing doc", async () => {
    const databasePath = tempDatabasePath();
    await runImport(databasePath);

    const rig = await startServer(testConfig({ databasePath }));
    try {
      const install = seedUuid("install.md");
      const overview = seedUuid("overview.md");

      const doc = await rig.ok("get_doc", { uuid: overview });
      expect(doc.links).toContain(install);

      const cited = await rig.ok("backlinks", { uuid: install });
      expect(
        (cited.backlinks as { uuid: string }[]).map((entry) => entry.uuid),
      ).toContain(overview);
    } finally {
      await rig.close();
    }
  });

  it("exports an imported doc with its headings and fenced code intact", async () => {
    const databasePath = tempDatabasePath();
    await runImport(databasePath);

    const rig = await startServer(testConfig({ databasePath }));
    try {
      const exported = await rig.ok("export_markdown", {
        uuid: seedUuid("install.md"),
      });
      const markdown = exported.markdown as string;
      expect(markdown).toContain("title: Install and run");
      expect(markdown).toContain("## Prerequisites");
      expect(markdown).toContain(
        "```\ngit clone https://github.com/uberblick-ai/uberblick-2.git",
      );
    } finally {
      await rig.close();
    }
  });

  // The seed corpus happens to contain no mermaid block, so the mermaid half of
  // the round trip is proven on a seed file of the same shape, imported through
  // the same path.
  it("exports a mermaid fence as a mermaid fence", async () => {
    const dir = tempDir();
    const uuid = "2c9e5b71-8d34-4a6f-9e12-7f0b3a4d8c56";
    writeFileSync(
      join(dir, "diagram.md"),
      `---\nuuid: ${uuid}\ntitle: Diagram\ntags: [reference]\n---\n\n` +
        "## Flow\n\n```mermaid\ngraph TD\n  a[Agent] --> h[Hub]\n```\n",
    );

    const databasePath = tempDatabasePath();
    await runImport(databasePath, dir);

    const rig = await startServer(testConfig({ databasePath }));
    try {
      const exported = await rig.ok("export_markdown", { uuid });
      expect(exported.markdown as string).toContain(
        "```mermaid\ngraph TD\n  a[Agent] --> h[Hub]\n```",
      );
    } finally {
      await rig.close();
    }
  });
});
