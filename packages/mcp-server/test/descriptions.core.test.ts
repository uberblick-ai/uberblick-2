/**
 * Document discovery metadata: the fields that let an agent choose what to read.
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
import { getDirectoryEntry, getMeta, getMetaMap, initDoc, upsertDirectoryEntry } from "@uberblick/schema";
import type { DirectoryEntry } from "@uberblick/schema";
import { removeTempDirs, startServer, testConfig, WORKSPACE } from "./core-helpers.js";
import type { Rig } from "./core-helpers.js";

const rigs: Rig[] = [];
async function localRig(): Promise<Rig> {
  const rig = await startServer(testConfig());
  rigs.push(rig);
  return rig;
}

async function lifecycleDoc(
  rig: Rig,
  title: string,
  lifecycle: Record<string, unknown> = {},
): Promise<any> {
  return rig.ok("create_doc", {
    title,
    description: "A document used to exercise lifecycle behavior.",
    ...lifecycle,
  });
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
  it("refuses a missing, blank, whitespace or overlong one, and trims the one it takes", async () => {
    const rig = await localRig();
    const missing = await rig.call("create_doc", { title: "Undescribed" });
    expect(missing.isError).toBe(true);
    expect(missing.payload.message).toContain("A keyword list is fine.");
    // Spaces are not a description. Accepting them would satisfy the
    // requirement on paper, store blanks in the document and the stub, and
    // silence the nudge that exists to get a real one written.
    for (const description of ["", "   ", "x".repeat(301)]) {
      const refused = await rig.call("create_doc", { title: "Undescribed", description });
      expect(refused.isError).toBe(true);
    }
    // Nothing was published for a call that failed at the boundary.
    expect((await rig.ok("list_docs")).docs).toEqual([]);

    // And what is stored is what was checked: the trimmed value, not the
    // padding it arrived in.
    const doc = await rig.ok("create_doc", {
      title: "Padded",
      description: "  What this is for.  ",
    });
    expect(doc.description).toBe("What this is for.");
    expect(stub(rig, doc.uuid).description).toBe("What this is for.");
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
    await rig.ok("set_metadata", { uuid: source.uuid, links: [doc.uuid] });
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

describe("set_metadata", () => {
  it("replaces wholesale, reports durability, and updates the stub at once", async () => {
    const rig = await localRig();
    const doc = await rig.ok("create_doc", {
      title: "Rewritten",
      description: "A first attempt.",
    });

    const set = await rig.ok("set_metadata", {
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

  it("refuses whitespace and the empty string — there is no clear path", async () => {
    const rig = await localRig();
    const doc = await rig.ok("create_doc", {
      title: "Described",
      description: "Something worth keeping.",
    });

    // Clearing a description is deliberately not reachable from MCP: the
    // schema can do it, the tool will not. A document that advertises nothing
    // is a gap to fill, not a state to ask for.
    for (const description of ["", "   ", "\n\t "]) {
      const refused = await rig.call("set_metadata", {
        uuid: doc.uuid,
        description,
      });
      expect(refused.isError).toBe(true);
    }

    // The description it already had is untouched by any of that.
    expect(stub(rig, doc.uuid).description).toBe("Something worth keeping.");
    expect(
      getMeta(rig.instance.replicas.replica(doc.uuid).doc).description,
    ).toBe("Something worth keeping.");
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
      blocks: [{ type: "paragraph", text: "written by an agent" }],
    });
    expect(inserted.applied).toBe(true);
    expect(inserted.description).toBeNull();
    expect(inserted.descriptionHint).toContain("set_metadata");
    expect(inserted.tagHint).toBe("This document has no tags: to add some, call list_tags for the workspace vocabulary, " +
      "then set_metadata with `tags`; leave it untagged if no tag fits.");

    // Every mutator, not one — the nudge lives where durability is reported.
    const tagged = await rig.ok("set_metadata", { uuid, tags: ["auth"] });
    expect(tagged.descriptionHint).toContain("set_metadata");
    expect(tagged).not.toHaveProperty("tagHint");

    // And it stops the moment the gap is closed.
    const described = await rig.ok("set_metadata", {
      uuid,
      description: "What the browser made, now that somebody said so.",
    });
    expect(described.descriptionHint).toBeUndefined();
    const after = await rig.ok("set_metadata", { uuid, tags: ["mcp"] });
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
    await rig.ok("set_metadata", {
      uuid: doc.uuid,
      description: "A second description.",
    });
    expect(directoryUpdates()).toBe(1);

    // Rewriting it with the same text changes nothing the stub caches, so the
    // stub repair writes nothing at all.
    await rig.ok("set_metadata", {
      uuid: doc.uuid,
      description: "A second description.",
    });
    expect(directoryUpdates()).toBe(1);

    // And ordinary editing still costs the directory nothing inside the
    // freshness window — see timestamps.test.ts for that contract.
    for (let index = 0; index < 10; index += 1) {
      await rig.ok("insert_block", {
        uuid: doc.uuid,
        blocks: [{ type: "paragraph", text: `line ${index}` }],
      });
    }
    expect(directoryUpdates()).toBe(1);
  });
});

describe("lifecycle metadata reaches discovery", () => {
  it("creates a default status in one document update and omits an ordinary pair", async () => {
    const rig = await localRig();
    const created = await lifecycleDoc(rig, "Roadmap", {
      kind: "decision",
    });

    expect(created).toMatchObject({ kind: "decision", status: "open" });
    expect(
      rig.instance.replicas.store.updateCount(
        `${WORKSPACE}/${created.uuid}`,
      ),
    ).toBe(1);
    expect(await rig.ok("get_doc", { uuid: created.uuid })).toMatchObject({
      kind: "decision",
      status: "open",
    });
    expect(stub(rig, created.uuid)).toMatchObject({
      kind: "decision",
      status: "open",
    });
    expect((await rig.ok("list_docs", { kind: "decision" })).docs).toMatchObject([
      { uuid: created.uuid, kind: "decision", status: "open" },
    ]);

    const ordinary = await lifecycleDoc(rig, "Working notes");
    expect(ordinary).not.toHaveProperty("kind");
    expect(ordinary).not.toHaveProperty("status");
    expect(await rig.ok("get_doc", { uuid: ordinary.uuid })).not.toHaveProperty(
      "kind",
    );
    expect(stub(rig, ordinary.uuid)).not.toHaveProperty("kind");
  });

  it("omits decisions by default and includes them under exact predicates", async () => {
    const rig = await localRig();
    const tagged = await rig.ok("create_doc", {
      title: "Tagged page",
      description: "A tagged regular page.",
      tags: ["sync"],
    });
    const notes = await lifecycleDoc(rig, "Notes");
    const decision = await rig.ok("create_doc", {
      title: "Decision",
      description: "An open tagged decision.",
      tags: ["sync"],
      kind: "decision",
    });
    const archivedDecision = await rig.ok("create_doc", {
      title: "Archived decision",
      description: "A decided record kept outside ordinary orientation.",
      tags: ["billing"],
      kind: "decision",
      status: "decided",
      blocks: [
        { type: "paragraph", text: "Revisit when billing changes." },
      ],
    });
    await rig.ok("archive_doc", { uuid: archivedDecision.uuid });

    const listedUuids = async (args: Record<string, unknown> = {}) =>
      (await rig.ok("list_docs", args)).docs
        .map((doc: any) => doc.uuid)
        .sort();

    expect(await listedUuids()).toEqual([tagged.uuid, notes.uuid].sort());
    expect(await listedUuids({ include_deleted: true })).toEqual(
      [tagged.uuid, notes.uuid].sort(),
    );
    expect(await listedUuids({ kind: "decision" })).toEqual([decision.uuid]);
    expect(await listedUuids({ kind: "decision", status: "open" })).toEqual([
      decision.uuid,
    ]);
    expect(await listedUuids({ status: "open" })).toEqual([decision.uuid]);
    expect(await listedUuids({ tag: "sync" })).toEqual(
      [tagged.uuid, decision.uuid].sort(),
    );

    expect(
      await listedUuids({
        tag: "sync",
        kind: "decision",
        status: "open",
      }),
    ).toEqual([decision.uuid]);
    expect(
      await listedUuids({ include_deleted: true, kind: "decision" }),
    ).toEqual([archivedDecision.uuid, decision.uuid].sort());
  });

  it("repairs a stale lifecycle in either direction on the next document write", async () => {
    const rig = await localRig();
    const record = await lifecycleDoc(rig, "Authoritative", {
      kind: "decision",
      status: "open",
    });
    const ordinary = await lifecycleDoc(rig, "Ordinary");
    const directory = rig.instance.replicas.directory().doc;

    upsertDirectoryEntry(directory, {
      uuid: record.uuid,
      title: record.title,
      kind: "",
      status: "",
    });
    upsertDirectoryEntry(directory, {
      uuid: ordinary.uuid,
      title: ordinary.title,
      kind: "decision",
      status: "open",
    });

    await rig.ok("set_metadata", {
      uuid: record.uuid,
      description: "The document repairs its lifecycle cache.",
    });
    await rig.ok("set_metadata", {
      uuid: ordinary.uuid,
      description: "The document clears a lifecycle it does not carry.",
    });

    expect(stub(rig, record.uuid)).toMatchObject({
      kind: "decision",
      status: "open",
    });
    expect(stub(rig, ordinary.uuid)).not.toHaveProperty("kind");
    expect(stub(rig, ordinary.uuid)).not.toHaveProperty("status");
  });
});

describe("set_status", () => {
  it("adopts an ordinary document atomically, including over a hidden raw pair", async () => {
    const rig = await localRig();
    const ordinary = await lifecycleDoc(rig, "Adopt me");
    const replica = rig.instance.replicas.replica(ordinary.uuid);
    const meta = getMetaMap(replica.doc);

    // Reachable after sanctioned concurrent writes: the tolerant reader sees
    // no lifecycle, while a raw status incompatible with the future kind
    // remains. Adoption replaces both in one update, with no durable prefix.
    replica.doc.transact(() => {
      meta.set("kind", "requirement");
      meta.set("status", "done");
    });
    expect(getMeta(replica.doc)).not.toHaveProperty("kind");
    const before = rig.instance.replicas.store.updateCount(replica.room);

    const adopted = await rig.ok("set_status", {
      uuid: ordinary.uuid,
      status: "open",
    });
    expect(adopted).toMatchObject({ kind: "decision", status: "open" });
    expect(rig.instance.replicas.store.updateCount(replica.room)).toBe(
      before + 1,
    );
    expect(getMeta(replica.doc)).toMatchObject({
      kind: "decision",
      status: "open",
    });
    expect(stub(rig, ordinary.uuid)).toMatchObject({
      kind: "decision",
      status: "open",
    });
  });

  it("decides an initial stance with ordinary answer blocks", async () => {
    const rig = await localRig();
    const proposal = await lifecycleDoc(rig, "Topic and stance", {
      kind: "decision",
      blocks: [{ type: "paragraph", text: "Use the smallest useful mechanism." }],
    });
    expect(await rig.ok("set_status", { uuid: proposal.uuid, status: "decided" }))
      .toMatchObject({ kind: "decision", status: "decided", agentStance: true });
    expect(await rig.ok("create_doc", {
      title: "First stance at creation",
      description: "A topic with its first recorded stance.",
      kind: "decision", status: "decided",
      blocks: [{ type: "paragraph", text: "Use the smallest useful mechanism." }],
    })).toMatchObject({ status: "decided", agentStance: true });
  });
});

describe("decision log tools", () => {
  it("relates a decision to a regular page and reads its ordered log", async () => {
    const rig = await localRig();
    const page = await lifecycleDoc(rig, "Related page");

    const decision = await rig.ok("create_doc", {
      title: "Choose the durable path",
      description: "Records which path the page takes.",
      kind: "decision",
      related: page.uuid,
    });

    expect(decision).toMatchObject({
      kind: "decision",
      status: "open",
      related: [page.uuid],
    });
    expect(decision.rooms.map((room: any) => room.purpose)).toEqual([
      "document",
      "directory",
    ]);
    expect(decision.rooms.every((room: any) => room.applied)).toBe(true);
    expect(decision.rooms.every((room: any) => room.synced === false)).toBe(true);

    const governed = await rig.ok("get_doc", { uuid: page.uuid });
    expect(governed.decisions).toMatchObject([
      { uuid: decision.uuid, topic: decision.uuid, relation: "related", inForce: null, pending: [decision.uuid] },
    ]);
    expect(governed.links).toEqual([]);
    expect((await rig.ok("get_doc", { uuid: decision.uuid })).links).toEqual([page.uuid]);
    expect((await rig.ok("backlinks", { uuid: page.uuid })).backlinks).toMatchObject([{ uuid: decision.uuid }]);
    expect((await rig.ok("get_doc", { uuid: decision.uuid })).decisions).toEqual([]);
  });

  it("records supersession on the new decision and exposes it as a backlink", async () => {
    const rig = await localRig();
    const earlier = await lifecycleDoc(rig, "Earlier decision", {
      kind: "decision",
      status: "decided",
      blocks: [
        { type: "paragraph", text: "Revisit if the constraint changes." },
      ],
    });
    const before = await rig.ok("get_doc", { uuid: earlier.uuid });

    const successor = await rig.ok("create_doc", {
      description: "Records the choice that replaces an earlier decision.",
      kind: "decision",
      supersedes: earlier.uuid,
    });

    expect(successor).toMatchObject({
      kind: "decision",
      status: "open",
      supersedes: earlier.uuid,
    });
    expect(await rig.ok("get_doc", { uuid: successor.uuid })).toMatchObject({
      supersedes: earlier.uuid,
      links: [earlier.uuid],
    });
    const earlierRead = await rig.ok("get_doc", { uuid: earlier.uuid });
    expect(earlierRead.blocks).toEqual(before.blocks);
    expect(earlierRead.successors).toMatchObject([{ uuid: successor.uuid, status: "open" }]);
    expect(earlierRead.resolution).toMatchObject({ inForce: earlier.uuid, pending: [successor.uuid] });
    expect(
      (await rig.ok("backlinks", { uuid: earlier.uuid })).backlinks,
    ).toEqual([
      {
        uuid: successor.uuid,
        title: "Earlier decision",
        description: "Records the choice that replaces an earlier decision.",
      },
    ]);
    expect(
      getMetaMap(rig.instance.replicas.replica(successor.uuid).doc).get(
        "links",
      ),
    ).toEqual([]);
  });

  it("refuses a non-decision supersession target without writing", async () => {
    const rig = await localRig();
    const ordinary = await lifecycleDoc(rig, "Ordinary target");
    const beforeLog = rig.instance.replicas.store.logSize();
    const before = await rig.ok("get_doc", { uuid: ordinary.uuid });

    const refused = await rig.call("create_doc", {
      title: "Refused replacement",
      description: "Must not replace an ordinary document.",
      kind: "decision",
      supersedes: ordinary.uuid,
    });

    expect(refused.payload).toMatchObject({
      error: "supersedes_not_decision",
      supersedes: ordinary.uuid,
      kind: null,
      applied: false,
      partial: false,
      synced: false,
    });
    expect(rig.instance.replicas.store.logSize()).toBe(beforeLog);
    expect(await rig.ok("get_doc", { uuid: ordinary.uuid })).toEqual(before);
  });

  it("omits archived topics from the derived page log", async () => {
    const rig = await localRig();
    const page = await lifecycleDoc(rig, "Page");
    const decision = await rig.ok("create_doc", {
      title: "Archived topic", description: "Archive is the topic's visibility switch.",
      kind: "decision", related: page.uuid,
    });
    await rig.ok("archive_doc", { uuid: decision.uuid });
    expect((await rig.ok("get_doc", { uuid: page.uuid })).decisions).toEqual([]);
  });

  it("refuses every invalid related page before creating a document", async () => {
    const rig = await localRig();
    const page = await lifecycleDoc(rig, "Related page");

    const refuseWithoutCreation = async (
      args: Record<string, unknown>,
      code?: string,
    ): Promise<any> => {
      const before = (await rig.ok("list_docs")).docs.map(
        (doc: any) => doc.uuid,
      );
      const beforeLog = rig.instance.store.logSize();
      const refused = await rig.call("create_doc", {
        title: "Refused decision",
        description: "Must never reach a room.",
        ...args,
      });
      expect(refused.isError).toBe(true);
      if (code !== undefined) expect(refused.payload.error).toBe(code);
      expect((await rig.ok("list_docs")).docs.map((doc: any) => doc.uuid)).toEqual(
        before,
      );
      expect(rig.instance.store.logSize()).toBe(beforeLog);
      return refused;
    };

    await refuseWithoutCreation({ related: page.uuid });
    await refuseWithoutCreation({
      kind: "requirement",
      related: page.uuid,
    });
    await refuseWithoutCreation(
      { kind: "decision", related: randomUUID() },
      "doc_not_found",
    );

    const unhydrated = randomUUID();
    upsertDirectoryEntry(rig.instance.replicas.directory().doc, {
      uuid: unhydrated,
      title: "Known elsewhere",
    });
    await refuseWithoutCreation(
      { kind: "decision", related: unhydrated },
      "doc_not_hydrated",
    );

    const archived = await lifecycleDoc(rig, "Archived page");
    await rig.ok("archive_doc", { uuid: archived.uuid });
    await refuseWithoutCreation(
      { kind: "decision", related: archived.uuid },
      "doc_archived",
    );

    const decision = await lifecycleDoc(rig, "Decision target", { kind: "decision" });
    const wrongKind = await refuseWithoutCreation(
      { kind: "decision", related: decision.uuid },
      "related_not_regular_document",
    );
    expect(wrongKind.payload).toMatchObject({
      related: decision.uuid,
      kind: "decision",
      applied: false,
      partial: false,
      synced: false,
    });
  });
});
