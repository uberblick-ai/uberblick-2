/** The MCP server's read-only, catalog-aware tag boundary. */

import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import type { Hub } from "@uberblick/hub";
import {
  EXAMPLE_TAGS,
  createTagCatalogEntry,
  deleteTagCatalogEntry,
  getBlocksFragment,
  getMeta,
  getTagCatalogIdentities,
  isTagCatalogIdentityDeleted,
  roomForDoc,
  TAG_CATALOG_FLAGS_KEY,
  setTagCatalogDescription,
  setBlockType,
  setTags,
  settingsRoom,
  TAG_CATALOG_RETIRED_KEY,
  TAG_CATALOG_RESTORED_KEY,
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
import { MirrorStore } from "../src/store.js";

const rigs: Rig[] = [];
const hubs: Hub[] = [];
const peers: PeerClient[] = [];

const AUTH = {
  id: EXAMPLE_TAGS[0].id,
  name: EXAMPLE_TAGS[0].name,
} as const;
const MCP = {
  id: EXAMPLE_TAGS[2].id,
  name: EXAMPLE_TAGS[2].name,
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
    expect(created.tagHint).toContain("set_metadata");

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

  it("nudges a document after its last tag is deleted and stays quiet with no catalog choices", async () => {
    const rig = await local();
    const assigned = await rig.ok("create_doc", {
      title: "Classified before deletion",
      description: "A deleted assignment no longer classifies the document.",
      tags: [AUTH.id],
    });
    expect(assigned.tagHint).toBeUndefined();

    deleteTagCatalogEntry(rig.instance.replicas.settings().doc, AUTH.id);
    const retained = await rig.ok("insert_block", {
      uuid: assigned.uuid,
      type: "paragraph",
      text: "The deleted assignment is cleaned during this write.",
    });
    expect(retained.tagHint).toContain("list_tags");

    for (const tag of EXAMPLE_TAGS.filter(({ id }) => id !== AUTH.id)) {
      deleteTagCatalogEntry(rig.instance.replicas.settings().doc, tag.id);
    }
    const noChoices = await rig.ok("create_doc", {
      title: "No local vocabulary",
      description: "An untagged document when the local catalog has no entry.",
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
      tags: ["rfc"],
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

  it("migrates persisted retired catalog identities without rewriting their document", async () => {
    const databasePath = tempDatabasePath();
    const first = await local(databasePath);
    getTagCatalogIdentities(first.instance.replicas.settings().doc).set(OFF_CATALOG, "legacy");
    const created = await first.ok("create_doc", {
      title: "Legacy classification", description: "Retirement migration must touch only the catalog.", tags: [OFF_CATALOG],
    });
    const room = roomForDoc(WORKSPACE, created.uuid);
    const updates = first.instance.store.updateCount(room);
    await first.close();
    rigs.splice(rigs.indexOf(first), 1);

    const legacy = new Y.Doc();
    legacy.getMap<boolean>(TAG_CATALOG_FLAGS_KEY).set("examples-seeded", true);
    legacy.getMap<number>(TAG_CATALOG_RETIRED_KEY).set("legacy#123", 1);
    const store = new MirrorStore(databasePath, WORKSPACE);
    try {
      store.appendUpdate(settingsRoom(WORKSPACE), Y.encodeStateAsUpdate(legacy), "remote");
    } finally {
      store.close();
      legacy.destroy();
    }
    const restarted = await local(databasePath);
    expect((await restarted.ok("list_tags")).tags).not.toContainEqual({ id: OFF_CATALOG, name: "legacy" });
    expect((await restarted.ok("get_doc", { uuid: created.uuid })).tags).toEqual([]);
    expect(getMeta(restarted.instance.replicas.replica(created.uuid).doc).tags).toEqual([OFF_CATALOG]);
    expect(restarted.instance.store.updateCount(room)).toBe(updates);
    const recreated = createTagCatalogEntry(restarted.instance.replicas.settings().doc, "legacy");
    expect(recreated.id).not.toBe(OFF_CATALOG);
    expect((await restarted.ok("get_doc", { uuid: created.uuid })).tags).toEqual([]);
    await restarted.ok("set_metadata", { uuid: created.uuid, description: "The later update permits cleanup." });
    expect(getMeta(restarted.instance.replicas.replica(created.uuid).doc).tags).toEqual([]);
  });

  it("merges the current hub restoration before migrating a stale retired cache", async () => {
    const hub = await startHub();
    hubs.push(hub);
    const curator = await peerClient(hub.port, settingsRoom(WORKSPACE));
    peers.push(curator);
    await curator.synced;
    const stale = new Y.Doc();
    getTagCatalogIdentities(stale).set(OFF_CATALOG, "legacy");
    stale.getMap<boolean>(TAG_CATALOG_FLAGS_KEY).set("examples-seeded", true);
    stale.getMap<number>(TAG_CATALOG_RETIRED_KEY).set("legacy#123", 1);
    const retiredState = Y.encodeStateAsUpdate(stale);
    Y.applyUpdate(curator.doc, retiredState);
    curator.doc.getMap<number>(TAG_CATALOG_RESTORED_KEY).set("legacy#123", 1);
    await waitUntil("the current restored catalog to reach the hub", async () => !curator.provider.hasUnsyncedChanges);
    stale.destroy();

    const databasePath = tempDatabasePath();
    const store = new MirrorStore(databasePath, WORKSPACE);
    try {
      store.appendUpdate(settingsRoom(WORKSPACE), retiredState, "remote");
    } finally {
      store.close();
    }
    const restarted = await synced(hub.port, databasePath);
    expect((await restarted.ok("list_tags")).tags).toContainEqual({ id: OFF_CATALOG, name: "legacy" });
    expect(isTagCatalogIdentityDeleted(restarted.instance.replicas.settings().doc, OFF_CATALOG)).toBe(false);
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

    // A deletion this replica already holds is not waiting on the hub:
    // hydration cannot make the value assignable, so the caller is told to
    // correct the call rather than to repeat it.
    deleteTagCatalogEntry(rig.instance.replicas.settings().doc, AUTH.id);
    const blocked = await rig.call("create_doc", {
      title: "Must not exist either",
      description: "A deletion this replica already knows about.",
      tags: [AUTH.id],
    });
    expect(blocked.payload).toMatchObject({
      error: "invalid_tag_assignment",
      unknown: [AUTH.id],
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
    setTagCatalogDescription(rig.instance.replicas.settings().doc, AUTH.id, "Authentication in this workspace.");
    const describedAuth = { ...AUTH, description: "Authentication in this workspace." };
    const created = await rig.ok("create_doc", {
      title: "Catalog contract",
      description: "A searchable document with catalog-owned assignments.",
      tags: ["mcp", AUTH.id, "auth"],
      blocks: [{ type: "paragraph", text: "catalog capybara" }],
    });

    expect(created.tags).toEqual([describedAuth, MCP]);
    expect((await rig.ok("get_doc", { uuid: created.uuid })).tags).toEqual([
      describedAuth,
      MCP,
    ]);

    for (const tag of ["auth", AUTH.id]) {
      const listed = await rig.ok("list_docs", { tag });
      expect(listed.docs).toHaveLength(1);
      expect(listed.docs[0]).toMatchObject({ uuid: created.uuid });
      expect(listed.docs[0].tags).toEqual([describedAuth, MCP]);
    }

    for (const tag of ["mcp", MCP.id]) {
      const searched = await rig.ok("search", {
        query: "capybara",
        tag,
      });
      expect(searched.hits).toHaveLength(1);
      expect(searched.hits[0]).toMatchObject({ uuid: created.uuid });
      expect(searched.hits[0].tags).toEqual([describedAuth, MCP]);
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
        recoveryClass: "manual",
      });
    }

    const exported = await rig.ok("export_markdown", { uuid: created.uuid });
    expect(exported.markdown).toContain("tags: [auth, mcp]");
    expect(exported.markdown).not.toContain(AUTH.id);
    expect(exported.markdown).not.toContain(MCP.id);
    expect(exported.markdown).not.toContain(describedAuth.description);
    expect((await rig.ok("list_tags")).tags).toContainEqual(describedAuth);
  });

  it("hides missing and deleted references on reads, retains delayed references and cleans only permitted writes", async () => {
    const rig = await local();
    const created = await rig.ok("create_doc", {
      title: "Deletion boundary",
      description: "References outlive their visible catalog entries.",
      tags: [AUTH.id, MCP.id],
      blocks: [{ type: "paragraph", text: "boundary armadillo" }],
    });
    const replica = rig.instance.replicas.replica(created.uuid);
    setTags(replica.doc, [AUTH.id, MCP.id, OFF_CATALOG]);
    const room = roomForDoc(WORKSPACE, created.uuid);
    const beforeDeletion = rig.instance.store.updateCount(room);
    deleteTagCatalogEntry(rig.instance.replicas.settings().doc, AUTH.id);
    expect(rig.instance.store.updateCount(room)).toBe(beforeDeletion);

    expect((await rig.ok("list_tags")).complete).toBe(true);
    expect((await rig.ok("get_doc", { uuid: created.uuid })).tags).toEqual([MCP]);
    expect((await rig.ok("list_docs")).docs[0].tags).toEqual([MCP]);
    expect((await rig.ok("search", { query: "armadillo" })).hits[0].tags).toEqual([MCP]);
    expect((await rig.ok("export_markdown", { uuid: created.uuid })).markdown).toContain("tags: [mcp]");
    expect(rig.instance.store.updateCount(room)).toBe(beforeDeletion);
    expect(getMeta(replica.doc).tags).toEqual([AUTH.id, MCP.id, OFF_CATALOG]);

    for (const tag of [AUTH.id, AUTH.name, OFF_CATALOG]) {
      expect((await rig.call("list_docs", { tag })).payload).toMatchObject({
        error: "invalid_tag_assignment", unknown: [tag],
      });
      expect((await rig.call("search", { query: "armadillo", tag })).payload).toMatchObject({
        error: "invalid_tag_assignment", unknown: [tag],
      });
    }
    const refused = await rig.call("set_metadata", {
      uuid: created.uuid, title: "Must remain unchanged", tags: [AUTH.id, AUTH.name, OFF_CATALOG, "missing"],
    });
    expect(refused.payload).toMatchObject({
      error: "invalid_tag_assignment", field: "tags", applied: false, partial: false,
      unknown: [AUTH.id, AUTH.name, OFF_CATALOG, "missing"],
    });
    expect(rig.instance.store.updateCount(room)).toBe(beforeDeletion);
    expect(getMeta(replica.doc).title).toBe("Deletion boundary");
    await rig.ok("update_data", { uuid: created.uuid, operations: [] });
    expect(rig.instance.store.updateCount(room)).toBe(beforeDeletion);
    expect(getMeta(replica.doc).tags).toEqual([AUTH.id, MCP.id, OFF_CATALOG]);

    expect((await rig.ok("set_metadata", { uuid: created.uuid, tags: [] })).tags).toEqual([]);
    expect(getMeta(replica.doc).tags).toEqual([OFF_CATALOG]);
    createTagCatalogEntry(rig.instance.replicas.settings().doc, "arrived", OFF_CATALOG);
    const afterWrite = rig.instance.store.updateCount(room);
    const arrived = { id: OFF_CATALOG, name: "arrived" };
    expect((await rig.ok("get_doc", { uuid: created.uuid })).tags).toEqual([arrived]);
    expect((await rig.ok("search", { query: "armadillo", tag: "arrived" })).hits[0].tags).toEqual([arrived]);
    expect(rig.instance.store.updateCount(room)).toBe(afterWrite);

    const recreated = createTagCatalogEntry(rig.instance.replicas.settings().doc, AUTH.name);
    expect(recreated.id).not.toBe(AUTH.id);
    expect((await rig.ok("get_doc", { uuid: created.uuid })).tags).toEqual([arrived]);
    const beforeCreate = (await rig.ok("list_docs")).docs;
    expect((await rig.call("create_doc", {
      title: "Must not exist", description: "Deleted identities cannot be selected.", tags: [AUTH.id],
    })).payload).toMatchObject({ error: "invalid_tag_assignment", unknown: [AUTH.id], applied: false });
    expect((await rig.ok("list_docs")).docs).toEqual(beforeCreate);
  });

  it("cleans after authored content or metadata writes, while archive and content-lock refusals preserve references", async () => {
    const rig = await local();
    const page = await rig.ok("create_doc", {
      title: "Authored content", description: "A content edit permits cleanup.", tags: [AUTH.id],
    });
    const archived = await rig.ok("create_doc", {
      title: "Archived", description: "Archived documents keep stored references.", tags: [AUTH.id],
    });
    const decided = await rig.ok("create_doc", {
      title: "Locked decision", description: "Content writes remain forbidden.", tags: [AUTH.id],
      kind: "decision", status: "decided", blocks: [{ type: "paragraph", text: "A settled answer." }],
    });
    await rig.ok("archive_doc", { uuid: archived.uuid });
    deleteTagCatalogEntry(rig.instance.replicas.settings().doc, AUTH.id);
    const archivedDoc = rig.instance.replicas.replica(archived.uuid).doc;
    const decidedDoc = rig.instance.replicas.replica(decided.uuid).doc;
    expect((await rig.call("set_metadata", { uuid: archived.uuid, description: "Must be refused." })).payload.error).toBe("doc_archived");
    expect((await rig.call("insert_block", { uuid: decided.uuid, type: "paragraph", text: "Must be refused." })).payload.error).toBe("decision_read_only");
    expect(getMeta(archivedDoc).tags).toEqual([AUTH.id]);
    expect(getMeta(decidedDoc).tags).toEqual([AUTH.id]);
    expect((await rig.ok("get_doc", { uuid: archived.uuid })).tags).toEqual([]);
    await rig.ok("restore_doc", { uuid: archived.uuid });
    expect(getMeta(archivedDoc).tags).toEqual([AUTH.id]);
    await rig.ok("insert_block", { uuid: page.uuid, type: "paragraph", text: "A permitted update." });
    expect(getMeta(rig.instance.replicas.replica(page.uuid).doc).tags).toEqual([]);
    await rig.ok("set_metadata", { uuid: decided.uuid, description: "Metadata remains writable." });
    expect(getMeta(decidedDoc).tags).toEqual([]);
    expect(getMeta(archivedDoc).tags).toEqual([AUTH.id]);
  });

  it("keeps deletion references through local block repairs prompted by synchronized updates", async () => {
    const rig = await local();
    const created = await rig.ok("create_doc", {
      title: "Synchronization repair", description: "Repairing remote content is not an authored cleanup boundary.",
      tags: [AUTH.id], blocks: [{ type: "paragraph", text: "Shared answer." }],
    });
    const document = rig.instance.replicas.replica(created.uuid).doc;
    deleteTagCatalogEntry(rig.instance.replicas.settings().doc, AUTH.id);
    const initial = Y.encodeStateAsUpdate(document);
    const updates = (["heading", "code"] as const).map(type => {
      const peer = new Y.Doc();
      try {
        Y.applyUpdate(peer, initial);
        const before = Y.encodeStateVector(peer);
        setBlockType(peer, created.blocks[0].id, type);
        return Y.encodeStateAsUpdate(peer, before);
      } finally {
        peer.destroy();
      }
    });
    rig.instance.store.appendUpdate(roomForDoc(WORKSPACE, created.uuid), Y.mergeUpdates(updates), "remote");
    expect((await rig.ok("get_doc", { uuid: created.uuid })).tags).toEqual([]);
    expect(getBlocksFragment(document).length).toBe(1);
    expect(getMeta(document).tags).toEqual([AUTH.id]);
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
    deleteTagCatalogEntry(curator.doc, AUTH.id);
    await waitUntil("the deleted catalog entry to reach the fresh server", async () => {
      const tags = (await fresh.ok("list_tags")).tags as { id: string }[];
      return !tags.some((tag) => tag.id === AUTH.id);
    });

    const converged = await fresh.ok("get_doc", { uuid: created.uuid });
    expect(converged.tags).toEqual([]);
    expect(getMeta(fresh.instance.replicas.replica(created.uuid).doc).tags).toEqual([AUTH.id]);
    for (const tag of [AUTH.id, AUTH.name]) {
      expect((await fresh.call("search", { query: "wombat", tag })).payload).toMatchObject({
        error: "invalid_tag_assignment", unknown: [tag],
      });
    }

    fresh.instance.replicas.rebuildIndex();
    expect((await fresh.ok("search", { query: "wombat" })).hits[0].tags).toEqual([]);
    expect(getMeta(fresh.instance.replicas.replica(created.uuid).doc).tags).toEqual([AUTH.id]);
    await fresh.close();
    rigs.splice(rigs.indexOf(fresh), 1);

    const offline = await local(databasePath);
    expect((await offline.ok("list_tags")).tags).not.toContainEqual({
      id: AUTH.id,
      name: AUTH.name,
    });
    expect((await offline.ok("search", { query: "wombat" })).hits[0].tags).toEqual([]);
    expect(getMeta(offline.instance.replicas.replica(created.uuid).doc).tags).toEqual([AUTH.id]);
  });
});
