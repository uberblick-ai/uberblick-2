/**
 * Directory reconciliation after a partial cross-room write (#81).
 *
 * A document and the workspace directory are two rooms with two persistence
 * paths that cannot commit together, so every write touching both has partial
 * outcomes. The contract is that each one lands on a named, observable result
 * rather than on "it depends", and the six results are the issue's table — one
 * test below per row, in the order the table states them:
 *
 * 1. create, stub landed, document room did not — the stub stays, `list_docs`
 *    lists it, and `get_doc` answers `doc_not_hydrated` with `inDirectory:
 *    true` rather than serving an empty document as content;
 * 2. create, document landed, stub did not — the next settle republishes the
 *    stub from `meta`, republishing a stub and never re-inserting blocks;
 * 3. rename, document landed, stub stale — `meta.title` wins, and discovery
 *    converges on the document's title rather than the reverse;
 * 4. rename, stub landed, document did not — the stub is a cache that ran
 *    ahead: where the document is held its own title wins, where it is not the
 *    cached title shows and the replica says it is not hydrated;
 * 5. archive, tombstone landed, document write did not — tombstones are
 *    sticky, the document stays readable, nothing clears it implicitly;
 * 6. repair originating on the other client — both converge on one repaired
 *    set: no second stub, no duplicated blocks, no resurrected tombstone.
 *
 * The injection is real in both directions. A dropped *directory* write is
 * `FailingStore` refusing that room's append — the only layer where a partial
 * persistence can actually happen. A dropped *document* write is a directory
 * entry for a room whose log is empty, which is precisely what another
 * replica's create or rename delivers when its document room does not follow;
 * there is nothing else to fake, because a room that never arrived is a room
 * with nothing in it. Every row restarts the client, because the contract is
 * about what survives rather than what a live process happens to remember.
 *
 * A stub whose room never arrives stays dangling by design. That residual is
 * asserted here (row 1) as a result, not treated as a defect.
 *
 * Deliberately not re-tested here, because they are owned elsewhere:
 * `create_doc`'s own answer when a room refuses — `completed`, `failed`,
 * `recovery` — is `create-placement.test.ts`; the sticky fail-stop itself is
 * `durability.test.ts`; tombstone stickiness at the schema level is
 * `packages/schema/test/directory.test.ts`, and restore republishing metadata
 * that changed while archived is `archive.test.ts`.
 */

import { randomUUID } from "node:crypto";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  getDirectoryEntry,
  getMeta,
  listDirectory,
  setTitle,
  upsertDirectoryEntry,
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
import { MirrorStore } from "../src/store.js";

const rigs: Rig[] = [];
const stores: MirrorStore[] = [];
const hubs: Hub[] = [];
const peers: PeerClient[] = [];

const DESCRIPTION = "A test document.";

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

/** Close one rig without disturbing the others the cleanup still owns. */
async function stop(rig: Rig): Promise<void> {
  const at = rigs.indexOf(rig);
  if (at !== -1) rigs.splice(at, 1);
  await rig.close();
}

function failingStore(databasePath: string): FailingStore {
  const store = new FailingStore(databasePath, WORKSPACE);
  stores.push(store);
  return store;
}

async function hub(): Promise<Hub> {
  const started = await startHub();
  hubs.push(started);
  return started;
}

async function peer(port: number, room: string): Promise<PeerClient> {
  const client = await peerClient(port, room);
  peers.push(client);
  return client;
}

/** A room as the log alone has it: no server, no repair, no live memory. */
function fromLog(databasePath: string, room: string): Y.Doc {
  const store = new MirrorStore(databasePath, WORKSPACE);
  stores.push(store);
  const doc = new Y.Doc();
  const slice = store.readSince(room, 0);
  if (slice.snapshot !== null) {
    Y.applyUpdate(doc, slice.snapshot.state);
  }
  for (const entry of slice.updates) {
    Y.applyUpdate(doc, entry.payload);
  }
  return doc;
}

/** The directory replica this server answers `list_docs` from. */
function directoryOf(rig: Rig): Y.Doc {
  return rig.instance.replicas.directory().doc;
}

/** The stub a listing shows for one uuid, or undefined when there is none. */
async function listed(rig: Rig, uuid: string): Promise<any> {
  const docs = (await rig.ok("list_docs")).docs;
  return docs.find((entry: any) => entry.uuid === uuid);
}

async function blockTexts(rig: Rig, uuid: string): Promise<string[]> {
  const read = await rig.ok("get_doc", { uuid });
  return read.blocks.map((block: any) => block.text);
}

/** The directory write another replica delivers when its document never does. */
function stubOnly(
  rig: Rig,
  uuid: string,
  title: string,
  tags: string[] = [],
): void {
  upsertDirectoryEntry(directoryOf(rig), {
    uuid,
    title,
    tags,
    description: DESCRIPTION,
    createdAt: Date.now(),
  });
}

afterEach(async () => {
  for (const client of peers.splice(0)) client.destroy();
  for (const rig of rigs.splice(0)) await rig.close();
  for (const store of stores.splice(0)) store.close();
  for (const started of hubs.splice(0)) await started.stop().catch(() => {});
});

afterAll(removeTempDirs);

describe("a create that only half landed", () => {
  it("row 1 — keeps a stub whose document room never arrived, and never answers with an empty document", async () => {
    const databasePath = tempDatabasePath();
    const rig = await server(databasePath);
    const uuid = randomUUID();

    // The other replica's create, half delivered: the directory write is here
    // and the document room's is not. A room that has not arrived is
    // indistinguishable from one still in flight, so nothing may guess it away.
    stubOnly(rig, uuid, "Never arrived", ["reference"]);

    expect((await listed(rig, uuid)).title).toBe("Never arrived");

    const refused = await rig.call("get_doc", { uuid });
    expect(refused.isError).toBe(true);
    expect(refused.payload.error).toBe("doc_not_hydrated");
    expect(refused.payload.inDirectory).toBe(true);
    expect(refused.payload.hub.status).toBe("disabled");
    // Not "here is an empty document": no blocks, no title, no content at all.
    expect(refused.payload.blocks).toBeUndefined();

    // Restarting is where a cleanup would happen if one existed. It does not:
    // the stub is in the log, it comes back, and it still refuses to be read.
    await stop(rig);
    const restarted = await server(databasePath);
    expect((await listed(restarted, uuid)).title).toBe("Never arrived");
    const again = await restarted.call("get_doc", { uuid });
    expect(again.payload.error).toBe("doc_not_hydrated");
    expect(again.payload.inDirectory).toBe(true);
    // Dangling, and reported as such rather than half-invented: it is in the
    // listing, and in nothing that claims to be content.
    expect((await restarted.ok("search", { query: "arrived" })).hits).toEqual(
      [],
    );
  });

  it("row 2 — republishes a stub the log refused, from the document's own metadata", async () => {
    const databasePath = tempDatabasePath();
    const store = failingStore(databasePath);
    const rig = await server(databasePath, store);

    store.failRoom = (room) => room === `${WORKSPACE}/_directory`;
    store.failing = true;
    const refused = await rig.call("create_doc", {
      title: "Undiscoverable",
      description: DESCRIPTION,
      blocks: [
        { type: "paragraph", text: "one" },
        { type: "paragraph", text: "two" },
      ],
    });
    expect(refused.payload.error).toBe("persistence_failed");
    const uuid = refused.payload.uuid;

    // On disk: the document's room, and a directory that never heard of it.
    await stop(rig);
    store.failing = false;
    expect(
      getDirectoryEntry(fromLog(databasePath, `${WORKSPACE}/_directory`), uuid),
    ).toBeNull();

    // The repair rides the restart: the replica holds the document, so the next
    // settle republishes its stub from `meta` — under the document's own title.
    const restarted = await server(databasePath);
    expect((await listed(restarted, uuid)).title).toBe("Undiscoverable");
    expect((await listed(restarted, uuid)).description).toBe(DESCRIPTION);
    // A repair republishes a stub. It never re-inserts blocks.
    expect(await blockTexts(restarted, uuid)).toEqual(["one", "two"]);
    expect(
      listDirectory(directoryOf(restarted)).filter(
        (entry) => entry.uuid === uuid,
      ),
    ).toHaveLength(1);

    // And it is idempotent: with the stub already true to the document, further
    // settles write nothing to the directory at all.
    let directoryUpdates = 0;
    directoryOf(restarted).on("update", () => {
      directoryUpdates += 1;
    });
    await restarted.ok("list_docs");
    await restarted.ok("get_doc", { uuid });
    await restarted.ok("search", { query: "Undiscoverable" });
    expect(directoryUpdates).toBe(0);
  });
});

describe("a lifecycle update that only half landed", () => {
  it("names the durable document room and repairs its stale stub after restart", async () => {
    const databasePath = tempDatabasePath();
    const store = failingStore(databasePath);
    const rig = await server(databasePath, store);
    const created = await rig.ok("create_doc", {
      title: "Adopted requirement",
      description: DESCRIPTION,
    });

    store.failRoom = (room) => room === `${WORKSPACE}/_directory`;
    store.failing = true;
    const refused = await rig.call("set_status", {
      uuid: created.uuid,
      status: "planned",
    });
    expect(refused.payload).toMatchObject({
      error: "persistence_failed",
      uuid: created.uuid,
      kind: "requirement",
      status: "planned",
      applied: false,
      partial: true,
      synced: false,
      rolledBack: false,
      completed: [
        {
          purpose: "document",
          room: `${WORKSPACE}/${created.uuid}`,
          applied: true,
        },
      ],
      failed: { purpose: "directory", room: `${WORKSPACE}/_directory` },
    });
    expect(refused.payload.recovery).toContain("do not repeat set_status");

    await stop(rig);
    store.failing = false;
    expect(
      getMeta(fromLog(databasePath, `${WORKSPACE}/${created.uuid}`)),
    ).toMatchObject({ kind: "requirement", status: "planned" });
    expect(
      getDirectoryEntry(
        fromLog(databasePath, `${WORKSPACE}/_directory`),
        created.uuid,
      ),
    ).not.toHaveProperty("kind");

    const restarted = await server(databasePath);
    expect(await listed(restarted, created.uuid)).toMatchObject({
      kind: "requirement",
      status: "planned",
    });
    expect(await restarted.ok("get_doc", { uuid: created.uuid })).toMatchObject({
      kind: "requirement",
      status: "planned",
    });
  });
});

describe("a rename that only half landed", () => {
  it("row 3 — repairs a stale stub from the document, never the document from the stub", async () => {
    const databasePath = tempDatabasePath();
    const store = failingStore(databasePath);
    const rig = await server(databasePath, store);
    const created = await rig.ok("create_doc", {
      title: "Old name",
      description: DESCRIPTION,
      blocks: [{ type: "paragraph", text: "unchanged by a rename" }],
    });

    store.failRoom = (room) => room === `${WORKSPACE}/_directory`;
    store.failing = true;
    const refused = await rig.call("set_title", {
      uuid: created.uuid,
      title: "New name",
    });
    expect(refused.payload.error).toBe("persistence_failed");
    expect(refused.payload.room).toBe(`${WORKSPACE}/_directory`);

    // The partial outcome, as the log has it: the document renamed, the stub
    // still caching the name it was created with.
    await stop(rig);
    store.failing = false;
    const stub = getDirectoryEntry(
      fromLog(databasePath, `${WORKSPACE}/_directory`),
      created.uuid,
    );
    expect(stub?.title).toBe("Old name");

    // `meta.title` is authoritative, so everything discovery answers with
    // converges on the document's title — and the document is left alone.
    const restarted = await server(databasePath);
    expect((await listed(restarted, created.uuid)).title).toBe("New name");
    expect((await restarted.ok("get_doc", { uuid: created.uuid })).title).toBe(
      "New name",
    );
    expect(
      (await restarted.ok("search", { query: "New name" })).hits.map(
        (hit: any) => hit.uuid,
      ),
    ).toEqual([created.uuid]);
    expect(await blockTexts(restarted, created.uuid)).toEqual([
      "unchanged by a rename",
    ]);
  });

  it("row 4 — treats a stub that ran ahead as the cache it is", async () => {
    const databasePath = tempDatabasePath();
    const rig = await server(databasePath);
    const created = await rig.ok("create_doc", {
      title: "Old name",
      description: DESCRIPTION,
      blocks: [{ type: "paragraph", text: "the document as it stands" }],
    });

    // Half a rename from elsewhere: a stub for a document this replica does not
    // hold at all.
    const absent = randomUUID();
    stubOnly(rig, absent, "Renamed elsewhere");

    // Not held here: the cached title is what a listing can honestly show, and
    // the read says the document has not arrived rather than implying the
    // rename applied to something.
    expect((await listed(rig, absent)).title).toBe("Renamed elsewhere");
    const refused = await rig.call("get_doc", { uuid: absent });
    expect(refused.payload.error).toBe("doc_not_hydrated");
    expect(refused.payload.inDirectory).toBe(true);

    // And the same half-rename for a document this replica does hold. Written
    // here, after the calls above, on purpose: repair rides *document* updates,
    // and a settle replays a document's own unpolled log tail as one — so a
    // stub written before this replica had caught up with its own log would be
    // repaired by the next settle and the window below would never exist. This
    // replica is caught up, so nothing but a write to the document can heal it.
    stubOnly(rig, created.uuid, "Renamed elsewhere too");

    // Held here: the document's own title wins every answer that can ask it —
    // the read, and `titleFor` in the answers built from the stub.
    expect((await rig.ok("get_doc", { uuid: created.uuid })).title).toBe(
      "Old name",
    );

    // The listing meanwhile answers from the cache, which is what a cache is.
    expect((await listed(rig, created.uuid)).title).toBe(
      "Renamed elsewhere too",
    );

    // The next write to the document is what heals it — the "repaired on write"
    // half of the rule, in that direction only.
    await rig.ok("set_description", {
      uuid: created.uuid,
      description: "Described after the stub ran ahead.",
    });
    expect((await listed(rig, created.uuid)).title).toBe("Old name");

    await stop(rig);
    const restarted = await server(databasePath);
    expect((await listed(restarted, created.uuid)).title).toBe("Old name");
    expect((await listed(restarted, absent)).title).toBe("Renamed elsewhere");
    expect(
      (await restarted.call("get_doc", { uuid: absent })).payload.error,
    ).toBe("doc_not_hydrated");
    // `titleFor`: an answer about a document this replica holds states the
    // document's title, not whatever a stub was last written with.
    expect(
      (await restarted.ok("archive_doc", { uuid: created.uuid })).title,
    ).toBe("Old name");
  });
});

describe("an archive whose document write never happened", () => {
  it("row 5 — keeps the tombstone sticky, the document readable, and clears nothing", async () => {
    const databasePath = tempDatabasePath();
    const rig = await server(databasePath);
    const created = await rig.ok("create_doc", {
      title: "Retired protocol",
      description: DESCRIPTION,
      blocks: [{ type: "paragraph", text: "still every byte of it" }],
    });
    await rig.ok("archive_doc", { uuid: created.uuid });

    // Archiving writes the directory and nothing else, so the document's room
    // is untouched by construction. What could clear the tombstone by accident
    // is a document update from a replica that has not seen it — stub repair
    // rides document updates. It does not clear it.
    setTitle(
      rig.instance.replicas.replica(created.uuid).doc,
      "Renamed while archived",
    );

    await stop(rig);
    const restarted = await server(databasePath);

    expect(await listed(restarted, created.uuid)).toBeUndefined();
    const withDeleted = (
      await restarted.ok("list_docs", { include_deleted: true })
    ).docs.find((entry: any) => entry.uuid === created.uuid);
    expect(withDeleted.deleted).toBe(true);
    // The stub never followed the rename either: repair stops at a tombstone,
    // and `restore_doc` is what trues it up (archive.test.ts).
    expect(withDeleted.title).toBe("Retired protocol");

    // Readable by uuid, whole, tombstone and all.
    const read = await restarted.ok("get_doc", { uuid: created.uuid });
    expect(read.title).toBe("Renamed while archived");
    expect(read.blocks.map((block: any) => block.text)).toEqual([
      "still every byte of it",
    ]);
    expect(
      getDirectoryEntry(directoryOf(restarted), created.uuid)?.deleted,
    ).toBe(true);
  });
});

describe("a repair that originated on the other client", () => {
  it("row 6 — converges on one repaired set, with no second stub and no resurrected tombstone", async () => {
    const started = await hub();

    // The other client: its document room is durable and its directory write
    // was refused, so nothing in the workspace can discover what it created.
    const otherPath = tempDatabasePath();
    const otherStore = failingStore(otherPath);
    const failed = await server(otherPath, otherStore, started.port);
    otherStore.failRoom = (room) => room === `${WORKSPACE}/_directory`;
    otherStore.failing = true;
    const refused = await failed.call("create_doc", {
      title: "Repaired elsewhere",
      description: DESCRIPTION,
      blocks: [
        { type: "paragraph", text: "one" },
        { type: "paragraph", text: "two" },
      ],
    });
    expect(refused.payload.error).toBe("persistence_failed");
    const uuid = refused.payload.uuid;
    await stop(failed);
    otherStore.failing = false;

    // It restarts and repairs its own stub, and this replica — which never held
    // the document — learns of both through the hub.
    const other = await server(otherPath, undefined, started.port);
    const here = await server(tempDatabasePath(), undefined, started.port);
    const browser = await peer(started.port, `${WORKSPACE}/_directory`);
    await browser.synced;

    await waitUntil("the repair to reach the other replica", async () =>
      (await listed(here, uuid)) !== undefined,
    );
    expect((await listed(here, uuid)).title).toBe("Repaired elsewhere");
    // One stub, not two: a repair states the entry, it does not append one.
    expect(
      listDirectory(directoryOf(here)).filter((entry) => entry.uuid === uuid),
    ).toHaveLength(1);
    await waitUntil("the document itself to reach it", async () =>
      !(await here.call("get_doc", { uuid })).isError,
    );
    // And no duplicated blocks anywhere, on either side of the repair.
    expect(await blockTexts(here, uuid)).toEqual(["one", "two"]);
    expect(await blockTexts(other, uuid)).toEqual(["one", "two"]);

    // The same repaired set on both replicas and in the directory room a
    // browser holds.
    const uuids = async (rig: Rig): Promise<string[]> =>
      (await rig.ok("list_docs")).docs.map((entry: any) => entry.uuid).sort();
    expect(await uuids(here)).toEqual(await uuids(other));
    await waitUntil("the browser's directory to agree", () =>
      listDirectory(browser.doc).some((entry) => entry.uuid === uuid),
    );
    expect(
      listDirectory(browser.doc).filter((entry) => entry.uuid === uuid),
    ).toHaveLength(1);

    // Now archive it here, and let the other client go on repairing once it has
    // the tombstone: no resurrection by a repairer that has seen it. Repair by
    // a replica that has NOT seen it is deliberately outside this claim — two
    // concurrent whole-entry writes to one directory key are last-write-wins by
    // Yjs' own ordering, which `ARCHIVE_IS_LAST_WRITE_WINS` in `../src/tools.ts`
    // states to agents, so there is nothing here to assert either way.
    await here.ok("archive_doc", { uuid });
    await waitUntil("the tombstone to reach the other client", () =>
      getDirectoryEntry(directoryOf(other), uuid)?.deleted === true,
    );
    setTitle(
      other.instance.replicas.replica(uuid).doc,
      "Renamed on the other client",
    );
    await waitUntil("its rename to come back the other way", async () => {
      const read = await here.call("get_doc", { uuid });
      return read.payload.title === "Renamed on the other client";
    });

    expect(await listed(here, uuid)).toBeUndefined();
    expect(await listed(other, uuid)).toBeUndefined();
    expect(getDirectoryEntry(directoryOf(here), uuid)?.deleted).toBe(true);
    expect(getDirectoryEntry(directoryOf(other), uuid)?.deleted).toBe(true);
    // The browser holds the directory over its own socket, so it gets its own
    // wait rather than borrowing the timing of the two servers' waits.
    await waitUntil("the tombstone to stand in the browser's directory", () =>
      getDirectoryEntry(browser.doc, uuid)?.deleted === true,
    );
  });
});
