/** The MCP server's read-only, catalog-aware tag boundary. */

import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import type { Hub } from "@uberblick/hub";
import {
  EXAMPLE_TAGS,
  createTagCatalogEntry,
  getDirectoryEntry,
  retireTagCatalogEntry,
  setTags,
  settingsRoom,
} from "@uberblick/schema";
import {
  FailingStore,
  hubUrl,
  LIVE_HUB_SETTLE,
  peerClient,
  removeTempDirs,
  startHub,
  startServer,
  tempDatabasePath,
  testConfig,
  TEST_SECRET,
  waitForCorpus,
  waitUntil,
  WORKSPACE,
} from "./helpers.js";
import type { PeerClient, Rig } from "./helpers.js";

const rigs: Rig[] = [];
const hubs: Hub[] = [];
const peers: PeerClient[] = [];

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

async function local(databasePath = tempDatabasePath()): Promise<Rig> {
  const rig = await startServer(testConfig({ databasePath }));
  rigs.push(rig);
  return rig;
}

async function synced(port: number, databasePath = tempDatabasePath()): Promise<Rig> {
  const rig = await startServer(
    testConfig({
      databasePath,
      authSecret: TEST_SECRET,
      hubUrl: hubUrl(port),
      ...LIVE_HUB_SETTLE,
    }),
  );
  rigs.push(rig);
  return rig;
}

afterEach(async () => {
  for (const peer of peers.splice(0)) peer.destroy();
  for (const rig of rigs.splice(0)) await rig.close();
  for (const hub of hubs.splice(0)) await hub.stop().catch(() => {});
  removeTempDirs();
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
    expect(created.tagHint).toContain("set_tags");

    const inserted = await rig.ok("insert_block", {
      uuid: created.uuid,
      type: "paragraph",
      text: "The write still lands while the hint points out the next step.",
    });
    expect(inserted).toMatchObject({
      applied: true,
      synced: expect.any(Boolean),
      hub: { status: "disabled" },
    });
    expect(inserted.tagHint).toContain("list_tags");
    expect(inserted.tagHint).toContain("set_tags");
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
      type: "paragraph",
      text: "The only assignment is retired, but it remains an assignment.",
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

  it("lists a complete deterministic catalog and persists its offline seed", async () => {
    const databasePath = tempDatabasePath();
    const first = await local(databasePath);
    const listed = await first.ok("list_tags");

    expect(listed).toMatchObject({
      workspace: WORKSPACE,
      complete: true,
      tags: EXAMPLE_TAGS.map(({ id, name }) => ({ id, name })),
      hub: { status: "disabled" },
    });
    expect(first.instance.store.hasRoom(settingsRoom(WORKSPACE))).toBe(true);

    await first.ok("create_doc", {
      title: "Tags are not navigation",
      description: "A tagged document leaves explicit sidebar curation alone.",
      tags: ["auth"],
    });
    expect((await first.ok("get_sidebar")).groups).toEqual([]);
    await first.close();
    rigs.splice(rigs.indexOf(first), 1);

    const restarted = await local(databasePath);
    expect((await restarted.ok("list_tags")).tags).toEqual(listed.tags);
    expect((await restarted.ok("get_sidebar")).groups).toEqual([]);
  });

  it("never serves an unlogged seed as a complete catalog", async () => {
    const databasePath = tempDatabasePath();
    const store = new FailingStore(databasePath, WORKSPACE);
    store.failing = true;
    const poisoned = await startServer(testConfig({ databasePath }), store);
    rigs.push(poisoned);

    const refused = await poisoned.call("list_tags");
    expect(refused.payload).toMatchObject({
      error: "persistence_failed",
      room: settingsRoom(WORKSPACE),
      recoveryClass: "manual",
    });
    expect(store.hasRoom(settingsRoom(WORKSPACE))).toBe(false);
    await poisoned.close();
    rigs.splice(rigs.indexOf(poisoned), 1);

    const restarted = await local(databasePath);
    expect((await restarted.ok("list_tags")).tags).toEqual(
      EXAMPLE_TAGS.map(({ id, name }) => ({ id, name })),
    );
  });

  it("never claims a catalog the hub has not delivered is the complete one", async () => {
    const rig = await startServer(
      testConfig({ authSecret: TEST_SECRET, hubUrl: hubUrl(1) }),
    );
    rigs.push(rig);

    const listed = await rig.ok("list_tags");
    expect(listed).toMatchObject({ complete: false });
    expect(listed.hub.status).not.toBe("connected");

    // The curated value this replica has never seen is not an argument to
    // correct: the recovery must not send the caller to a list_tags that is
    // missing the same entry.
    const refused = await rig.call("create_doc", {
      title: "Must not exist",
      description: "A workspace tag this replica may simply not have yet.",
      tags: ["release-notes"],
    });
    expect(refused.payload).toMatchObject({
      error: "invalid_tag_assignment",
      unknown: ["release-notes"],
      applied: false,
      partial: false,
    });
    expect(refused.payload.recovery).toContain("has not reached this replica");

    // A retirement this replica already holds is not waiting on the hub:
    // hydration cannot make the value assignable, so the caller is told to
    // correct the call rather than to repeat it.
    retireTagCatalogEntry(rig.instance.replicas.settings().doc, AUTH.id);
    const blocked = await rig.call("create_doc", {
      title: "Must not exist either",
      description: "A retirement this replica already knows about.",
      tags: [AUTH.id],
    });
    expect(blocked.payload).toMatchObject({
      error: "invalid_tag_assignment",
      retired: [AUTH.id],
      recoveryClass: "manual",
    });
    expect(blocked.payload.recovery).not.toContain("has not reached this replica");

    expect((await rig.ok("list_docs")).docs).toEqual([]);
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
    peer.destroy();

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

    const preserved = await rig.ok("set_tags", {
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
      (await rig.ok("set_tags", { uuid: keeper.uuid, tags: [MCP.id] })).tags,
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
      (await rig.ok("set_tags", { uuid: keeper.uuid, tags: [OFF_CATALOG] }))
        .tags,
    ).toEqual([unresolved]);

    const beforeDoc = await rig.ok("get_doc", { uuid: target.uuid });
    const beforeStub = getDirectoryEntry(
      rig.instance.replicas.directory().doc,
      target.uuid,
    );
    const beforeIndex = rig.instance.store.search("armadillo", 10);
    const refused = await rig.call("set_tags", {
      uuid: target.uuid,
      tags: ["missing", AUTH.id, AUTH.name, "also-missing", OFF_CATALOG],
    });

    expect(refused.isError).toBe(true);
    expect(refused.payload).toMatchObject({
      error: "invalid_tag_assignment",
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

  it("rebuilds and converges the derived tag index across the hub and an offline restart", async () => {
    const hub = await startHub();
    hubs.push(hub);
    const author = await synced(hub.port);
    const created = await author.ok("create_doc", {
      title: "Convergent catalog",
      description: "A document whose tag state arrives through the settings room.",
      tags: [AUTH.id],
      blocks: [{ type: "paragraph", text: "convergent wombat" }],
    });
    await waitUntil("the author's catalog and document to reach the hub", async () => {
      const status = await author.ok("sync_status");
      return status.pendingRooms.length === 0;
    });

    const databasePath = tempDatabasePath();
    const fresh = await synced(hub.port, databasePath);
    await waitForCorpus(fresh, [created.uuid]);
    expect(
      (await fresh.ok("search", { query: "wombat", tag: AUTH.name })).hits[0]
        ?.uuid,
    ).toBe(created.uuid);

    const curator = await peerClient(hub.port, settingsRoom(WORKSPACE));
    peers.push(curator);
    await curator.synced;
    retireTagCatalogEntry(curator.doc, AUTH.id);
    await waitUntil("the retired catalog entry to reach the fresh server", async () => {
      const tags = (await fresh.ok("list_tags")).tags as { id: string }[];
      return !tags.some((tag) => tag.id === AUTH.id);
    });

    const converged = await fresh.ok("get_doc", { uuid: created.uuid });
    expect(converged.tags).toEqual([{ ...AUTH, state: "retired" }]);
    for (const tag of [AUTH.id, AUTH.name]) {
      expect(
        (await fresh.ok("search", { query: "wombat", tag })).hits[0]?.uuid,
      ).toBe(created.uuid);
    }

    fresh.instance.replicas.rebuildIndex();
    expect(
      (await fresh.ok("search", { query: "wombat", tag: AUTH.id })).hits[0]
        ?.uuid,
    ).toBe(created.uuid);
    await fresh.close();
    rigs.splice(rigs.indexOf(fresh), 1);

    const offline = await local(databasePath);
    expect((await offline.ok("list_tags")).tags).not.toContainEqual({
      id: AUTH.id,
      name: AUTH.name,
    });
    expect(
      (await offline.ok("search", { query: "wombat", tag: AUTH.id })).hits[0]
        ?.uuid,
    ).toBe(created.uuid);
  });
});
