/**
 * Block-scoped writes: what happens when they conflict, and what the derived
 * index does afterwards.
 *
 * Two MCP servers sharing one database is the normal case (a user runs their
 * agent twice), so the concurrency test uses exactly that rather than a mocked
 * second replica: each instance appends to the shared log, and each picks the
 * other up by polling the log tail at tool-call start.
 */

import { afterAll, afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  getBlocksFragment,
  getDirectoryEntry,
  setBlockType,
  tombstoneDirectoryEntry,
  upsertDirectoryEntry,
} from "@uberblick/schema";
import { blockText } from "../src/replica.js";
import { removeTempDirs, startServer, testConfig } from "./helpers.js";
import type { Rig } from "./helpers.js";

const rigs: Rig[] = [];

async function localRig(databasePath?: string): Promise<Rig> {
  const rig = await startServer(
    testConfig(databasePath === undefined ? {} : { databasePath }),
  );
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

describe("edit_block", () => {
  it("refuses a stale old_text and hands back the re-read payload", async () => {
    const rig = await localRig();
    const doc = await rig.ok("create_doc", {
      title: "Conflict",
      description: "A test document.",
      blocks: [{ type: "paragraph", text: "the current text" }],
    });
    const block = doc.blocks[0];

    const stale = await rig.call("edit_block", {
      uuid: doc.uuid,
      block_id: block.id,
      old_text: "what I thought was there",
      new_text: "my version",
    });

    expect(stale.isError).toBe(true);
    expect(stale.payload.error).toBe("stale_block");
    expect(stale.payload.currentText).toBe("the current text");
    expect(stale.payload.currentRev).toBe(block.rev);

    // The refused edit changed nothing.
    const read = await rig.ok("get_doc", { uuid: doc.uuid });
    expect(read.blocks[0].text).toBe("the current text");
  });

  it("refuses a stale rev even when old_text still matches", async () => {
    const rig = await localRig();
    const doc = await rig.ok("create_doc", {
      title: "Revs",
      description: "A test document.",
      blocks: [{ type: "paragraph", text: "first" }],
    });
    const staleRev = doc.blocks[0].rev;

    await rig.ok("edit_block", {
      uuid: doc.uuid,
      block_id: doc.blocks[0].id,
      old_text: "first",
      new_text: "second",
    });

    const refused = await rig.call("edit_block", {
      uuid: doc.uuid,
      block_id: doc.blocks[0].id,
      old_text: "second",
      new_text: "third",
      rev: staleRev,
    });

    expect(refused.isError).toBe(true);
    expect(refused.payload.error).toBe("stale_block");
    expect(refused.payload.expectedRev).toBe(staleRev);
    expect(refused.payload.currentText).toBe("second");
    expect(refused.payload.currentRev).not.toBe(staleRev);
  });

  it("merges concurrent edits to different blocks across two instances", async () => {
    const databasePath = testConfig().databasePath;
    const first = await localRig(databasePath);
    const doc = await first.ok("create_doc", {
      title: "Two agents",
      description: "A test document.",
      blocks: [
        { type: "paragraph", text: "block one" },
        { type: "paragraph", text: "block two" },
      ],
    });

    const second = await localRig(databasePath);
    const seen = await second.ok("get_doc", { uuid: doc.uuid });
    expect(seen.blocks.map((block: { text: string }) => block.text)).toEqual([
      "block one",
      "block two",
    ]);

    // Neither instance has seen the other's edit when it makes its own.
    const [one, two] = await Promise.all([
      first.ok("edit_block", {
        uuid: doc.uuid,
        block_id: seen.blocks[0].id,
        old_text: "block one",
        new_text: "block one, edited by the first agent",
        rev: seen.blocks[0].rev,
      }),
      second.ok("edit_block", {
        uuid: doc.uuid,
        block_id: seen.blocks[1].id,
        old_text: "block two",
        new_text: "block two, edited by the second agent",
        rev: seen.blocks[1].rev,
      }),
    ]);
    expect(one.applied).toBe(true);
    expect(two.applied).toBe(true);

    for (const rig of [first, second]) {
      const merged = await rig.ok("get_doc", { uuid: doc.uuid });
      expect(merged.blocks.map((block: { text: string }) => block.text)).toEqual(
        [
          "block one, edited by the first agent",
          "block two, edited by the second agent",
        ],
      );
    }
  });
});

describe("duplicate blocks from concurrent re-types", () => {
  // This package's own claim: observing a duplicate-producing update triggers
  // the repair, so the document is fixed and not merely read around. That two
  // replicas repairing independently still converge on one element is a schema
  // property, pinned in schema/test/retype.test.ts.
  it("repairs them the moment the replica observes them", async () => {
    const rig = await localRig();
    const doc = await rig.ok("create_doc", {
      title: "Re-types",
      description: "A test document.",
      blocks: [{ type: "paragraph", text: "shared text" }],
    });
    const blockId = doc.blocks[0].id;

    // Two clients re-type the same block while offline from each other — the
    // race that leaves two elements carrying one block id.
    const replicaDoc = rig.instance.replicas.replica(doc.uuid).doc;
    const state = Y.encodeStateAsUpdate(replicaDoc);
    const updates = (["heading", "code"] as const).map((type) => {
      const scratch = new Y.Doc();
      Y.applyUpdate(scratch, state);
      const before = Y.encodeStateVector(scratch);
      setBlockType(scratch, blockId, type);
      return Y.encodeStateAsUpdate(scratch, before);
    });

    // Who should survive: the first element in document order once both
    // re-types have merged, with no repair involved.
    const merged = new Y.Doc();
    Y.applyUpdate(merged, state);
    for (const update of updates) Y.applyUpdate(merged, update);
    const winner = (getBlocksFragment(merged).get(0) as Y.XmlElement).nodeName;
    expect(getBlocksFragment(merged).length).toBe(2);

    for (const update of updates) Y.applyUpdate(replicaDoc, update);

    // Repaired in the document by the observation itself, before any read.
    expect(getBlocksFragment(replicaDoc).length).toBe(1);

    const read = await rig.ok("get_doc", { uuid: doc.uuid });
    expect(read.blocks).toHaveLength(1);
    expect(read.blocks[0].id).toBe(blockId);
    expect(read.blocks[0].type).toBe(winner);
    expect(read.blocks[0].text).toBe("shared text");
  });
});

describe("the directory stub as a cache", () => {
  // CLAUDE.md: on conflict `meta.title` in the doc is authoritative and the
  // stub is a cache repaired on write/connect. Nothing tested that a stub which
  // is merely WRONG — not missing — is corrected, which is the case a foreign
  // or half-finished writer actually produces.
  it("is repaired from the document when it disagrees", async () => {
    const rig = await localRig();
    const doc = await rig.ok("create_doc", {
      title: "The real title",
      description: "A test document.",
      tags: ["reference"],
      blocks: [{ type: "paragraph", text: "body" }],
    });

    // Corrupt the stub directly on the directory doc: wrong title, wrong tags.
    // A foreign or half-finished writer leaves exactly this.
    const directory = rig.instance.replicas.directory().doc;
    upsertDirectoryEntry(directory, {
      uuid: doc.uuid,
      title: "A stale, wrong title",
      tags: ["wrong"],
    });
    // The corruption is real — without this the rest would prove nothing.
    expect(getDirectoryEntry(directory, doc.uuid)).toMatchObject({
      title: "A stale, wrong title",
      tags: ["wrong"],
    });

    // The next tool call settles, and the settle repairs the cache from the
    // document that owns the truth.
    const listed = await rig.ok("list_docs");
    const stub = (
      listed.docs as { uuid: string; title: string; tags: string[] }[]
    ).find((entry) => entry.uuid === doc.uuid);
    expect(stub?.title).toBe("The real title");
    expect(stub?.tags).toEqual(["reference"]);

    // Repaired in the directory doc itself, not masked by the read path — the
    // next replica to sync the directory gets the corrected stub.
    expect(getDirectoryEntry(directory, doc.uuid)).toMatchObject({
      title: "The real title",
      tags: ["reference"],
    });

    // And a write repairs it the same way, through the observer rather than the
    // poll.
    upsertDirectoryEntry(directory, {
      uuid: doc.uuid,
      title: "Wrong again",
      tags: [],
    });
    await rig.ok("edit_block", {
      uuid: doc.uuid,
      block_id: doc.blocks[0].id,
      old_text: "body",
      new_text: "body, edited",
    });
    expect(getDirectoryEntry(directory, doc.uuid)).toMatchObject({
      title: "The real title",
      tags: ["reference"],
    });
  });
});

describe("the derived index", () => {
  it("follows edits", async () => {
    const rig = await localRig();
    const doc = await rig.ok("create_doc", {
      title: "Searchable",
      description: "A test document.",
      blocks: [{ type: "paragraph", text: "aardvark" }],
    });

    const before = await rig.ok("search", { query: "aardvark" });
    expect(before.hits.map((hit: { uuid: string }) => hit.uuid)).toEqual([
      doc.uuid,
    ]);

    await rig.ok("edit_block", {
      uuid: doc.uuid,
      block_id: doc.blocks[0].id,
      old_text: "aardvark",
      new_text: "zebra",
      rev: doc.blocks[0].rev,
    });

    expect((await rig.ok("search", { query: "aardvark" })).hits).toEqual([]);
    expect(
      (await rig.ok("search", { query: "zebra" })).hits.map(
        (hit: { uuid: string }) => hit.uuid,
      ),
    ).toEqual([doc.uuid]);
  });

  it("follows set_links in both directions", async () => {
    const rig = await localRig();
    const source = await rig.ok("create_doc", { title: "Source", description: "A test document." });
    const target = await rig.ok("create_doc", { title: "Target", description: "A test document." });
    const other = await rig.ok("create_doc", { title: "Other", description: "A test document." });

    await rig.ok("set_links", {
      uuid: source.uuid,
      links: [target.uuid],
    });
    expect(
      (await rig.ok("backlinks", { uuid: target.uuid })).backlinks,
    ).toEqual([
      { uuid: source.uuid, title: "Source", description: "A test document." },
    ]);

    await rig.ok("set_links", { uuid: source.uuid, links: [other.uuid] });
    expect((await rig.ok("backlinks", { uuid: target.uuid })).backlinks).toEqual(
      [],
    );
    expect(
      (await rig.ok("backlinks", { uuid: other.uuid })).backlinks,
    ).toEqual([
      { uuid: source.uuid, title: "Source", description: "A test document." },
    ]);
  });

  it("counts an inline reference as an edge, and never writes meta.links", async () => {
    const rig = await localRig();
    const target = await rig.ok("create_doc", { title: "Target", description: "A test document." });
    const source = await rig.ok("create_doc", {
      title: "Source",
      description: "A test document.",
      blocks: [
        { type: "paragraph", text: "See the hub docs" },
        { type: "code", text: "const x = 1;", language: "ts" },
      ],
    });
    const [prose, code] = source.blocks;

    await rig.ok("link_range", {
      uuid: source.uuid,
      block_id: prose.id,
      start: 4,
      end: 11,
      doc_id: target.uuid,
      rev: prose.rev,
    });
    expect(
      (await rig.ok("backlinks", { uuid: target.uuid })).backlinks,
    ).toEqual([
      { uuid: source.uuid, title: "Source", description: "A test document." },
    ]);
    // The union is derived. `meta.links` stays the curated list set_links owns.
    expect((await rig.ok("get_doc", { uuid: source.uuid })).links).toEqual([]);

    // A document referring to itself is not an edge…
    await rig.ok("link_range", {
      uuid: source.uuid,
      block_id: prose.id,
      start: 12,
      end: 16,
      doc_id: source.uuid,
      rev: prose.rev,
    });
    expect((await rig.ok("backlinks", { uuid: source.uuid })).backlinks).toEqual(
      [],
    );

    // …and a source block is not scanned: it holds source text, so a docLink on
    // one is foreign content nothing renders and nothing counts.
    const other = await rig.ok("create_doc", { title: "Other", description: "A test document." });
    blockText(rig.instance.replicas.replica(source.uuid).doc, code.id)?.format(
      0,
      5,
      { docLink: { docId: other.uuid } },
    );
    expect((await rig.ok("backlinks", { uuid: other.uuid })).backlinks).toEqual(
      [],
    );
  });

  it("rebuilds an inline edge from a second instance's log replay", async () => {
    const databasePath = testConfig().databasePath;
    const first = await localRig(databasePath);
    const target = await first.ok("create_doc", { title: "Target", description: "A test document." });
    const source = await first.ok("create_doc", {
      title: "Source",
      description: "A test document.",
      blocks: [{ type: "paragraph", text: "See the hub docs" }],
    });
    await first.ok("link_range", {
      uuid: source.uuid,
      block_id: source.blocks[0].id,
      start: 4,
      end: 11,
      doc_id: target.uuid,
      rev: source.blocks[0].rev,
    });

    // A second server over the same log: it hydrates from the log alone, so
    // the edge has to come back out of the updates rather than out of any row.
    const second = await localRig(databasePath);
    await second.ok("list_docs", {});
    const store = second.instance.store;
    store.clearDerived();
    expect(store.backlinks(target.uuid)).toEqual([]);

    second.instance.replicas.rebuildIndex();
    expect(store.backlinks(target.uuid).map((row) => row.uuid)).toEqual([
      source.uuid,
    ]);
  });

  it("is derived: it can be thrown away and rebuilt from the replicas", async () => {
    const rig = await localRig();
    const doc = await rig.ok("create_doc", {
      title: "Rebuildable",
      description: "A test document.",
      blocks: [{ type: "paragraph", text: "pangolin" }],
    });
    const target = await rig.ok("create_doc", { title: "Pointed at", description: "A test document." });
    await rig.ok("set_links", { uuid: doc.uuid, links: [target.uuid] });

    // Asserted against the store, not through the tools: a tool call settles
    // first, and settling reindexes whatever it replays out of the log.
    const store = rig.instance.store;
    store.clearDerived();
    expect(store.search("pangolin", 10)).toEqual([]);
    expect(store.backlinks(target.uuid)).toEqual([]);

    rig.instance.replicas.rebuildIndex();

    expect(store.search("pangolin", 10).map((hit) => hit.uuid)).toEqual([
      doc.uuid,
    ]);
    expect(store.backlinks(target.uuid).map((row) => row.uuid)).toEqual([
      doc.uuid,
    ]);
  });

  it("carries a hit's tags without a query per hit", async () => {
    const rig = await localRig();
    const doc = await rig.ok("create_doc", {
      title: "Tagged",
      description: "A test document.",
      tags: ["alpha", "beta"],
      blocks: [{ type: "paragraph", text: "quokka" }],
    });

    const hits = await rig.ok("search", { query: "quokka" });
    expect(hits.hits).toEqual([
      {
        uuid: doc.uuid,
        title: "Tagged",
        tags: ["alpha", "beta"],
        description: "A test document.",
        // The description leads the indexed body, so a short document's
        // snippet window reaches back over it. That is the visible cost of
        // indexing the description as body text rather than as a column FTS5
        // cannot add — see MirrorStore's docs_fts.
        snippet: "A test document.\nquokka",
      },
    ]);

    // Retagging is reflected, so the packed column is not a stale cache.
    await rig.ok("set_tags", { uuid: doc.uuid, tags: ["gamma"] });
    expect((await rig.ok("search", { query: "quokka" })).hits[0].tags).toEqual([
      "gamma",
    ]);
  });

  it("packs tags losslessly, whatever they contain", async () => {
    const rig = await localRig();
    const doc = await rig.ok("create_doc", {
      title: "Awkward tags",
      description: "A test document.",
      blocks: [{ type: "paragraph", text: "bilby" }],
    });

    // Tags are arbitrary text. A tag holding the separator an in-band encoding
    // would use must survive as one tag, not two.
    const awkward = `one${String.fromCharCode(31)}two`;
    await rig.ok("set_tags", {
      uuid: doc.uuid,
      tags: [awkward, 'quote"and,comma', "[]"],
    });
    expect(
      (await rig.ok("search", { query: "bilby" })).hits[0].tags.sort(),
    ).toEqual([awkward, "[]", 'quote"and,comma'].sort());

    // And an empty tag — which only a foreign writer can produce, since the
    // tool rejects one — must not vanish from the row.
    rig.instance.store.indexDoc({
      uuid: doc.uuid,
      title: "Awkward tags",
      tags: ["", "after"],
      description: "",
      links: [],
      body: "bilby",
    });
    expect(rig.instance.store.search("bilby", 10)[0]?.tags).toEqual([
      "",
      "after",
    ]);
  });

  it("keeps a tombstoned document out of a rebuilt index", async () => {
    const rig = await localRig();
    const kept = await rig.ok("create_doc", {
      title: "Kept",
      description: "A test document.",
      blocks: [{ type: "paragraph", text: "numbat" }],
    });
    const deleted = await rig.ok("create_doc", {
      title: "Deleted elsewhere",
      description: "A test document.",
      blocks: [{ type: "paragraph", text: "numbat" }],
    });

    // A tombstone arriving from another client — there is no delete_doc tool.
    tombstoneDirectoryEntry(rig.instance.replicas.directory().doc, deleted.uuid);

    rig.instance.replicas.rebuildIndex();

    // The rebuild walks every attached replica, tombstoned ones included, so
    // this is where a deleted document used to come back to life.
    expect(
      rig.instance.store.search("numbat", 10).map((hit) => hit.uuid),
    ).toEqual([kept.uuid]);
    expect(
      (await rig.ok("search", { query: "numbat" })).hits.map(
        (hit: { uuid: string }) => hit.uuid,
      ),
    ).toEqual([kept.uuid]);
    expect(
      (await rig.ok("list_docs", {})).docs.map(
        (doc: { uuid: string }) => doc.uuid,
      ),
    ).toEqual([kept.uuid]);
  });
});

describe("identity at the boundary", () => {
  it("rejects a link that is not a UUID", async () => {
    const rig = await localRig();
    const doc = await rig.ok("create_doc", { title: "Bad links", description: "A test document." });

    // A path was already refused; an arbitrary string is the same violation,
    // and either one persists a target nothing can ever resolve.
    for (const link of ["docs/some-title", "abc", "Link Target"]) {
      const refused = await rig.call("set_links", {
        uuid: doc.uuid,
        links: [link],
      });
      expect(refused.isError).toBe(true);
    }

    const target = await rig.ok("create_doc", { title: "Real target", description: "A test document." });
    const accepted = await rig.ok("set_links", {
      uuid: doc.uuid,
      links: [target.uuid],
    });
    expect(accepted.applied).toBe(true);

    // The same rule on the way in: a document id that is not a UUID is not a
    // document id, on every tool that takes one.
    for (const tool of ["get_doc", "export_markdown", "backlinks"]) {
      const refused = await rig.call(tool, { uuid: "not-a-uuid" });
      expect(refused.isError).toBe(true);
    }
  });
});
