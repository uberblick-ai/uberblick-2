/**
 * `create_doc`'s optional sidebar placement: one call, up to three rooms, and
 * no claim the rooms cannot back.
 *
 * The rooms persist independently: placement is expressed once, in
 * an input that cannot say two contradictory things; an unknown group fails
 * having created nothing; and a create that gets part-way says which rooms are
 * durable, which one refused, that nothing was rolled back, and what to do
 * about it. The sidebar's own convergence rules belong to the schema package,
 * and pin_doc's public behaviour to `sidebar.test.ts` — neither is retested
 * here.
 */

import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { deleteGroup } from "@uberblick/schema";

import { cleanupTestResources, FailingStore, startServer, testConfig, WORKSPACE } from "./core-helpers.js";
import type { Rig } from "./core-helpers.js";
import type { MirrorStore, UpdateOrigin } from "../src/store.js";

const rigs: Rig[] = [];
const stores: MirrorStore[] = [];

async function server(
  databasePath = ":memory:",
  store?: MirrorStore,
): Promise<Rig> {
  const rig = await startServer(
    testConfig({ databasePath }),
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
  await cleanupTestResources({
    clients: rigs.splice(0).map((client) => () => client.close()),
    after: [...stores.splice(0).map((store) => () => store.close())],
  });
});

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

describe("a create that gets part-way", () => {

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

  it("never writes the related page room", async () => {
    const databasePath = ":memory:";
    const store = failingStore(databasePath);
    const rig = await server(databasePath, store);
    const page = await rig.ok("create_doc", {
      title: "Page", description: "Its log is derived without a write.",
    });
    const pageRoom = `${WORKSPACE}/${page.uuid}`;
    const before = store.appends.get(pageRoom);
    store.failRoom = room => room === pageRoom;
    store.failing = true;
    const decision = await rig.ok("create_doc", {
      title: "Own metadata", description: "Stores its related page itself.",
      kind: "decision", related: page.uuid,
    });
    expect(store.appends.get(pageRoom)).toBe(before);
    expect(decision.rooms.map((room: any) => room.purpose)).toEqual(["document", "directory"]);
    expect((await rig.ok("get_doc", { uuid: page.uuid })).decisions).toMatchObject([{ topic: decision.uuid }]);
  });
});
