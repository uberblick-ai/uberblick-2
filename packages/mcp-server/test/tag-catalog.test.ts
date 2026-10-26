/** The MCP server's read-only, catalog-aware tag boundary. */

import { afterEach, describe, expect, it } from "vitest";

import type { Hub } from "@uberblick/hub";
import { EXAMPLE_TAGS, deleteTagCatalogEntry, isTagCatalogSeeded, seedTagCatalog, settingsRoom } from "@uberblick/schema";
import { cleanupTestResources, FailingStore, hubUrl, LIVE_HUB_SETTLE, peerClient, startHub, startServer, tempDatabasePath, testConfig, TEST_SECRET, waitForCorpus, waitUntil, WAIT_TIMEOUT_MS, WORKSPACE } from "./helpers.js";
import type { PeerClient, Rig } from "./helpers.js";

const rigs: Rig[] = [];
const hubs: Hub[] = [];
const peers: PeerClient[] = [];

const AUTH = {
  id: EXAMPLE_TAGS[0].id,
  name: EXAMPLE_TAGS[0].name,
} as const;

/** A catalog identity no replica in these tests has an entry for. */

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
  await cleanupTestResources({
    clients: rigs.splice(0).map((client) => () => client.close()),
    peers: peers.splice(0).map((peer) => () => peer.destroy()),
    hubs: hubs.splice(0).map((hub) => () => hub.stop()),
  });
});

describe("the workspace tag catalog", () => {

  it("persists explicit catalog writes across a local-only restart", async () => {
    const databasePath = tempDatabasePath();
    const first = await local(databasePath);
    const tag = await first.ok("create_tag", { name: " Release " });
    await first.ok("edit_tag", { id: tag.id, description: "Use for release coordination." });
    const expected = (await first.ok("list_tags")).tags;
    await first.close();
    rigs.splice(rigs.indexOf(first), 1);
    const restarted = await local(databasePath);
    expect((await restarted.ok("list_tags")).tags).toEqual(expected);
    expect((await restarted.ok("create_tag", { name: "RELEASE", description: "Do not replace." })).description)
      .toBe("Use for release coordination.");
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

  it("never claims a catalog the hub has not delivered is the complete one", async () => {
    const rig = await startServer(
      testConfig({ authSecret: TEST_SECRET, hubUrl: hubUrl(1) }),
    );
    rigs.push(rig);

    const listed = await rig.ok("list_tags");
    expect(listed).toMatchObject({ complete: false, tags: [] });
    expect(listed.catalogHint).toContain("sync_status");
    expect(isTagCatalogSeeded(rig.instance.replicas.settings().doc)).toBe(false);
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

    // Deleted identities cannot be selected, even while the catalog is incomplete.
    seedTagCatalog(rig.instance.replicas.settings().doc);
    deleteTagCatalogEntry(rig.instance.replicas.settings().doc, AUTH.id);
    const blocked = await rig.call("create_doc", {
      title: "Must not exist either",
      description: "A deletion this replica already knows about.",
      tags: [AUTH.id],
    });
    expect(blocked.payload).toMatchObject({
      error: "invalid_tag_assignment",
      unknown: [AUTH.id],
    });

    expect((await rig.ok("list_docs")).docs).toEqual([]);
    const explicit = await rig.ok("create_tag", { name: "release-notes", description: "Use for release summaries." });
    expect(explicit).toMatchObject({ name: "release-notes", applied: true, synced: false });
    expect(await rig.ok("edit_tag", { id: explicit.id, description: null })).not.toHaveProperty("description");
    expect(await rig.ok("list_tags")).toMatchObject({ complete: false, tags: expect.arrayContaining([{ id: explicit.id, name: "release-notes" }]) });
  });

  it.each([null, TEST_SECRET])("does not seed an unseeded shared workspace with admission %s", async authSecret => {
    const hub = await startHub();
    hubs.push(hub);
    const rig = await startServer(testConfig({ hubUrl: hubUrl(hub.port), authSecret, ...LIVE_HUB_SETTLE }));
    rigs.push(rig);
    const listed = await rig.ok("list_tags");
    expect(listed.tags).toEqual([]);
    expect(isTagCatalogSeeded(rig.instance.replicas.settings().doc)).toBe(false);
    if (authSecret !== null) {
      expect(await rig.instance.replicas.waitForSettled({ deadline: performance.now() + WAIT_TIMEOUT_MS }))
        .toMatchObject({ caughtUp: true });
    }
    expect(rig.instance.store.pendingRooms().some(entry => entry.room === settingsRoom(WORKSPACE))).toBe(false);
  });

  it("rebuilds and converges the derived tag index across the hub and an offline restart", async () => {
    const hub = await startHub();
    hubs.push(hub);
    const initialCatalog = await peerClient(hub.port, settingsRoom(WORKSPACE));
    peers.push(initialCatalog);
    await initialCatalog.synced;
    seedTagCatalog(initialCatalog.doc);
    const author = await synced(hub.port);
    const created = await author.ok("create_doc", {
      title: "Convergent catalog",
      description: "A document whose tag state arrives through the settings room.",
      tags: [AUTH.id],
      blocks: [{ type: "paragraph", text: "convergent wombat" }],
    });
    expect(await author.instance.replicas.waitForSettled({ deadline: performance.now() + WAIT_TIMEOUT_MS })).toMatchObject({ caughtUp: true });

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
    for (const tag of [AUTH.id, AUTH.name]) {
      expect((await fresh.call("search", { query: "wombat", tag })).payload)
        .toMatchObject({ error: "invalid_tag_assignment", unknown: [tag] });
    }

    fresh.instance.replicas.rebuildIndex();
    expect((await fresh.ok("search", { query: "wombat" })).hits[0]?.tags).toEqual([]);
    await fresh.close();
    rigs.splice(rigs.indexOf(fresh), 1);

    const offline = await local(databasePath);
    expect((await offline.ok("list_tags")).tags).not.toContainEqual({
      id: AUTH.id,
      name: AUTH.name,
    });
    expect((await offline.ok("search", { query: "wombat" })).hits[0]?.tags).toEqual([]);
  });
});
