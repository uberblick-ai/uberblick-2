/**
 * Document descriptions: the field that lets an agent choose what to read.
 *
 * The bargain this suite defends is asymmetric on purpose. `create_doc` refuses
 * without a description, because an agent writing a document can say what it is
 * for. The web UI creates documents that have none, so every other write
 * succeeds and merely says what is missing — a nudge, never a failure, aimed at
 * the one party able to fix it.
 *
 * The rest is the cache contract the title already has: the document owns the
 * description, the directory stub mirrors it, and every discovery surface
 * answers from the stub or the index rather than by opening a room.
 */

import { randomUUID } from "node:crypto";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
  getDirectoryEntry,
  getMeta,
  initDoc,
  upsertDirectoryEntry,
} from "@uberblick/schema";
import type { DirectoryEntry } from "@uberblick/schema";
import { removeTempDirs, startServer, testConfig } from "./helpers.js";
import type { Rig } from "./helpers.js";

const rigs: Rig[] = [];

async function localRig(): Promise<Rig> {
  const rig = await startServer(testConfig());
  rigs.push(rig);
  return rig;
}

function stub(rig: Rig, uuid: string): DirectoryEntry {
  const entry = getDirectoryEntry(rig.instance.replicas.directory().doc, uuid);
  if (entry === null) {
    throw new Error(`no directory entry for ${uuid}`);
  }
  return entry;
}

/** Count updates published by the directory room from now on. */
function countDirectoryUpdates(rig: Rig): () => number {
  let updates = 0;
  rig.instance.replicas.directory().doc.on("update", () => {
    updates += 1;
  });
  return () => updates;
}

/**
 * A document made the way the web UI makes one: the room, `initDoc` with no
 * description, and a stub published because the client said so. This is the
 * shape every nudge in here exists for.
 */
function webDoc(rig: Rig, title: string): string {
  const uuid = randomUUID();
  const replica = rig.instance.replicas.replica(uuid);
  initDoc(replica.doc, { uuid, title });
  upsertDirectoryEntry(rig.instance.replicas.directory().doc, { uuid, title });
  return uuid;
}

afterEach(async () => {
  for (const rig of rigs.splice(0)) {
    await rig.close();
  }
});

afterAll(() => {
  removeTempDirs();
});

describe("create_doc requires a description", () => {
  it("refuses without one, and says what is wanted", async () => {
    const rig = await localRig();
    const refused = await rig.call("create_doc", { title: "Undescribed" });

    expect(refused.isError).toBe(true);
    expect(refused.payload.message).toContain("description");
    expect(refused.payload.message).toContain("one or two sentences");
    // Nothing was published for a call that failed at the boundary.
    expect((await rig.ok("list_docs")).docs).toEqual([]);
  });

  it("refuses a blank one and one past the length ceiling", async () => {
    const rig = await localRig();
    for (const description of ["", "x".repeat(301)]) {
      const refused = await rig.call("create_doc", {
        title: "Undescribed",
        description,
      });
      expect(refused.isError).toBe(true);
    }
    expect((await rig.ok("list_docs")).docs).toEqual([]);
  });
});

describe("a description reaches every discovery surface", () => {
  it("is mirrored into the stub and answered without opening the document", async () => {
    const rig = await localRig();
    const doc = await rig.ok("create_doc", {
      title: "Sync",
      description: "How replicas reconcile, and what convergence costs.",
      blocks: [{ type: "paragraph", text: "hub acknowledgement" }],
    });
    expect(doc.description).toBe(
      "How replicas reconcile, and what convergence costs.",
    );

    // list_docs reads the directory document and nothing else, so a description
    // it can answer with is one that cost no room to read.
    expect(stub(rig, doc.uuid).description).toBe(
      "How replicas reconcile, and what convergence costs.",
    );
    const listed = await rig.ok("list_docs");
    expect(listed.docs[0].description).toBe(
      "How replicas reconcile, and what convergence costs.",
    );

    // Search and backlinks answer from the derived index, also without a room.
    const source = await rig.ok("create_doc", {
      title: "Citing",
      description: "Points at Sync.",
    });
    await rig.ok("set_links", { uuid: source.uuid, links: [doc.uuid] });
    expect(await rig.ok("backlinks", { uuid: doc.uuid })).toMatchObject({
      backlinks: [
        { uuid: source.uuid, title: "Citing", description: "Points at Sync." },
      ],
    });

    const hits = await rig.ok("search", { query: "acknowledgement" });
    expect(hits.hits[0].description).toBe(
      "How replicas reconcile, and what convergence costs.",
    );

    // get_doc carries it too, so an agent that did open the room sees the same
    // field rather than having to remember the listing.
    expect((await rig.ok("get_doc", { uuid: doc.uuid })).description).toBe(
      "How replicas reconcile, and what convergence costs.",
    );
  });

  it("is matched by search, so a word only in the description finds the doc", async () => {
    const rig = await localRig();
    const doc = await rig.ok("create_doc", {
      title: "Opaque",
      description: "The quokka protocol, end to end.",
      blocks: [{ type: "paragraph", text: "nothing here says what it is" }],
    });

    const hits = await rig.ok("search", { query: "quokka" });
    expect(hits.hits.map((hit: { uuid: string }) => hit.uuid)).toEqual([
      doc.uuid,
    ]);
  });
});

describe("set_description", () => {
  it("replaces wholesale, reports durability, and updates the stub at once", async () => {
    const rig = await localRig();
    const doc = await rig.ok("create_doc", {
      title: "Rewritten",
      description: "A first attempt.",
    });

    const set = await rig.ok("set_description", {
      uuid: doc.uuid,
      description: "What it actually turned out to be about.",
    });
    expect(set).toMatchObject({
      uuid: doc.uuid,
      description: "What it actually turned out to be about.",
      applied: true,
      // Local-only rig: applied is the durable half, synced is honest about the
      // hub it never reached.
      synced: false,
    });

    // The document owns it; the stub is the cache that follows immediately, the
    // way it does for a rename.
    expect(getMeta(rig.instance.replicas.replica(doc.uuid).doc).description).toBe(
      "What it actually turned out to be about.",
    );
    expect(stub(rig, doc.uuid).description).toBe(
      "What it actually turned out to be about.",
    );
    expect((await rig.ok("list_docs")).docs[0].description).toBe(
      "What it actually turned out to be about.",
    );

    // And the old text is gone from search: this is a replace, not an append.
    expect((await rig.ok("search", { query: "attempt" })).hits).toEqual([]);
  });

  it("refuses an archived document, like every other mutator", async () => {
    const rig = await localRig();
    const doc = await rig.ok("create_doc", {
      title: "Archived",
      description: "Withdrawn from the corpus.",
    });
    await rig.ok("archive_doc", { uuid: doc.uuid });

    const refused = await rig.call("set_description", {
      uuid: doc.uuid,
      description: "Should not land.",
    });
    expect(refused.payload).toMatchObject({
      error: "doc_archived",
      applied: false,
    });
  });
});

describe("a document nobody described", () => {
  it("lists as null and nudges every write, without ever failing one", async () => {
    const rig = await localRig();
    const uuid = webDoc(rig, "Made in the browser");

    const listed = await rig.ok("list_docs");
    const entry = listed.docs.find((row: { uuid: string }) => row.uuid === uuid);
    // Present and null, not missing: one shape to read.
    expect(entry).toMatchObject({ description: null });
    expect((await rig.ok("get_doc", { uuid })).description).toBeNull();

    // A write succeeds, and carries the nudge rather than a refusal.
    const inserted = await rig.ok("insert_block", {
      uuid,
      type: "paragraph",
      text: "written by an agent",
    });
    expect(inserted.applied).toBe(true);
    expect(inserted.description).toBeNull();
    expect(inserted.descriptionHint).toContain("set_description");

    // Every mutator, not one — the nudge lives where durability is reported.
    const tagged = await rig.ok("set_tags", { uuid, tags: ["draft"] });
    expect(tagged.descriptionHint).toContain("set_description");

    // And it stops the moment the gap is closed.
    const described = await rig.ok("set_description", {
      uuid,
      description: "What the browser made, now that somebody said so.",
    });
    expect(described.descriptionHint).toBeUndefined();
    const after = await rig.ok("set_tags", { uuid, tags: ["reference"] });
    expect(after.descriptionHint).toBeUndefined();
  });

  it("does not nudge on writes that are not about a document", async () => {
    const rig = await localRig();
    const uuid = webDoc(rig, "Made in the browser");

    // pin_doc writes the sidebar and archive_doc writes the directory. Neither
    // room is a document, and neither answer should carry a document's nudge.
    const pinned = await rig.ok("pin_doc", { uuid, group: "Reference" });
    expect(pinned.descriptionHint).toBeUndefined();
    const archived = await rig.ok("archive_doc", { uuid });
    expect(archived.descriptionHint).toBeUndefined();
  });
});

describe("directory churn", () => {
  it("costs one directory update per description, and none per edit", async () => {
    const rig = await localRig();
    const doc = await rig.ok("create_doc", {
      title: "Churn",
      description: "The first description.",
    });
    const directoryUpdates = countDirectoryUpdates(rig);

    // A description is written wholesale by one tool. There is no per-keystroke
    // path into it, so the cost the workspace pays is a rename's.
    await rig.ok("set_description", {
      uuid: doc.uuid,
      description: "A second description.",
    });
    expect(directoryUpdates()).toBe(1);

    // Rewriting it with the same text changes nothing the stub caches, so the
    // stub repair writes nothing at all.
    await rig.ok("set_description", {
      uuid: doc.uuid,
      description: "A second description.",
    });
    expect(directoryUpdates()).toBe(1);

    // And ordinary editing still costs the directory nothing inside the
    // freshness window — see timestamps.test.ts for that contract.
    for (let index = 0; index < 10; index += 1) {
      await rig.ok("insert_block", {
        uuid: doc.uuid,
        type: "paragraph",
        text: `line ${index}`,
      });
    }
    expect(directoryUpdates()).toBe(1);
  });
});
