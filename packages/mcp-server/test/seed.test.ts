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
import {
  getBlocks,
  getDirectoryMap,
  getMeta,
  isSidebarSeeded,
  readSidebar,
  roomForDoc,
  tombstoneDirectoryEntry,
  upsertDirectoryEntry,
} from "@uberblick/schema";
import { PersistenceError, Replicas } from "../src/replica.js";
import { MirrorStore } from "../src/store.js";
import { importSeedDir, importSeedDocs, readSeedDocs } from "../src/seed.js";
import type { SeedImport } from "../src/seed.js";
import {
  FailingStore,
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
  const store = new MirrorStore(databasePath, WORKSPACE);
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
  // What the importer needs from a seed file, not what the corpus happens to
  // look like today: identity it can key on, a title, and something to import.
  it("parses every seed file with identity, a title and a tag", () => {
    expect(seeds.length).toBeGreaterThanOrEqual(9);
    for (const seed of seeds) {
      expect(seed.uuid).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
      expect(seed.title).not.toBe("");
      expect(seed.tags.length).toBeGreaterThanOrEqual(1);
      expect(seed.blocks.length).toBeGreaterThan(0);
    }
  });

  it("imports every seed doc, and list_docs and search find all of them", async () => {
    const databasePath = tempDatabasePath();
    const run = await runImport(databasePath);

    expect(run.results).toHaveLength(seeds.length);
    expect(run.results.map((result) => result.action)).toEqual(
      seeds.map(() => "created"),
    );

    // A tenth document whose wording this test owns, so the FTS assertion below
    // does not depend on what the real corpus happens to say today — editing a
    // seed file must never break a test.
    const dir = tempDir();
    const extra = "5b1c0f8a-7d21-4e93-8a04-6c2f9d1b3e77";
    const phrase = "quarrelsome zeppelin";
    writeFileSync(
      join(dir, "extra.md"),
      `---\nuuid: ${extra}\ntitle: Extra\ntags: [reference]\n---\n\n` +
        `A ${phrase} landed here.\n`,
    );
    await runImport(databasePath, dir);

    const rig = await startServer(testConfig({ databasePath }));
    try {
      const listed = await rig.ok("list_docs");
      expect(
        (listed.docs as { uuid: string }[]).map((doc) => doc.uuid).sort(),
      ).toEqual([...seeds.map((seed) => seed.uuid), extra].sort());
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

      // Imported text reaches the FTS index: one word and a whole phrase both
      // find the document that carries them, and nothing else.
      const word = await rig.ok("search", { query: "zeppelin" });
      expect((word.hits as { uuid: string }[]).map((hit) => hit.uuid)).toEqual([
        extra,
      ]);
      const found = await rig.ok("search", { query: phrase });
      expect((found.hits as { uuid: string }[]).map((hit) => hit.uuid)).toEqual([
        extra,
      ]);
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

  // Sorting a listing by age is the whole reason the stamps exist, and a
  // corpus that arrived through the importer rather than through create_doc
  // must be sortable too.
  it("stamps createdAt on import, and a re-run backfills a stub without one", async () => {
    const databasePath = tempDatabasePath();
    await runImport(databasePath);
    const uuid = seedUuid("overview.md");

    const rig = await startServer(testConfig({ databasePath }));
    let stamped: number;
    try {
      const listed = await rig.ok("list_docs");
      for (const entry of listed.docs) {
        expect(entry.createdAt).toEqual(expect.any(Number));
      }
      stamped = listed.docs.find((entry: any) => entry.uuid === uuid).createdAt;
      // Strip the stamps the way a stub written before the fields existed would
      // have them: nothing at all.
      getDirectoryMap(rig.instance.replicas.directory().doc).set(uuid, {
        title: "Overview",
        tags: [],
      });
    } finally {
      await rig.close();
    }

    await runImport(databasePath);

    const after = await startServer(testConfig({ databasePath }));
    try {
      const listed = await after.ok("list_docs");
      const entry = listed.docs.find((row: any) => row.uuid === uuid);
      // Backfilled, not restored: the importer stamps the time it noticed, so
      // the value is new. The point is that the field is no longer missing.
      expect(entry.createdAt).toEqual(expect.any(Number));
      expect(entry.createdAt).toBeGreaterThanOrEqual(stamped);
    } finally {
      await after.close();
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
    const store = new MirrorStore(databasePath, WORKSPACE);
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

  // The import is one-time: after it, the document belongs to whoever edits it
  // through the MCP tools. A re-run — even against a seed file that has since
  // changed — must not reach into a live document, because the importer cannot
  // tell an edited file from an edited document.
  it("leaves live edits alone on a re-run, even when the file changed", async () => {
    const dir = tempDir();
    const uuid = "1f4a2c7e-1b3d-4f9a-8c21-9b6d0e5a7c33";
    const write = (body: string, tags: string): void => {
      writeFileSync(
        join(dir, "doc.md"),
        `---\nuuid: ${uuid}\ntitle: Imported once\ntags: [${tags}]\n---\n\n${body}`,
      );
    };

    write("## First\n\nOriginal prose.\n", "reference");
    const databasePath = tempDatabasePath();
    await runImport(databasePath, dir);

    // A human or an agent edits the document through the tools.
    const editing = await startServer(testConfig({ databasePath }));
    const imported = await editing.ok("get_doc", { uuid });
    const paragraph = (imported.blocks as { id: string; text: string }[])[1];
    if (paragraph === undefined) throw new Error("expected a paragraph block");
    await editing.ok("edit_block", {
      uuid,
      block_id: paragraph.id,
      old_text: "Original prose.",
      new_text: "Prose an agent rewrote.",
    });
    await editing.ok("set_tags", { uuid, tags: ["feature"] });
    const added = await editing.ok("insert_block", {
      uuid,
      after_block_id: paragraph.id,
      type: "paragraph",
      text: "A block the seed file never had.",
    });
    await editing.close();

    // The seed file moves on too: different prose, a deleted block, new tags.
    write("## First\n\nProse only the file has.\n", "verify");
    const second = await runImport(databasePath, dir);
    expect(second.results[0]?.action).toBe("unchanged");
    expect(second.results[0]?.reason).toBeNull();

    const rig = await startServer(testConfig({ databasePath }));
    try {
      const doc = await rig.ok("get_doc", { uuid });
      // Every live edit survived, and nothing from the changed file landed.
      expect((doc.blocks as { text: string }[]).map((block) => block.text)).toEqual([
        "First",
        "Prose an agent rewrote.",
        "A block the seed file never had.",
      ]);
      expect(doc.tags).toEqual(["feature"]);
      expect((doc.blocks as { id: string }[])[1]?.id).toBe(paragraph.id);
      expect((doc.blocks as { id: string }[])[2]?.id).toBe(added.block.id);
    } finally {
      await rig.close();
    }
  });

  // A tombstone is sticky: upserting a deleted entry keeps it deleted, so a
  // document written here could never be listed. That is a conflict for a human,
  // not something to do quietly and report as success.
  it("skips a tombstoned uuid instead of writing a doc nothing can list", async () => {
    const databasePath = tempDatabasePath();
    const store = new MirrorStore(databasePath, WORKSPACE);
    const replicas = new Replicas(testConfig({ databasePath }), store);
    try {
      const seed = seeds[0];
      if (seed === undefined) throw new Error("no seed docs");
      tombstoneDirectoryEntry(replicas.directory().doc, seed.uuid);

      const results = await importSeedDocs(replicas, [seed]);
      expect(results[0]?.action).toBe("skipped");
      expect(results[0]?.reason).toContain("tombstoned");
      expect(getBlocks(replicas.replica(seed.uuid).doc)).toHaveLength(0);
      expect(getMeta(replicas.replica(seed.uuid).doc).uuid).toBe("");
    } finally {
      replicas.destroy();
      store.close();
    }
  });

  // The log is the authoritative replica, so an append it refuses means the
  // documents in memory are ahead of the only durable copy. Reporting them as
  // imported would be a lie a teardown then throws away.
  it("fails the run when the log refuses a write", async () => {
    const databasePath = tempDatabasePath();
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
      if (later === undefined) throw new Error("expected more than one seed doc");
      expect(getMeta(replicas.replica(later.uuid).doc).uuid).toBe("");
    } finally {
      replicas.destroy();
      faulty.close();
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

  // The whole export round trip on one fixture this test owns: frontmatter, a
  // heading, an unlabelled fence and a mermaid fence — the corpus happens to
  // contain no mermaid block, and its wording is not this test's business.
  it("exports an imported doc with headings and both kinds of fence intact", async () => {
    const dir = tempDir();
    const uuid = "2c9e5b71-8d34-4a6f-9e12-7f0b3a4d8c56";
    writeFileSync(
      join(dir, "diagram.md"),
      `---\nuuid: ${uuid}\ntitle: Diagram\ntags: [reference]\n---\n\n` +
        "## Flow\n\n```\ngit clone git@example.com:uberblick.git\n```\n\n" +
        "```mermaid\ngraph TD\n  a[Agent] --> h[Hub]\n```\n",
    );

    const databasePath = tempDatabasePath();
    await runImport(databasePath, dir);

    const rig = await startServer(testConfig({ databasePath }));
    try {
      const exported = await rig.ok("export_markdown", { uuid });
      const markdown = exported.markdown as string;
      expect(markdown).toContain("title: Diagram");
      expect(markdown).toContain("## Flow");
      expect(markdown).toContain(
        "```\ngit clone git@example.com:uberblick.git\n```",
      );
      expect(markdown).toContain(
        "```mermaid\ngraph TD\n  a[Agent] --> h[Hub]\n```",
      );
    } finally {
      await rig.close();
    }
  });
});

/**
 * The starter sidebar an `ub init` asks {@link importSeedDir} for.
 *
 * The CLI owns the real one and proves the whole path end to end; this suite
 * owns the boundary the CLI cannot reach from outside, which is what happens
 * when the layout the pins describe is not actually there.
 */
describe("starter sidebar seed", () => {
  const first = "b4e1c206-9f38-4d5a-8c71-0a2b6e93f157";
  const second = "d0c37a51-2e64-4b98-a13f-5c8e70d6b249";
  const group = { id: "57a27e40-0000-4000-8000-0000000000ff", name: "Starter" };

  /** Two importable documents. */
  function starterDir(): string {
    const dir = tempDir();
    for (const [uuid, title] of [
      [first, "First"],
      [second, "Second"],
    ]) {
      writeFileSync(
        join(dir, `${title}.md`),
        `---\nuuid: ${uuid}\ntitle: ${title}\ntags: [start-here]\n---\n\nOne paragraph.\n`,
      );
    }
    return dir;
  }

  /** The sidebar as a fresh replica set hydrated from the log alone sees it. */
  function sidebarOf(databasePath: string): {
    groups: ReturnType<typeof readSidebar>;
    seeded: boolean;
  } {
    const store = new MirrorStore(databasePath, WORKSPACE);
    const replicas = new Replicas(testConfig({ databasePath }), store);
    try {
      const doc = replicas.sidebar().doc;
      return { groups: readSidebar(doc), seeded: isSidebarSeeded(doc) };
    } finally {
      replicas.destroy();
      store.close();
    }
  }

  it("pins the documents in the order it was given, and marks the sidebar seeded", async () => {
    const databasePath = tempDatabasePath();
    const outcome = await importSeedDir(
      starterDir(),
      testConfig({ databasePath }),
      { ...group, docs: [second, first] },
    );

    expect(outcome.sidebar).toBe(true);
    expect(sidebarOf(databasePath)).toEqual({
      groups: [{ ...group, docs: [second, first] }],
      seeded: true,
    });
  });

  it("pins nothing when a document it would pin is tombstoned", async () => {
    // The pins are a promise that the layout exists. A document the user threw
    // away breaks it — and a half-layout must not be declared seeded either,
    // because the marker would stop the repair that is still owed.
    const databasePath = tempDatabasePath();
    const dir = starterDir();
    await importSeedDir(dir, testConfig({ databasePath }));

    const store = new MirrorStore(databasePath, WORKSPACE);
    const replicas = new Replicas(testConfig({ databasePath }), store);
    try {
      tombstoneDirectoryEntry(replicas.directory().doc, first);
    } finally {
      replicas.destroy();
      store.close();
    }

    const outcome = await importSeedDir(dir, testConfig({ databasePath }), {
      ...group,
      docs: [first, second],
    });

    expect(outcome.sidebar).toBe(false);
    expect(sidebarOf(databasePath)).toEqual({ groups: [], seeded: false });
  });

  it("adopts a sidebar that already holds a group rather than seeding beside it", async () => {
    // Curation — a user's, another client's, or the MCP server's own legacy tag
    // migration — is exactly what a seed must not write over.
    const curated = "57a27e40-0000-4000-8000-0000000000fe";
    const databasePath = tempDatabasePath();
    const dir = starterDir();
    await importSeedDir(dir, testConfig({ databasePath }), {
      id: curated,
      name: "Mine",
      docs: [first],
    });

    const outcome = await importSeedDir(dir, testConfig({ databasePath }), {
      ...group,
      docs: [first, second],
    });

    expect(outcome.sidebar).toBe(false);
    expect(sidebarOf(databasePath).groups).toEqual([
      { id: curated, name: "Mine", docs: [first] },
    ]);
  });
});
