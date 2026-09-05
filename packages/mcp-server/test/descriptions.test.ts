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
import {
  addDecision,
  getDirectoryEntry,
  getMeta,
  getMetaMap,
  initDoc,
  upsertDirectoryEntry,
} from "@uberblick/schema";
import type { DirectoryEntry } from "@uberblick/schema";
import {
  removeTempDirs,
  startServer,
  testConfig,
  WORKSPACE,
} from "./helpers.js";
import type { Rig } from "./helpers.js";

const rigs: Rig[] = [];

async function localRig(): Promise<Rig> {
  const rig = await startServer(testConfig());
  rigs.push(rig);
  return rig;
}

async function lifecycleDoc(
  rig: Rig,
  title: string,
  lifecycle: Record<string, string> = {},
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

  it("refuses whitespace as a description, and trims the one it takes", async () => {
    const rig = await localRig();
    // Spaces are not a description. Accepting them would satisfy the
    // requirement on paper, store blanks in the document and the stub, and
    // silence the nudge that exists to get a real one written.
    const refused = await rig.call("create_doc", {
      title: "Undescribed",
      description: "   ",
    });
    expect(refused.isError).toBe(true);
    expect(refused.payload.message).toContain("whitespace");
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
      const refused = await rig.call("set_description", {
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

describe("lifecycle metadata reaches discovery", () => {
  it("creates a default status in one document update and omits an ordinary pair", async () => {
    const rig = await localRig();
    const created = await lifecycleDoc(rig, "Roadmap", {
      kind: "requirement",
    });

    expect(created).toMatchObject({ kind: "requirement", status: "draft" });
    expect(
      rig.instance.replicas.store.updateCount(
        `${WORKSPACE}/${created.uuid}`,
      ),
    ).toBe(1);
    expect(await rig.ok("get_doc", { uuid: created.uuid })).toMatchObject({
      kind: "requirement",
      status: "draft",
    });
    expect(stub(rig, created.uuid)).toMatchObject({
      kind: "requirement",
      status: "draft",
    });
    expect((await rig.ok("list_docs", { kind: "requirement" })).docs).toMatchObject([
      { uuid: created.uuid, kind: "requirement", status: "draft" },
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
    const planned = await rig.ok("create_doc", {
      title: "Planned",
      description: "A planned tagged requirement.",
      tags: ["shared"],
      kind: "requirement",
      status: "planned",
    });
    const draft = await lifecycleDoc(rig, "Draft", { kind: "requirement" });
    const decision = await rig.ok("create_doc", {
      title: "Decision",
      description: "An open tagged decision.",
      tags: ["shared"],
      kind: "decision",
    });
    const archivedDecision = await rig.ok("create_doc", {
      title: "Archived decision",
      description: "A decided record kept outside ordinary orientation.",
      tags: ["retired"],
      kind: "decision",
      status: "decided",
    });
    await rig.ok("archive_doc", { uuid: archivedDecision.uuid });

    const listedUuids = async (args: Record<string, unknown> = {}) =>
      (await rig.ok("list_docs", args)).docs
        .map((doc: any) => doc.uuid)
        .sort();

    expect(await listedUuids()).toEqual([planned.uuid, draft.uuid].sort());
    expect(await listedUuids({ include_deleted: true })).toEqual(
      [planned.uuid, draft.uuid].sort(),
    );
    expect(await listedUuids({ kind: "decision" })).toEqual([decision.uuid]);
    expect(await listedUuids({ kind: "decision", status: "open" })).toEqual([
      decision.uuid,
    ]);
    expect(await listedUuids({ status: "open" })).toEqual([decision.uuid]);
    expect(await listedUuids({ tag: "shared" })).toEqual(
      [planned.uuid, decision.uuid].sort(),
    );

    expect(
      await listedUuids({
        tag: "shared",
        kind: "requirement",
        status: "planned",
      }),
    ).toEqual([planned.uuid]);
    expect(
      await listedUuids({ include_deleted: true, kind: "decision" }),
    ).toEqual([archivedDecision.uuid, decision.uuid].sort());
  });

  it("repairs a stale lifecycle in either direction on the next document write", async () => {
    const rig = await localRig();
    const requirement = await lifecycleDoc(rig, "Authoritative", {
      kind: "requirement",
      status: "planned",
    });
    const ordinary = await lifecycleDoc(rig, "Ordinary");
    const directory = rig.instance.replicas.directory().doc;

    upsertDirectoryEntry(directory, {
      uuid: requirement.uuid,
      title: requirement.title,
      kind: "decision",
      status: "open",
    });
    upsertDirectoryEntry(directory, {
      uuid: ordinary.uuid,
      title: ordinary.title,
      kind: "requirement",
      status: "done",
    });

    await rig.ok("set_description", {
      uuid: requirement.uuid,
      description: "The document repairs its lifecycle cache.",
    });
    await rig.ok("set_description", {
      uuid: ordinary.uuid,
      description: "The document clears a lifecycle it does not carry.",
    });

    expect(stub(rig, requirement.uuid)).toMatchObject({
      kind: "requirement",
      status: "planned",
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
      meta.set("kind", "");
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

  it("moves within a kind and gives fixed-kind recovery for the other kind", async () => {
    const rig = await localRig();
    const requirement = await lifecycleDoc(rig, "Requirement", {
      kind: "requirement",
      status: "planned",
    });

    expect(
      await rig.ok("set_status", {
        uuid: requirement.uuid,
        status: "implementing",
      }),
    ).toMatchObject({ kind: "requirement", status: "implementing" });

    const refused = await rig.call("set_status", {
      uuid: requirement.uuid,
      status: "open",
    });
    expect(refused.payload).toMatchObject({
      error: "invalid_document_lifecycle",
      kind: "requirement",
      status: "open",
      applied: false,
      partial: false,
      recoveryClass: "manual",
    });
    expect(refused.payload.recovery).toContain("stored kind is fixed");
    expect(await rig.ok("get_doc", { uuid: requirement.uuid })).toMatchObject({
      kind: "requirement",
      status: "implementing",
    });
  });
});

describe("lifecycle tool text", () => {
  it("names the recorded fields and their authority boundary on every surface", async () => {
    const rig = await localRig();
    const { tools } = await rig.client.listTools();
    for (const name of ["create_doc", "get_doc", "list_docs", "set_status"]) {
      const description = tools.find((tool) => tool.name === name)?.description;
      expect(description, name).toContain("`kind`");
      expect(description, name).toContain("`status`");
      expect(description, name).toContain("do not authorize");
    }
    const exported = tools.find((tool) => tool.name === "export_markdown");
    if (exported === undefined) throw new Error("no tool export_markdown");
    const frontmatter = (exported.inputSchema as any).properties.frontmatter;
    expect(frontmatter.description).toContain("kind");
    expect(frontmatter.description).toContain("status");
    expect(frontmatter.description).toContain("do not authorize");
  });

  it("states the decision-listing default wherever archive discovery is described", async () => {
    const rig = await localRig();
    const { tools } = await rig.client.listTools();
    const description = (name: string) =>
      tools.find((tool) => tool.name === name)?.description ?? "";

    expect(description("list_docs")).toContain(
      'unfiltered orientation listing omits `kind: "decision"`',
    );
    expect(description("list_docs")).toContain(
      '`kind: "decision"` lists decision records',
    );
    expect(description("list_docs")).toContain(
      "`include_deleted` admits tombstones but is not a predicate",
    );
    expect(description("archive_doc")).toContain(
      "for a decision, add a matching `kind`, `status` or `tag` predicate",
    );
    expect(description("restore_doc")).toContain(
      "default list_docs listing unless it is a decision",
    );
    expect(description("create_doc")).toContain(
      "a decision needs a matching `kind`, `status` or `tag` predicate in list_docs",
    );
    expect(description("set_title")).toContain(
      "list_docs does too; for a decision, pass a matching `kind`",
    );
    for (const name of ["get_sidebar", "sidebar_group"]) {
      expect(description(name), name).toContain(
        "a decision needs a matching `kind`, `status` or `tag` predicate in list_docs",
      );
    }
  });
});

describe("decision log tools", () => {
  it("states that archive and restore never cascade through a decision log", async () => {
    const rig = await localRig();
    const { tools } = await rig.client.listTools();

    for (const name of ["archive_doc", "restore_doc"]) {
      const description = tools.find((tool) => tool.name === name)?.description;
      expect(description, name).toContain(
        "writes lifecycle state only for the uuid passed",
      );
      expect(description, name).toContain(
        "decision log can still report whether the target is available",
      );
      expect(description, name).toContain(
        "Call archive_doc or restore_doc separately for each related document",
      );
    }
  });

  it("raises a decision into its requirement and reads the ordered log", async () => {
    const rig = await localRig();
    const requirement = await lifecycleDoc(rig, "Requirement", {
      kind: "requirement",
      status: "planned",
    });

    const decision = await rig.ok("create_doc", {
      title: "Choose the durable path",
      description: "Records which path the requirement takes.",
      kind: "decision",
      governs: requirement.uuid,
    });

    expect(decision).toMatchObject({
      kind: "decision",
      status: "open",
      governs: requirement.uuid,
    });
    expect(decision.rooms.map((room: any) => room.purpose)).toEqual([
      "document",
      "directory",
      "requirement",
    ]);
    expect(decision.rooms.every((room: any) => room.applied)).toBe(true);
    expect(decision.rooms.every((room: any) => room.synced === false)).toBe(true);

    const governed = await rig.ok("get_doc", { uuid: requirement.uuid });
    expect(governed.decisions).toEqual([
      {
        uuid: decision.uuid,
        title: "Choose the durable path",
        status: "open",
        available: true,
      },
    ]);
    expect(governed.links).toEqual([decision.uuid]);
    expect((await rig.ok("get_doc", { uuid: decision.uuid })).decisions).toEqual(
      [],
    );

    // `links` is the effective graph edge list. Passing it back stores the
    // decision in the curated array as well, while the read stays deduplicated.
    await rig.ok("set_links", { uuid: requirement.uuid, links: governed.links });
    expect(
      getMetaMap(rig.instance.replicas.replica(requirement.uuid).doc).get(
        "links",
      ),
    ).toEqual([decision.uuid]);
    expect((await rig.ok("get_doc", { uuid: requirement.uuid })).links).toEqual([
      decision.uuid,
    ]);
  });

  it("keeps archived and missing decision references visible in stored order", async () => {
    const rig = await localRig();
    const requirement = await lifecycleDoc(rig, "Requirement", {
      kind: "requirement",
    });
    const decision = await rig.ok("create_doc", {
      title: "An archived decision",
      description: "Remains in the requirement's history.",
      kind: "decision",
      governs: requirement.uuid,
    });
    const missing = randomUUID();
    addDecision(
      rig.instance.replicas.replica(requirement.uuid).doc,
      missing,
    );
    await rig.ok("archive_doc", { uuid: decision.uuid });

    expect(
      (await rig.ok("get_doc", { uuid: requirement.uuid })).decisions,
    ).toEqual([
      {
        uuid: decision.uuid,
        title: "An archived decision",
        status: "open",
        available: false,
      },
      { uuid: missing, title: null, status: null, available: false },
    ]);
  });

  it("refuses every invalid governing target before creating a document", async () => {
    const rig = await localRig();
    const requirement = await lifecycleDoc(rig, "Requirement", {
      kind: "requirement",
    });

    const refuseWithoutCreation = async (
      args: Record<string, unknown>,
      code?: string,
    ): Promise<any> => {
      const before = (await rig.ok("list_docs")).docs.map(
        (doc: any) => doc.uuid,
      );
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
      return refused;
    };

    await refuseWithoutCreation({ governs: requirement.uuid });
    await refuseWithoutCreation({
      kind: "requirement",
      governs: requirement.uuid,
    });
    await refuseWithoutCreation(
      { kind: "decision", governs: randomUUID() },
      "doc_not_found",
    );

    const unhydrated = randomUUID();
    upsertDirectoryEntry(rig.instance.replicas.directory().doc, {
      uuid: unhydrated,
      title: "Known elsewhere",
      kind: "requirement",
      status: "planned",
    });
    await refuseWithoutCreation(
      { kind: "decision", governs: unhydrated },
      "doc_not_hydrated",
    );

    const archived = await lifecycleDoc(rig, "Archived requirement", {
      kind: "requirement",
    });
    await rig.ok("archive_doc", { uuid: archived.uuid });
    await refuseWithoutCreation(
      { kind: "decision", governs: archived.uuid },
      "doc_archived",
    );

    const ordinary = await lifecycleDoc(rig, "Ordinary target");
    const wrongKind = await refuseWithoutCreation(
      { kind: "decision", governs: ordinary.uuid },
      "governs_not_requirement",
    );
    expect(wrongKind.payload).toMatchObject({
      governs: ordinary.uuid,
      kind: null,
      applied: false,
      partial: false,
      synced: false,
    });
  });

  it("describes decision edges and the curated-link round trip", async () => {
    const rig = await localRig();
    const { tools } = await rig.client.listTools();
    const create = tools.find((tool) => tool.name === "create_doc");
    const get = tools.find((tool) => tool.name === "get_doc");
    const setLinks = tools.find((tool) => tool.name === "set_links");

    expect(create?.description).toContain("`governs`");
    expect(create?.description).toContain("governed requirement");
    expect(get?.description).toContain("ordered log");
    expect(get?.description).toContain("derived outbound edges");
    expect(setLinks?.description).toContain("curated link array");
    expect(setLinks?.description).toContain("passing get_doc's effective `links`");
  });
});
