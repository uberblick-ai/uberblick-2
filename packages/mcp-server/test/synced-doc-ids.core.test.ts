import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import * as Y from "yjs";
import {
  createGroup,
  createTagCatalogEntry,
  getDirectoryEntry,
  getDirectoryMap,
  getMetaMap,
  initDoc,
  pinDoc,
  setTitle,
} from "@uberblick/schema";
import { startServer, testConfig, WORKSPACE } from "./core-helpers.js";
import type { Rig } from "./core-helpers.js";

const rigs: Rig[] = [];

afterEach(async () => {
  for (const rig of rigs.splice(0)) await rig.close();
  vi.restoreAllMocks();
});

async function local(): Promise<Rig> {
  const rig = await startServer(testConfig());
  rigs.push(rig);
  return rig;
}

it("keeps settlement, refresh and tools available after invalid directory keys arrive", async () => {
  const rig = await local();
  const valid = await rig.ok("create_doc", {
    title: "Uninterrupted orchard",
    description: "A valid document survives malformed synced neighbors.",
  });
  const topic = await rig.ok("create_doc", {
    title: "Can the orchard continue?",
    description: "A valid decision topic survives an invalid record.",
    kind: "decision",
  });
  const directory = rig.instance.replicas.directory();
  const uniqueInvalid = `invalid/${randomUUID()}`;
  const invalid = ["", "x/y", "..", "not-a-uuid", randomUUID().toUpperCase(), uniqueInvalid];
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  const peer = new Y.Doc();
  try {
    for (const uuid of invalid) {
      getDirectoryMap(peer).set(uuid, {
        title: "Crafted orchard record", tags: [], kind: "decision", topic: topic.uuid, status: "open",
      });
    }
    Y.applyUpdate(directory.doc, Y.encodeStateAsUpdate(peer));
  } finally {
    peer.destroy();
  }

  for (let pass = 0; pass < 3; pass += 1) {
    await rig.instance.replicas.settle();
    rig.instance.replicas.refresh();
    await rig.ok("sync_status");
    expect((await rig.ok("get_doc", { uuid: valid.uuid })).title).toBe(valid.title);
    expect((await rig.ok("list_docs")).docs.map((entry: { uuid: string }) => entry.uuid)).toContain(valid.uuid);
    expect((await rig.ok("search", { query: "orchard" })).hits.map((hit: { uuid: string }) => hit.uuid)).toContain(valid.uuid);
    expect((await rig.ok("list_docs", { kind: "decision" })).docs.map((entry: { uuid: string }) => entry.uuid)).toEqual([topic.uuid]);
  }
  const attached = rig.instance.replicas.attachedReplicas().map((replica) => replica.id);
  for (const uuid of invalid) {
    expect(attached).not.toContain(uuid);
    expect(rig.instance.store.hasRoom(`${WORKSPACE}/${uuid}`)).toBe(false);
    expect(rig.instance.store.isIndexed(uuid)).toBe(false);
    expect(getDirectoryMap(directory.doc).get(uuid)).toMatchObject({ title: "Crafted orchard record" });
  }
  expect(warning.mock.calls.filter((args) => JSON.stringify(args).includes(uniqueInvalid))).toHaveLength(1);
});

it("derives every stub and search row from its room identity while retaining the hydration gate", async () => {
  const rig = await local();
  const victim = await rig.ok("create_doc", { title: "Unchanged victim", description: "An independent document." });
  const forged = await rig.ok("create_doc", { title: "Original sender", description: "Metadata identity is untrusted." });
  const replica = rig.instance.replicas.replica(forged.uuid);
  const victimStub = getDirectoryEntry(rig.instance.replicas.directory().doc, victim.uuid);
  replica.doc.transact(() => {
    getMetaMap(replica.doc).set("uuid", victim.uuid);
    setTitle(replica.doc, "Forged plum");
  });
  createTagCatalogEntry(rig.instance.replicas.settings().doc, "identity-replay");
  rig.instance.replicas.rebuildIndex();
  await rig.instance.replicas.settle();
  expect(getDirectoryEntry(rig.instance.replicas.directory().doc, victim.uuid)).toEqual(victimStub);
  expect(getDirectoryEntry(rig.instance.replicas.directory().doc, forged.uuid)?.title).toBe("Forged plum");
  expect((await rig.ok("search", { query: "plum" })).hits).toMatchObject([{ uuid: forged.uuid }]);
  expect((await rig.ok("search", { query: "victim" })).hits).toMatchObject([{ uuid: victim.uuid, title: "Unchanged victim" }]);
  expect((await rig.ok("get_doc", { uuid: forged.uuid })).uuid).toBe(forged.uuid);
  await rig.ok("archive_doc", { uuid: forged.uuid });
  await rig.ok("restore_doc", { uuid: forged.uuid });
  expect(getDirectoryEntry(rig.instance.replicas.directory().doc, victim.uuid)).toEqual(victimStub);

  const emptyUuid = randomUUID();
  const empty = rig.instance.replicas.replica(emptyUuid);
  getMetaMap(empty.doc).set("title", "Unhydrated quince");
  expect(rig.instance.replicas.hydrated(emptyUuid)).toBe(false);
  expect(getDirectoryEntry(rig.instance.replicas.directory().doc, emptyUuid)).toBeNull();
  expect(rig.instance.store.isIndexed(emptyUuid)).toBe(false);
  initDoc(empty.doc, { uuid: "x/y", title: "Hydrated quince" });
  expect(rig.instance.replicas.hydrated(emptyUuid)).toBe(true);
  expect(getDirectoryEntry(rig.instance.replicas.directory().doc, "x/y")).toBeNull();
  expect(getDirectoryEntry(rig.instance.replicas.directory().doc, emptyUuid)?.title).toBe("Hydrated quince");
});

it("filters invalid sidebar and curated references while resolving uppercase tool arguments", async () => {
  const rig = await local();
  const page = await rig.ok("create_doc", { title: "Canonical pear", description: "A canonical tool target." });
  const other = await rig.ok("create_doc", { title: "Curated pear", description: "A curated target." });
  const sidebar = rig.instance.replicas.sidebar().doc;
  const group = createGroup(sidebar, "Fruit");
  pinDoc(sidebar, group, page.uuid);
  sidebar.getArray(`pins:${group}`).push([{ uuid: "..", since: 0 }, { uuid: null, since: 0 }]);
  getMetaMap(rig.instance.replicas.replica(page.uuid).doc).set("links", ["..", null, other.uuid.toUpperCase(), other.uuid]);
  expect((await rig.ok("get_sidebar")).groups.find((entry: { id: string }) => entry.id === group).docs).toEqual([
    { uuid: page.uuid, title: "Canonical pear", status: "ok" },
  ]);
  expect((await rig.ok("get_doc", { uuid: page.uuid.toUpperCase() })).links).toEqual([other.uuid]);
  await rig.ok("set_metadata", { uuid: page.uuid.toUpperCase(), title: "Canonical pear revised", links: [other.uuid.toUpperCase()] });
  expect((await rig.ok("get_doc", { uuid: page.uuid })).title).toBe("Canonical pear revised");
  const decision = await rig.ok("create_doc", {
    title: "Should pears stay?", description: "Uppercase related and discussion arguments identify existing rooms.",
    kind: "decision", related: page.uuid.toUpperCase(), discussion: other.uuid.toUpperCase(),
  });
  expect((await rig.ok("get_doc", { uuid: decision.uuid }))).toMatchObject({ related: [page.uuid], discussion: other.uuid });
  await rig.ok("set_metadata", { uuid: decision.uuid.toUpperCase(), discussion: page.uuid.toUpperCase() });
  await rig.ok("pin_doc", { uuid: other.uuid.toUpperCase(), group });
  await rig.ok("unpin_doc", { uuid: other.uuid.toUpperCase() });
  expect(rig.instance.replicas.attachedReplicas().map((replica) => replica.id)).not.toContain(page.uuid.toUpperCase());
  expect(rig.instance.replicas.attachedReplicas().map((replica) => replica.id)).not.toContain(other.uuid.toUpperCase());
});
