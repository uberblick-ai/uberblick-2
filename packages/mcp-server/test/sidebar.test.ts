/**
 * The sidebar tools: curation an agent can build, read and hand over.
 *
 * The sidebar's convergence rules belong to the schema package and are pinned
 * in `packages/schema/test/sidebar.test.ts`. What this suite defends is the
 * tool contract: an agent builds the whole structure through pin_doc and
 * sidebar_group and the stored document agrees with what it was told; titles
 * are resolved from directory stubs rather than by opening documents, and a pin
 * that resolves to nothing stays visible so it can be removed; and the one-time
 * seed reproduces the legacy tag grouping exactly once, without ever writing
 * over curation that already exists.
 */

import { afterAll, afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  createGroup,
  isSidebarSeeded,
  pinDoc,
  readSidebar,
  sidebarRoom,
  upsertDirectoryEntry,
} from "@uberblick/schema";
import type { Hub } from "@uberblick/hub";
import {
  FailingStore,
  hubUrl,
  peerClient,
  removeTempDirs,
  startHub,
  startServer,
  tempDatabasePath,
  testConfig,
  TEST_SECRET,
  waitUntil,
  WORKSPACE,
} from "./helpers.js";
import type { PeerClient, Rig } from "./helpers.js";
import type { MirrorStore } from "../src/store.js";

let rig: Rig | null = null;
const hubs: Hub[] = [];
const peers: PeerClient[] = [];

async function server(
  databasePath = tempDatabasePath(),
  store?: MirrorStore,
): Promise<Rig> {
  rig = await startServer(testConfig({ databasePath }), store);
  return rig;
}

afterEach(async () => {
  await rig?.close();
  rig = null;
  for (const peer of peers.splice(0)) peer.destroy();
  for (const hub of hubs.splice(0)) await hub.stop().catch(() => {});
});

afterAll(removeTempDirs);

/** Group names and their pinned titles, which is what the tools promise. */
function shape(payload: any): [string, (string | null)[]][] {
  return payload.groups.map((group: any) => [
    group.name,
    group.docs.map((doc: any) => doc.title),
  ]);
}

async function createDoc(
  rig: Rig,
  title: string,
  tags?: string[],
): Promise<string> {
  const created = await rig.ok("create_doc", {
    title,
    ...(tags === undefined ? {} : { tags }),
  });
  return created.uuid as string;
}

describe("building a sidebar through the tools", () => {
  it("creates groups by name, orders pins, reorders and hands over cleanly", async () => {
    const rig = await server();
    const overview = await createDoc(rig, "Overview");
    const install = await createDoc(rig, "Install and run");
    const architecture = await createDoc(rig, "Architecture");

    // A group comes into being by being named.
    const first = await rig.ok("pin_doc", {
      uuid: overview,
      group: "Start here",
    });
    expect(shape(first)).toEqual([["Start here", ["Overview"]]]);
    expect(first.applied).toBe(true);
    // Offline by construction in this suite: applied is not synced.
    expect(first.synced).toBe(false);

    await rig.ok("pin_doc", { uuid: install, group: "Start here" });
    await rig.ok("pin_doc", { uuid: architecture, group: "Reference" });
    expect(shape(await rig.ok("get_sidebar"))).toEqual([
      ["Start here", ["Overview", "Install and run"]],
      ["Reference", ["Architecture"]],
    ]);

    // Pinning something already pinned moves it: one pin per document, so this
    // is also how an agent reorders.
    const moved = await rig.ok("pin_doc", {
      uuid: install,
      group: "Start here",
      index: 0,
    });
    expect(moved.moved).toBe(true);
    expect(shape(moved)).toEqual([
      ["Start here", ["Install and run", "Overview"]],
      ["Reference", ["Architecture"]],
    ]);

    // …across groups, too, and without leaving a copy behind.
    await rig.ok("pin_doc", { uuid: architecture, group: "Start here", index: 0 });
    expect(shape(await rig.ok("get_sidebar"))).toEqual([
      ["Start here", ["Architecture", "Install and run", "Overview"]],
      ["Reference", []],
    ]);

    const reordered = await rig.ok("sidebar_group", {
      action: "move",
      group: "Reference",
      index: 0,
    });
    expect(reordered.groups.map((group: any) => group.name)).toEqual([
      "Reference",
      "Start here",
    ]);

    const renamed = await rig.ok("sidebar_group", {
      action: "rename",
      group: "Start here",
      name: "Onboarding",
    });
    expect(renamed.groups.map((group: any) => group.name)).toEqual([
      "Reference",
      "Onboarding",
    ]);

    // The stored document is the sidebar — the tools' answer is a view of it.
    const stored = readSidebar(rig.instance.replicas.sidebar().doc);
    expect(stored.map((group) => group.name)).toEqual([
      "Reference",
      "Onboarding",
    ]);
    expect(stored[1]?.docs).toEqual([architecture, install, overview]);

    // …and list_docs says which documents are entry points.
    const listed = await rig.ok("list_docs");
    expect(
      listed.docs.map((doc: any) => [doc.title, doc.pinned]).sort(),
    ).toEqual([
      ["Architecture", true],
      ["Install and run", true],
      ["Overview", true],
    ]);
  });

  it("unpinning and deleting a group are sidebar-only acts", async () => {
    const rig = await server();
    const overview = await createDoc(rig, "Overview");
    const install = await createDoc(rig, "Install and run");
    await rig.ok("pin_doc", { uuid: overview, group: "Start here" });
    await rig.ok("pin_doc", { uuid: install, group: "Start here" });

    const unpinned = await rig.ok("unpin_doc", { uuid: overview });
    expect(unpinned.unpinned).toBe(true);
    expect(unpinned.applied).toBe(true);
    expect(shape(unpinned)).toEqual([["Start here", ["Install and run"]]]);
    // Unpinning what is not pinned is not an error; it just changes nothing.
    expect((await rig.ok("unpin_doc", { uuid: overview })).unpinned).toBe(false);

    const deleted = await rig.ok("sidebar_group", {
      action: "delete",
      group: "Start here",
    });
    expect(deleted.groups).toEqual([]);

    // Both documents are untouched: the sidebar only ever held their uuids.
    const listed = await rig.ok("list_docs");
    expect(listed.docs.map((doc: any) => [doc.title, doc.pinned])).toEqual([
      ["Install and run", false],
      ["Overview", false],
    ]);
    expect((await rig.ok("get_doc", { uuid: overview })).title).toBe("Overview");

    const missing = await rig.call("sidebar_group", {
      action: "delete",
      group: "Start here",
    });
    expect(missing.isError).toBe(true);
    expect(missing.payload.error).toBe("group_not_found");
  });
});

describe("resolving what the sidebar pins", () => {
  it("reads titles from directory stubs and surfaces what it cannot resolve", async () => {
    const rig = await server();
    const replicas = rig.instance.replicas;

    // A document this replica knows only from the directory: no room of its
    // own has ever reached it, so a resolved title can only have come from the
    // stub — which is the promise, because navigation must not open documents.
    const remote = "6f1a2c3d-4e5b-4a7c-8d9e-0f1a2b3c4d5e";
    upsertDirectoryEntry(replicas.directory().doc, {
      uuid: remote,
      title: "A document from elsewhere",
      tags: [],
    });

    const archived = await createDoc(rig, "Archived");
    await rig.ok("pin_doc", { uuid: archived, group: "Start here" });
    await rig.ok("pin_doc", { uuid: remote, group: "Start here" });
    await rig.ok("archive_doc", { uuid: archived });

    // A uuid nothing in the directory knows, pinned the way another replica's
    // sidebar update would deliver it.
    const orphan = "11111111-2222-4333-8444-555555555555";
    const groupId = readSidebar(replicas.sidebar().doc)[0]?.id as string;
    pinDoc(replicas.sidebar().doc, groupId, orphan);

    const sidebar = await rig.ok("get_sidebar");
    expect(sidebar.groups[0].docs).toEqual([
      { uuid: archived, title: "Archived", status: "archived" },
      { uuid: remote, title: "A document from elsewhere", status: "ok" },
      { uuid: orphan, title: null, status: "unknown" },
    ]);
    expect(replicas.hydrated(remote)).toBe(false);

    // Pinning a uuid the directory has never heard of is refused: the sidebar
    // stores uuids and nothing else, so a typo here is unresolvable forever.
    const refused = await rig.call("pin_doc", {
      uuid: "99999999-8888-4777-8666-555555555555",
      group: "Start here",
    });
    expect(refused.isError).toBe(true);
    expect(refused.payload.error).toBe("doc_not_found");

    // …but one that got in anyway can always be removed, which is why it is
    // shown rather than dropped.
    const cleaned = await rig.ok("unpin_doc", { uuid: orphan });
    expect(cleaned.groups[0].docs.map((doc: any) => doc.uuid)).toEqual([
      archived,
      remote,
    ]);
  });
});

describe("the one-time seed", () => {
  /**
   * The corpus as the legacy tags described it, in no helpful order.
   *
   * Written as directory stubs, which is all the seed reads: it groups the
   * corpus without opening a single document.
   */
  const CORPUS: [string, string[]][] = [
    ["Architecture", ["reference"]],
    ["Install and run", ["start-here"]],
    ["Editing and blocks", ["feature"]],
    ["Overview", ["start-here"]],
    ["Test protocols", ["verify"]],
    ["Annotations", ["feature"]],
    ["Scratch", []],
  ];

  /** The uuid of the nth corpus document. Stable, so a hub can be primed. */
  const corpusUuid = (index: number): string =>
    `0000000${index}-1111-4222-8333-444444444444`;

  /** The seeded sidebar, as every test here expects to find it. */
  const SEEDED: [string, (string | null)[]][] = [
    ["Start here", ["Overview", "Install and run"]],
    ["Features", ["Annotations", "Editing and blocks"]],
    ["Verify", ["Test protocols"]],
    ["Reference", ["Architecture"]],
  ];

  /**
   * A database holding the tagged corpus and nothing else.
   *
   * The seed runs at server start, so the corpus has to be in the log before
   * the server that migrates it comes up — which is also the real shape of the
   * migration: the documents were there first.
   */
  async function corpusDatabase(): Promise<string> {
    const databasePath = tempDatabasePath();
    const rig = await server(databasePath);
    const directory = rig.instance.replicas.directory().doc;
    for (const [index, [title, tags]] of CORPUS.entries()) {
      upsertDirectoryEntry(directory, { uuid: corpusUuid(index), title, tags });
    }
    await rig.close();
    return databasePath;
  }

  it("reproduces the tag groups once, in the owner's order", async () => {
    const databasePath = await corpusDatabase();
    const seeded = await server(databasePath);

    const sidebar = await seeded.ok("get_sidebar");
    expect(shape(sidebar)).toEqual(SEEDED);
    // An untagged document is not curation, and stays out of the sidebar.
    const listed = await seeded.ok("list_docs");
    expect(
      listed.docs.filter((doc: any) => !doc.pinned).map((doc: any) => doc.title),
    ).toEqual(["Scratch"]);
    await seeded.close();
    rig = null;

    // The flag, not the emptiness, is what says it has run — so a restart
    // neither re-seeds nor duplicates a group.
    const restarted = await server(databasePath);
    expect(await restarted.ok("get_sidebar")).toEqual(sidebar);
  });

  it("leaves a sidebar emptied on purpose empty", async () => {
    const databasePath = await corpusDatabase();
    const seeded = await server(databasePath);
    for (const [name] of SEEDED) {
      await seeded.ok("sidebar_group", { action: "delete", group: name });
    }
    expect((await seeded.ok("get_sidebar")).groups).toEqual([]);
    await seeded.close();
    rig = null;

    // The delete sticks: a migration that ran once does not run again because
    // somebody chose to keep no groups at all.
    const restarted = await server(databasePath);
    expect((await restarted.ok("get_sidebar")).groups).toEqual([]);
  });

  it("never writes over curation that is already there", async () => {
    const databasePath = tempDatabasePath();
    const before = await server(databasePath);
    const directory = before.instance.replicas.directory().doc;
    const uuid = "0000000a-1111-4222-8333-444444444444";
    // A tagged corpus, and a sidebar somebody built by hand before the flag
    // existed — the upgrade case, and the one a migration must not clobber.
    upsertDirectoryEntry(directory, { uuid, title: "Overview", tags: ["start-here"] });
    await before.ok("pin_doc", { uuid, group: "Mine" });
    await before.close();
    rig = null;

    const after = await server(databasePath);
    expect(shape(await after.ok("get_sidebar"))).toEqual([["Mine", ["Overview"]]]);
    // Adopted, not seeded: the flag is set, so it stays this way.
    expect(isSidebarSeeded(after.instance.replicas.sidebar().doc)).toBe(true);
  });

  it("converges when two replicas seed the same corpus offline", async () => {
    // Two machines, each with the corpus in its own log, each starting with no
    // hub — so neither can see that the other has already migrated.
    const first = await server(await corpusDatabase());
    const left = first.instance.replicas.sidebar().doc;
    const second = await startServer(
      testConfig({ databasePath: await corpusDatabase() }),
    );
    const right = second.instance.replicas.sidebar().doc;
    expect(shape(await second.ok("get_sidebar"))).toEqual(SEEDED);

    // …and when they meet, one sidebar rather than two sets of same-named
    // groups: the seed's group ids are fixed, so both wrote the same groups.
    Y.applyUpdate(left, Y.encodeStateAsUpdate(right));
    Y.applyUpdate(right, Y.encodeStateAsUpdate(left));
    await second.close();

    expect(readSidebar(left)).toEqual(readSidebar(right));
    expect(shape(await first.ok("get_sidebar"))).toEqual(SEEDED);
  });

  it("reports a seed the update log refused, and does not keep it", async () => {
    const databasePath = await corpusDatabase();
    const refusing = new FailingStore(databasePath);
    refusing.failing = true;
    const failed = await server(databasePath, refusing);

    // The seed could not be logged, so this replica is ahead of its own log and
    // every tool refuses — including the one that would have shown the sidebar.
    const refused = await failed.call("get_sidebar");
    expect(refused.isError).toBe(true);
    expect(refused.payload.error).toBe("persistence_failed");
    await failed.close();
    rig = null;

    // Nothing of it survived: the next start finds the sidebar unseeded and
    // migrates for real.
    const healthy = await server(databasePath);
    expect(shape(await healthy.ok("get_sidebar"))).toEqual(SEEDED);
  });

  it("adopts curation the hub already holds instead of seeding over it", async () => {
    // The dangerous shape, and the reason the decision waits for a settle: this
    // machine's log holds the tagged corpus, so from local state alone the
    // migration has everything it needs to seed — while the curation it must not
    // write over is still on the hub.
    const databasePath = await corpusDatabase();
    const hub = await startHub();
    hubs.push(hub);

    const curated = await peerClient(hub.port, sidebarRoom(WORKSPACE));
    peers.push(curated);
    await curated.synced;
    pinDoc(curated.doc, createGroup(curated.doc, "Mine"), corpusUuid(3));

    // Witnessed through a third client, so what follows is state the hub can
    // actually deliver rather than a write that never left the peer.
    const witness = await peerClient(hub.port, sidebarRoom(WORKSPACE));
    peers.push(witness);
    await waitUntil("the hub to hold the hand-made sidebar", () =>
      readSidebar(witness.doc).length === 1,
    );

    const fresh = await startServer(
      testConfig({
        databasePath,
        authSecret: TEST_SECRET,
        hubUrl: hubUrl(hub.port),
      }),
    );
    rig = fresh;

    // One group, not five: the migration settled first, saw the curation, and
    // adopted it instead of seeding four groups over the top.
    expect(shape(await fresh.ok("get_sidebar"))).toEqual([["Mine", ["Overview"]]]);
    expect(isSidebarSeeded(fresh.instance.replicas.sidebar().doc)).toBe(true);
  });
});
