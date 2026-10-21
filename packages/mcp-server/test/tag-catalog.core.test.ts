/** The MCP server's read-only, catalog-aware tag boundary. */
import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";

import { EXAMPLE_TAGS, createTagCatalogEntry, getDirectoryEntry, retireTagCatalogEntry, setTags, settingsRoom } from "@uberblick/schema";
import { cleanupTestResources, startServer, testConfig, WORKSPACE } from "./core-helpers.js";
import type { Rig } from "./core-helpers.js";

const rigs: Rig[] = [];

const AUTH = {
  id: EXAMPLE_TAGS[0].id,
  name: EXAMPLE_TAGS[0].name,
  state: "active",
} as const;
const MCP = {
  id: EXAMPLE_TAGS[2].id,
  name: EXAMPLE_TAGS[2].name,
  state: "active",
} as const;
/** A catalog identity no replica in these tests has an entry for. */
const OFF_CATALOG = "3f5c0b1e-6f6a-4a2b-9c1d-0e7a5b3c9d21";

async function local(databasePath = ":memory:"): Promise<Rig> {
  const rig = await startServer(testConfig({ databasePath }));
  rigs.push(rig);
  return rig;
}

afterEach(async () => {
  await cleanupTestResources({
    clients: rigs.splice(0).map((client) => () => client.close()),
  });
});

describe("the workspace tag catalog", () => {
  it("nudges successful writes to untagged documents when the local catalog has active choices", async () => {
    const rig = await local();
    const created = await rig.ok("create_doc", {
      title: "Needs classification",
      description: "A document created before anyone chose its domain tags.",
    });

    expect(created).toMatchObject({
      applied: true,
      synced: expect.any(Boolean),
      hub: { status: "disabled" },
    });
    expect(created.tagHint).toContain("list_tags");
    expect(created.tagHint).toContain("set_metadata");

    const inserted = await rig.ok("insert_block", {
      uuid: created.uuid,
      blocks: [{ type: "paragraph", text: "The write still lands while the hint points out the next step." }],
    });
    expect(inserted).toMatchObject({
      applied: true,
      synced: expect.any(Boolean),
      hub: { status: "disabled" },
    });
    expect(inserted.tagHint).toContain("list_tags");
    expect(inserted.tagHint).toContain("set_metadata");
    expect(
      (await rig.ok("get_doc", { uuid: created.uuid })).blocks,
    ).toContainEqual(
      expect.objectContaining({
        text: "The write still lands while the hint points out the next step.",
      }),
    );

    const pinned = await rig.ok("pin_doc", {
      uuid: created.uuid,
      group: "Reference",
    });
    expect(pinned.tagHint).toBeUndefined();
    const archived = await rig.ok("archive_doc", { uuid: created.uuid });
    expect(archived.tagHint).toBeUndefined();
  });

  it("does not nudge an assigned document or one with no active local choices", async () => {
    const rig = await local();
    const assigned = await rig.ok("create_doc", {
      title: "Classified before retirement",
      description: "A retired assignment still records that classification happened.",
      tags: [AUTH.id],
    });
    expect(assigned.tagHint).toBeUndefined();

    retireTagCatalogEntry(rig.instance.replicas.settings().doc, AUTH.id);
    const retained = await rig.ok("insert_block", {
      uuid: assigned.uuid,
      blocks: [{ type: "paragraph", text: "The only assignment is retired, but it remains an assignment." }],
    });
    expect(retained.tagHint).toBeUndefined();

    for (const tag of EXAMPLE_TAGS.filter(({ id }) => id !== AUTH.id)) {
      retireTagCatalogEntry(rig.instance.replicas.settings().doc, tag.id);
    }
    const noChoices = await rig.ok("create_doc", {
      title: "No local vocabulary",
      description: "An untagged document when the local catalog has no active entry.",
    });
    expect(noChoices.tagHint).toBeUndefined();
  });

  it("keeps a filtered search hit when a second identity for one name converges", async () => {
    const rig = await local();
    // Sorted: the peer's identity is the one the merged entry canonicalises on,
    // so the document's stored id is an alias and its derived index rows have
    // to be re-derived against the arriving catalog.
    const mine = "ffffffff-0000-4000-8000-000000000001";
    const theirs = "11111111-0000-4000-8000-000000000001";
    createTagCatalogEntry(rig.instance.replicas.settings().doc, "collision", mine);
    const created = await rig.ok("create_doc", {
      title: "Converging identities",
      description: "A document tagged before the same name arrived from a peer.",
      tags: [mine],
      blocks: [{ type: "paragraph", text: "collision aardvark" }],
    });

    const peer = new Y.Doc();
    createTagCatalogEntry(peer, "collision", theirs);
    rig.instance.store.appendUpdate(
      settingsRoom(WORKSPACE),
      Y.encodeStateAsUpdate(peer),
      "remote",
    );
    await peer.destroy();

    expect((await rig.ok("list_tags")).tags).toContainEqual({
      id: theirs,
      name: "collision",
    });
    for (const tag of ["collision", mine, theirs]) {
      const hits = await rig.ok("search", { query: "aardvark", tag });
      expect(hits.hits.map((hit: { uuid: string }) => hit.uuid)).toEqual([
        created.uuid,
      ]);
    }
  });

  it("resolves ids and names through every structured read, filter and export", async () => {
    const rig = await local();
    const created = await rig.ok("create_doc", {
      title: "Catalog contract",
      description: "A searchable document with catalog-owned assignments.",
      tags: ["mcp", AUTH.id, "auth"],
      blocks: [{ type: "paragraph", text: "catalog capybara" }],
    });

    expect(created.tags).toEqual([AUTH, MCP]);
    expect((await rig.ok("get_doc", { uuid: created.uuid })).tags).toEqual([
      AUTH,
      MCP,
    ]);

    for (const tag of ["auth", AUTH.id]) {
      const listed = await rig.ok("list_docs", { tag });
      expect(listed.docs).toHaveLength(1);
      expect(listed.docs[0]).toMatchObject({ uuid: created.uuid });
      expect(listed.docs[0].tags).toEqual([AUTH, MCP]);
    }

    for (const tag of ["mcp", MCP.id]) {
      const searched = await rig.ok("search", {
        query: "capybara",
        tag,
      });
      expect(searched.hits).toHaveLength(1);
      expect(searched.hits[0]).toMatchObject({ uuid: created.uuid });
      expect(searched.hits[0].tags).toEqual([AUTH, MCP]);
    }

    // A selector the catalog does not have is refused, not answered with an
    // empty result a caller cannot tell from "nothing carries this tag".
    for (const call of [
      rig.call("list_docs", { tag: "mpc" }),
      rig.call("search", { query: "capybara", tag: "mpc" }),
    ]) {
      const refused = await call;
      expect(refused.payload).toMatchObject({
        error: "invalid_tag_assignment",
        unknown: ["mpc"],
        retired: [],
        recoveryClass: "manual",
      });
    }

    const exported = await rig.ok("export_markdown", { uuid: created.uuid });
    expect(exported.markdown).toContain("tags: [auth, mcp]");
    expect(exported.markdown).not.toContain(AUTH.id);
    expect(exported.markdown).not.toContain(MCP.id);
  });

  it("ignores tag name case across writes and filters without trimming selectors", async () => {
    const rig = await local();
    const target = await rig.ok("create_doc", {
      title: "Mobile catalog",
      description: "A document for case-insensitive catalog selectors.",
      blocks: [{ type: "paragraph", text: "mobile iguana" }],
    });

    for (const [name, args] of [
      ["create_doc", { title: "Unknown mobile", description: "Must not be created.", tags: ["iOS"] }],
      ["set_metadata", { uuid: target.uuid, tags: ["iOS"] }],
      ["search", { query: "iguana", tag: "iOS" }],
      ["list_docs", { tag: "iOS" }],
    ] as const) {
      expect((await rig.call(name, args)).payload).toMatchObject({
        error: "invalid_tag_assignment", unknown: ["iOS"], retired: [],
      });
    }

    const ios = createTagCatalogEntry(rig.instance.replicas.settings().doc, "ios");
    const assigned = { ...ios };
    const created = await rig.ok("create_doc", {
      title: "Tagged mobile",
      description: "Names in different cases select one catalog identity.",
      tags: ["iOS", "IOS", ios.id],
    });
    expect(created.tags).toEqual([assigned]);
    expect((await rig.ok("set_metadata", {
      uuid: target.uuid, tags: ["iOS", "ios"],
    })).tags).toEqual([assigned]);

    for (const tag of ["iOS", "IOS", ios.id]) {
      expect((await rig.ok("search", { query: "iguana", tag })).hits)
        .toEqual([expect.objectContaining({ uuid: target.uuid, tags: [assigned] })]);
      expect((await rig.ok("list_docs", { tag })).docs.map((doc: { uuid: string }) => doc.uuid).sort())
        .toEqual([target.uuid, created.uuid].sort());
    }

    for (const [name, args] of [
      ["create_doc", { title: "Untrimmed mobile", description: "Must not be created.", tags: [" iOS "] }],
      ["set_metadata", { uuid: target.uuid, tags: [" iOS "] }],
      ["search", { query: "iguana", tag: " iOS " }],
      ["list_docs", { tag: " iOS " }],
    ] as const) {
      expect((await rig.call(name, args)).payload).toMatchObject({
        error: "invalid_tag_assignment", unknown: [" iOS "], retired: [],
      });
    }

    retireTagCatalogEntry(rig.instance.replicas.settings().doc, ios.id);
    for (const [name, args] of [
      ["create_doc", { title: "Retired mobile", description: "Must not be created.", tags: ["iOS"] }],
      ["set_metadata", { uuid: target.uuid, tags: ["iOS"] }],
    ] as const) {
      expect((await rig.call(name, args)).payload).toMatchObject({
        error: "invalid_tag_assignment", unknown: [], retired: ["iOS"], applied: false,
      });
    }
    const retired = { ...assigned, state: "retired" };
    expect((await rig.ok("set_metadata", { uuid: target.uuid, tags: [ios.id] })).tags)
      .toEqual([retired]);
    expect((await rig.ok("search", { query: "iguana", tag: "iOS" })).hits)
      .toEqual([expect.objectContaining({ uuid: target.uuid, tags: [retired] })]);
    expect((await rig.ok("list_docs", { tag: "iOS" })).docs)
      .toContainEqual(expect.objectContaining({ uuid: target.uuid, tags: [retired] }));
  });

  it("preserves or removes assigned retired tags and rejects every invalid value atomically", async () => {
    const rig = await local();
    const keeper = await rig.ok("create_doc", {
      title: "Retired keeper",
      description: "A document that already carries the soon-retired tag.",
      tags: [AUTH.id],
    });
    const target = await rig.ok("create_doc", {
      title: "Atomic target",
      description: "A document whose invalid retag must write nothing.",
      blocks: [{ type: "paragraph", text: "atomic armadillo" }],
    });

    retireTagCatalogEntry(rig.instance.replicas.settings().doc, AUTH.id);
    const retiredAuth = { ...AUTH, state: "retired" } as const;
    expect((await rig.ok("list_tags")).tags).not.toContainEqual({
      id: AUTH.id,
      name: AUTH.name,
    });
    expect((await rig.ok("get_doc", { uuid: keeper.uuid })).tags).toEqual([
      retiredAuth,
    ]);

    const preserved = await rig.ok("set_metadata", {
      uuid: keeper.uuid,
      tags: [AUTH.id, "mcp"],
    });
    expect(preserved.tags).toEqual([retiredAuth, MCP]);
    for (const tag of [AUTH.id, AUTH.name]) {
      expect((await rig.ok("list_docs", { tag })).docs).toEqual([
        expect.objectContaining({ uuid: keeper.uuid }),
      ]);
    }
    expect(
      (await rig.ok("set_metadata", { uuid: keeper.uuid, tags: [MCP.id] })).tags,
    ).toEqual([MCP]);

    // An identity assigned by a client whose catalog this replica has not
    // received: unresolved rather than invalid, so passing it back preserves
    // the assignment nobody here can name.
    const unresolved = { id: OFF_CATALOG, name: null, state: "unresolved" };
    setTags(rig.instance.replicas.replica(keeper.uuid).doc, [
      MCP.id,
      OFF_CATALOG,
    ]);
    expect(
      (await rig.ok("set_metadata", { uuid: keeper.uuid, tags: [OFF_CATALOG] }))
        .tags,
    ).toEqual([unresolved]);

    const beforeDoc = await rig.ok("get_doc", { uuid: target.uuid });
    const beforeStub = getDirectoryEntry(
      rig.instance.replicas.directory().doc,
      target.uuid,
    );
    const beforeIndex = rig.instance.store.search("armadillo", 10);
    const refused = await rig.call("set_metadata", {
      uuid: target.uuid,
      tags: ["missing", AUTH.id, AUTH.name, "also-missing", OFF_CATALOG],
    });

    expect(refused.isError).toBe(true);
    expect(refused.payload).toMatchObject({
      error: "invalid_tag_assignment",
      field: "tags",
      applied: false,
      partial: false,
      // The unresolved identity the keeper preserves is still unknown here:
      // only a document that already carries one may keep it.
      unknown: ["missing", "also-missing", OFF_CATALOG],
      retired: [AUTH.id, AUTH.name],
      recoveryClass: "manual",
    });
    expect(refused.payload.recovery).toContain("list_tags");
    expect(await rig.ok("get_doc", { uuid: target.uuid })).toEqual(beforeDoc);
    expect(
      getDirectoryEntry(rig.instance.replicas.directory().doc, target.uuid),
    ).toEqual(beforeStub);
    expect(rig.instance.store.search("armadillo", 10)).toEqual(beforeIndex);

    const beforeCreate = (await rig.ok("list_docs")).docs;
    const invalidCreate = await rig.call("create_doc", {
      title: "Must not exist",
      description: "An invalid catalog selection refuses before identity.",
      tags: ["unknown-create", AUTH.id],
    });
    expect(invalidCreate.payload).toMatchObject({
      error: "invalid_tag_assignment",
      unknown: ["unknown-create"],
      retired: [AUTH.id],
      applied: false,
      partial: false,
    });
    expect((await rig.ok("list_docs")).docs).toEqual(beforeCreate);
  });

});
