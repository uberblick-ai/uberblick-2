/**
 * `create_doc`'s optional sidebar placement: one call, up to three rooms, and
 * no claim the rooms cannot back.
 *
 * The contract this suite defends is the honest one the issue chose over
 * transactional machinery that does not exist: placement is expressed once, in
 * an input that cannot say two contradictory things; an unknown group fails
 * having created nothing; and a create that gets part-way says which rooms are
 * durable, which one refused, that nothing was rolled back, and what to do
 * about it. The sidebar's own convergence rules belong to the schema package,
 * and pin_doc's public behaviour to `sidebar.test.ts` — neither is retested
 * here.
 */

import { randomUUID } from "node:crypto";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
  deleteGroup,
  getMeta,
  listDirectory,
  readSidebar,
} from "@uberblick/schema";
import type { Hub } from "@uberblick/hub";
import {
  FailingStore,
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
import type { MirrorStore, UpdateOrigin } from "../src/store.js";

const rigs: Rig[] = [];
const stores: MirrorStore[] = [];
const hubs: Hub[] = [];
const peers: PeerClient[] = [];

async function server(
  databasePath = tempDatabasePath(),
  store?: MirrorStore,
  hubPort?: number,
): Promise<Rig> {
  const rig = await startServer(
    testConfig({
      databasePath,
      ...(hubPort === undefined
        ? {}
        : { authSecret: TEST_SECRET, hubUrl: `ws://127.0.0.1:${hubPort}` }),
    }),
    store,
  );
  rigs.push(rig);
  return rig;
}

/** A failing store that also counts the appends it let through, by room. */
class CountingStore extends FailingStore {
  readonly appends = new Map<string, number>();

  override appendUpdate(
    room: string,
    payload: Uint8Array,
    origin: UpdateOrigin,
  ): number {
    const seq = super.appendUpdate(room, payload, origin);
    this.appends.set(room, (this.appends.get(room) ?? 0) + 1);
    return seq;
  }
}

function failingStore(databasePath: string): CountingStore {
  const store = new CountingStore(databasePath, WORKSPACE);
  stores.push(store);
  return store;
}

/** A group, made the only way there is to make one: by pinning into it. */
async function groupWith(rig: Rig, title: string): Promise<string> {
  const anchor = await rig.ok("create_doc", {
    title,
    description: "A test document.",
  });
  const pinned = await rig.ok("pin_doc", {
    uuid: anchor.uuid,
    group: "Start here",
  });
  return pinned.group.id as string;
}

/** Group names and their pinned titles — what an agent reads back. */
function shape(sidebar: any): [string, (string | null)[]][] {
  return sidebar.groups.map((group: any) => [
    group.name,
    group.docs.map((doc: any) => doc.title),
  ]);
}

function pinCount(sidebar: any, uuid: string): number {
  return sidebar.groups.reduce(
    (total: number, group: any) =>
      total + group.docs.filter((doc: any) => doc.uuid === uuid).length,
    0,
  );
}

afterEach(async () => {
  for (const peer of peers.splice(0)) peer.destroy();
  for (const rig of rigs.splice(0)) await rig.close();
  for (const store of stores.splice(0)) store.close();
  for (const hub of hubs.splice(0)) await hub.stop().catch(() => {});
});

afterAll(removeTempDirs);

describe("the placement input", () => {
  it("refuses everything but a group id and a position, creating nothing", async () => {
    const rig = await server();
    const group = await groupWith(rig, "Anchor");
    const before = (await rig.ok("list_docs")).docs.length;

    const refused = [
      // A placement has to say which group.
      { sidebar: {} },
      { sidebar: { group: {} } },
      { sidebar: { group: { id: "" } } },
      // Positions are non-negative integers, or absent.
      { sidebar: { group: { id: group, position: -1 } } },
      { sidebar: { group: { id: group, position: 1.5 } } },
      // The states this input deliberately cannot express.
      { sidebar: { group: { id: group }, state: "pinned" } },
      { sidebar: { group: { id: group }, pinned: true } },
      { sidebar: { pinned: true } },
      // A name is not an id: create_doc never brings a group into being.
      { sidebar: { group: { name: "Start here" } } },
      // And the same redundancy at the top level, where the input is strict too.
      { pinned: true },
    ];
    for (const placement of refused) {
      const result = await rig.call("create_doc", {
        title: "Rejected",
        description: "A test document.",
        ...placement,
      });
      expect(result.isError, JSON.stringify(placement)).toBe(true);
    }

    // A group id nobody has: rejected too, and named as such rather than
    // created under that id.
    const unknown = await rig.call("create_doc", {
      title: "Rejected",
      description: "A test document.",
      sidebar: { group: { id: randomUUID() } },
    });
    expect(unknown.isError).toBe(true);
    expect(unknown.payload.error).toBe("group_not_found");
    expect(unknown.payload.applied).toBe(false);

    // Nothing reached a room: no document, and the sidebar as it was.
    expect((await rig.ok("list_docs")).docs).toHaveLength(before);
    expect(shape(await rig.ok("get_sidebar"))).toEqual([
      ["Start here", ["Anchor"]],
    ]);
  });

  it("leaves the default alone: omitted placement writes no sidebar update", async () => {
    const rig = await server();
    await groupWith(rig, "Anchor");

    let sidebarUpdates = 0;
    rig.instance.replicas.sidebar().doc.on("update", () => {
      sidebarUpdates += 1;
    });

    const created = await rig.ok("create_doc", {
      title: "Unpinned",
      description: "A test document.",
    });
    expect(created.sidebar).toBeUndefined();
    expect(sidebarUpdates).toBe(0);
    expect(shape(await rig.ok("get_sidebar"))).toEqual([
      ["Start here", ["Anchor"]],
    ]);

    const listed = (await rig.ok("list_docs")).docs.find(
      (doc: any) => doc.uuid === created.uuid,
    );
    expect(listed.pinned).toBe(false);
    // The rooms it did touch are still reported, both of them.
    expect(created.rooms.map((room: any) => room.purpose)).toEqual([
      "document",
      "directory",
    ]);
  });

  it("pins into an existing group at the position it was given", async () => {
    const rig = await server();
    const group = await groupWith(rig, "Anchor");

    const first = await rig.ok("create_doc", {
      title: "Leading",
      description: "A test document.",
      sidebar: { group: { id: group, position: 0 } },
    });
    expect(first.sidebar).toEqual({
      group: { id: group, name: "Start here" },
      position: 0,
    });

    // A position past the end is clamped, and the answer says where it landed
    // rather than repeating what was asked for.
    const last = await rig.ok("create_doc", {
      title: "Trailing",
      description: "A test document.",
      sidebar: { group: { id: group, position: 99 } },
    });
    expect(last.sidebar.position).toBe(2);

    const sidebar = await rig.ok("get_sidebar");
    expect(shape(sidebar)).toEqual([
      ["Start here", ["Leading", "Anchor", "Trailing"]],
    ]);
    expect(pinCount(sidebar, first.uuid)).toBe(1);
    expect(pinCount(sidebar, last.uuid)).toBe(1);

    const docs = (await rig.ok("list_docs")).docs;
    for (const uuid of [first.uuid, last.uuid]) {
      expect(docs.find((doc: any) => doc.uuid === uuid).pinned).toBe(true);
    }

    // All three rooms, each with its own durability, and the aggregate never
    // ahead of the weakest of them.
    expect(first.rooms.map((room: any) => room.purpose)).toEqual([
      "document",
      "directory",
      "sidebar",
    ]);
    expect(first.applied).toBe(true);
    expect(first.rooms.every((room: any) => room.applied)).toBe(true);
    // Local-only rig: nothing is acknowledged by a hub that is not there.
    expect(first.rooms.every((room: any) => room.synced === false)).toBe(true);
    expect(first.synced).toBe(false);
  });
});

describe("with no hub", () => {
  it("applies locally, survives a restart, and converges when the hub comes up", async () => {
    // Take a port and give it back: the server dials an address that only
    // starts answering later.
    const hubDatabase = tempDatabasePath();
    const first = await startHub({ databasePath: hubDatabase });
    const port = first.port;
    await first.stop();

    const databasePath = tempDatabasePath();
    const rig = await server(databasePath, undefined, port);
    const group = await groupWith(rig, "Anchor");

    const placed = await rig.ok("create_doc", {
      title: "Placed offline",
      description: "A test document.",
      blocks: [{ type: "paragraph", text: "no hub was involved" }],
      sidebar: { group: { id: group } },
    });
    const plain = await rig.ok("create_doc", {
      title: "Unplaced offline",
      description: "A test document.",
    });
    for (const created of [placed, plain]) {
      expect(created.applied).toBe(true);
      expect(created.synced).toBe(false);
      expect(created.rooms.every((room: any) => room.synced === false)).toBe(
        true,
      );
    }

    // The log is the replica: a restart rebuilds all of it, placement included.
    await rig.close();
    rigs.length = 0;
    const restarted = await server(databasePath, undefined, port);
    expect((await restarted.ok("get_doc", { uuid: placed.uuid })).title).toBe(
      "Placed offline",
    );
    expect(shape(await restarted.ok("get_sidebar"))).toEqual([
      ["Start here", ["Anchor", "Placed offline"]],
    ]);
    const listed = (await restarted.ok("list_docs")).docs;
    expect(
      listed.find((doc: any) => doc.uuid === placed.uuid).pinned,
    ).toBe(true);
    expect(listed.find((doc: any) => doc.uuid === plain.uuid).pinned).toBe(
      false,
    );

    // The hub comes up on the same address, and a fresh client sees the
    // document, the stub and the pin — the three rooms this call wrote.
    const started = await startHub({ port, databasePath: hubDatabase });
    hubs.push(started);
    const peer = async (room: string): Promise<PeerClient> => {
      const client = await peerClient(port, room);
      peers.push(client);
      return client;
    };
    const docPeer = await peer(`${WORKSPACE}/${placed.uuid}`);
    const directoryPeer = await peer(`${WORKSPACE}/_directory`);
    const sidebarPeer = await peer(`${WORKSPACE}/_sidebar`);

    await waitUntil("the offline-created document to reach a second client", () =>
      getMeta(docPeer.doc).title === "Placed offline",
    );
    await waitUntil("its directory stub to reach a second client", () =>
      listDirectory(directoryPeer.doc).some(
        (entry) => entry.uuid === placed.uuid,
      ),
    );
    await waitUntil("its pin to reach a second client", () =>
      readSidebar(sidebarPeer.doc).some((group) =>
        group.docs.includes(placed.uuid),
      ),
    );

    // And only then does the call's own claim become true for every room.
    await waitUntil("every room this server holds to be acknowledged", async () => {
      const status = await restarted.ok("sync_status", {});
      return (
        status.hub.status === "connected" &&
        status.unsyncedChanges === 0 &&
        status.pendingRooms.length === 0
      );
    });
  });
});

describe("a create that gets part-way", () => {
  it("writes the document in one append, so a refusal leaves nothing behind", async () => {
    const databasePath = tempDatabasePath();
    const store = failingStore(databasePath);
    const rig = await server(databasePath, store);
    const group = await groupWith(rig, "Anchor");

    // Metadata and every initial block are ONE append to the document's room.
    // Two would leave a moment where the title is durable and a block is not,
    // and `completed: []` below would be a lie about exactly that moment.
    const healthy = await rig.ok("create_doc", {
      title: "Whole or nothing",
      description: "A test document.",
      blocks: [
        { type: "paragraph", text: "one" },
        { type: "paragraph", text: "two" },
        { type: "paragraph", text: "three" },
      ],
    });
    expect(store.appends.get(`${WORKSPACE}/${healthy.uuid}`)).toBe(1);

    // So the only place a document write can fail is that one append, and it
    // takes the whole document with it.
    store.failRoom = (room) =>
      room !== `${WORKSPACE}/${healthy.uuid}` &&
      !room.startsWith(`${WORKSPACE}/_`);
    store.failing = true;
    const refused = await rig.call("create_doc", {
      title: "Nothing survives",
      description: "A test document.",
      blocks: [
        { type: "paragraph", text: "one" },
        { type: "paragraph", text: "two" },
      ],
      sidebar: { group: { id: group } },
    });

    expect(refused.payload.error).toBe("persistence_failed");
    expect(refused.payload.applied).toBe(false);
    expect(refused.payload.rolledBack).toBe(false);
    expect(refused.payload.uuid).toBeTruthy();
    expect(refused.payload.completed).toEqual([]);
    expect(refused.payload.failed.purpose).toBe("document");
    expect(refused.payload.failed.room).toBe(
      `${WORKSPACE}/${refused.payload.uuid}`,
    );
    expect(refused.payload.recovery).toContain("create_doc again");

    // `completed: []` is a claim about the log, so a healed restart must find
    // no document, no stub in list_docs and no pin.
    await rig.close();
    rigs.length = 0;
    store.failing = false;
    const restarted = await server(databasePath);
    expect(
      (await restarted.call("get_doc", { uuid: refused.payload.uuid })).isError,
    ).toBe(true);
    const docs = (await restarted.ok("list_docs")).docs;
    expect(docs.some((doc: any) => doc.uuid === refused.payload.uuid)).toBe(
      false,
    );
    expect(shape(await restarted.ok("get_sidebar"))).toEqual([
      ["Start here", ["Anchor"]],
    ]);
  });

  it("keeps the document when the directory refuses, and says so", async () => {
    const databasePath = tempDatabasePath();
    const store = failingStore(databasePath);
    const rig = await server(databasePath, store);
    const group = await groupWith(rig, "Anchor");

    store.failRoom = (room) => room === `${WORKSPACE}/_directory`;
    store.failing = true;
    const refused = await rig.call("create_doc", {
      title: "Undiscoverable",
      description: "A test document.",
      sidebar: { group: { id: group } },
    });

    expect(refused.payload.error).toBe("persistence_failed");
    expect(refused.payload.rolledBack).toBe(false);
    expect(refused.payload.completed).toEqual([
      {
        purpose: "document",
        room: `${WORKSPACE}/${refused.payload.uuid}`,
        applied: true,
      },
    ]);
    expect(refused.payload.failed).toEqual({
      purpose: "directory",
      room: `${WORKSPACE}/_directory`,
    });
    expect(refused.payload.recovery).toContain("get_doc");

    // `completed` is a claim about the log, so the restart must find it there.
    await rig.close();
    rigs.length = 0;
    store.failing = false;
    const restarted = await server(databasePath);
    expect(
      (await restarted.ok("get_doc", { uuid: refused.payload.uuid })).title,
    ).toBe("Undiscoverable");
  });

  it("says the document survived when the group disappears mid-call", async () => {
    const rig = await server();
    const group = await groupWith(rig, "Anchor");

    // The group is deleted between the lookup at the top of create_doc and the
    // sidebar stage: the first directory update of the call is the stub the
    // document stage publishes, which is after the one and before the other.
    const sidebarDoc = rig.instance.replicas.sidebar().doc;
    rig.instance.replicas.directory().doc.once("update", () => {
      deleteGroup(sidebarDoc, group);
    });

    const refused = await rig.call("create_doc", {
      title: "Created, never pinned",
      description: "A test document.",
      sidebar: { group: { id: group } },
    });

    // The placement failed, but two rooms are durable and the answer says so —
    // an agent that read `applied: false` alone would create the document twice.
    expect(refused.isError).toBe(true);
    expect(refused.payload.error).toBe("group_not_found");
    expect(refused.payload.rolledBack).toBe(false);
    expect(
      refused.payload.completed.map((room: any) => room.purpose),
    ).toEqual(["document", "directory"]);
    expect(refused.payload.completed.every((room: any) => room.applied)).toBe(
      true,
    );
    expect(refused.payload.failed).toEqual({
      purpose: "sidebar",
      room: `${WORKSPACE}/_sidebar`,
    });
    expect(refused.payload.recovery).toContain("pin_doc");
    expect(refused.payload.recovery).toContain(refused.payload.uuid);

    // And it is true: the document is there, unpinned, and pin_doc finishes it.
    const uuid = refused.payload.uuid;
    expect((await rig.ok("get_doc", { uuid })).title).toBe(
      "Created, never pinned",
    );
    const listed = (await rig.ok("list_docs")).docs.find(
      (doc: any) => doc.uuid === uuid,
    );
    expect(listed.pinned).toBe(false);
    await rig.ok("pin_doc", { uuid, group: "Later" });
    expect(shape(await rig.ok("get_sidebar"))).toEqual([
      ["Later", ["Created, never pinned"]],
    ]);
  });

  it("leaves a durable document unpinned when the sidebar refuses, and pin_doc finishes it", async () => {
    const databasePath = tempDatabasePath();
    const store = failingStore(databasePath);
    const rig = await server(databasePath, store);
    const group = await groupWith(rig, "Anchor");

    store.failRoom = (room) => room === `${WORKSPACE}/_sidebar`;
    store.failing = true;
    const refused = await rig.call("create_doc", {
      title: "Created but unpinned",
      description: "A test document.",
      sidebar: { group: { id: group } },
    });

    expect(refused.payload.error).toBe("persistence_failed");
    expect(refused.payload.rolledBack).toBe(false);
    expect(
      refused.payload.completed.map((room: any) => room.purpose),
    ).toEqual(["document", "directory"]);
    expect(refused.payload.failed).toEqual({
      purpose: "sidebar",
      room: `${WORKSPACE}/_sidebar`,
    });
    expect(refused.payload.recovery).toContain("pin_doc");

    // The recovery, executed: restart, then finish the placement by hand.
    await rig.close();
    rigs.length = 0;
    store.failing = false;
    const restarted = await server(databasePath);
    const uuid = refused.payload.uuid;
    expect((await restarted.ok("get_doc", { uuid })).title).toBe(
      "Created but unpinned",
    );
    expect(shape(await restarted.ok("get_sidebar"))).toEqual([
      ["Start here", ["Anchor"]],
    ]);
    await restarted.ok("pin_doc", { uuid, group });
    expect(shape(await restarted.ok("get_sidebar"))).toEqual([
      ["Start here", ["Anchor", "Created but unpinned"]],
    ]);
  });
});
