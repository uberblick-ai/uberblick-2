
import { addComment, createAnnotation, getDirectoryMap, getMeta, listAnnotations, roomForDoc, setAnnotationResolved } from "@uberblick/schema";
import type { Hub } from "@uberblick/hub";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupTestResources, hubUrl, LIVE_HUB_SETTLE, peerClient, startHub, startServer, tempDatabasePath, testConfig, TEST_SECRET, waitUntil, WORKSPACE } from "./helpers.js";
import type { PeerClient, Rig } from "./helpers.js";

const rigs: Rig[] = [];
const hubs: Hub[] = [];
const peers: PeerClient[] = [];
afterEach(async () => {
  await cleanupTestResources({
    clients: rigs.splice(0).map((client) => () => client.close()),
    peers: peers.splice(0).map((peer) => () => peer.destroy()),
    hubs: hubs.splice(0).map((hub) => () => hub.stop()),
  });
});

async function localRig(databasePath = tempDatabasePath()): Promise<Rig> {
  const rig = await startServer(testConfig({ databasePath }));
  rigs.push(rig);
  return rig;
}

async function seeded(rig: Rig, title = "Comments", fields: Record<string, unknown> = {}) {
  return rig.ok("create_doc", {
    title, description: "A document with comments.",
    blocks: [{ type: "paragraph", text: "one two three" }], ...fields,
  });
}

async function openThread(rig: Rig, doc: { uuid: string; blocks: { id: string }[] }, start = 0) {
  return rig.ok("annotate", {
    uuid: doc.uuid, block_id: doc.blocks[0]?.id, start, end: start + 3, text: "Question",
  });
}

function forgetCount(rig: Rig, uuid: string): void {
  const directory = getDirectoryMap(rig.instance.replicas.directory().doc);
  const entry = { ...(directory.get(uuid) as Record<string, unknown>) };
  delete entry.openThreadCount;
  directory.set(uuid, entry);
}

async function rows(rig: Rig, fields: Record<string, unknown> = {}): Promise<any[]> {
  return (await rig.ok("list_docs", fields)).docs;
}

describe("open comment threads through directory stubs", () => {

  it("repairs a dropped whole-entry cache on document updates and replay, while archived regular stubs wait for restore", async () => {
    const databasePath = tempDatabasePath();
    const author = await localRig(databasePath);
    const live = await seeded(author, "Live");
    const archived = await seeded(author, "Archived");
    const decision = await seeded(author, "Decision", { kind: "decision" });
    await openThread(author, live);
    await openThread(author, archived);
    await author.ok("archive_doc", { uuid: archived.uuid });
    for (const doc of [live, archived, decision]) forgetCount(author, doc.uuid);
    expect(await rows(author, { has_open_threads: true })).toEqual([]);
    expect((await rows(author, { include_deleted: true })).find(row => row.uuid === live.uuid)).not.toHaveProperty("openThreadCount");
    await author.ok("insert_block", { uuid: live.uuid, type: "paragraph", text: "A later document change" });
    expect(await rows(author, { has_open_threads: true })).toMatchObject([{ uuid: live.uuid, openThreadCount: 1 }]);
    forgetCount(author, live.uuid);
    await author.close();
    rigs.splice(rigs.indexOf(author), 1);

    const restarted = await localRig(databasePath);
    expect(await rows(restarted, { has_open_threads: true })).toMatchObject([{ uuid: live.uuid, openThreadCount: 1 }]);
    expect(await rows(restarted, { kind: "decision" })).toMatchObject([{ uuid: decision.uuid, openThreadCount: 0 }]);
    expect((await rows(restarted, { include_deleted: true })).find(row => row.uuid === archived.uuid)).not.toHaveProperty("openThreadCount");
    await restarted.ok("restore_doc", { uuid: archived.uuid });
    expect((await rows(restarted, { has_open_threads: true })).map(row => [row.uuid, row.openThreadCount]).sort()).toEqual([[live.uuid, 1], [archived.uuid, 1]].sort());
  });

  it("backfills a hydrated peer document and follows peer open, reply, resolve and reopen updates through the hub", async () => {
    const hub = await startHub();
    hubs.push(hub);
    const config = () => testConfig({ authSecret: TEST_SECRET, hubUrl: hubUrl(hub.port), ...LIVE_HUB_SETTLE });
    const author = await startServer(config());
    rigs.push(author);
    const doc = await seeded(author);
    const peer = await peerClient(hub.port, roomForDoc(WORKSPACE, doc.uuid));
    peers.push(peer);
    await waitUntil("the peer to hydrate the document", () => getMeta(peer.doc).uuid === doc.uuid);
    await author.close();
    rigs.splice(rigs.indexOf(author), 1);

    const first = createAnnotation(peer.doc, doc.blocks[0].id, 0, 3, "Peer", "Initial discussion");
    const observer = await startServer(config());
    rigs.push(observer);
    await waitUntil("the fresh MCP replica to hydrate the peer's first thread", async () =>
      (await rows(observer, { has_open_threads: true })).some(row => row.uuid === doc.uuid && row.openThreadCount === 1),
    );
    expect(observer.instance.replicas.hydrated(doc.uuid)).toBe(true);

    const second = createAnnotation(peer.doc, doc.blocks[0].id, 4, 7, "Peer", "Another question");
    await waitUntil("the MCP directory to count the peer's new thread", async () =>
      (await rows(observer))[0]?.openThreadCount === 2,
    );
    addComment(peer.doc, first.id, "Peer", "Reply");
    await waitUntil("the MCP replica to receive the peer's reply", () =>
      listAnnotations(observer.instance.replicas.replica(doc.uuid).doc).find(thread => thread.id === first.id)?.comments.length === 2,
    );
    expect(await rows(observer, { has_open_threads: true })).toMatchObject([{ uuid: doc.uuid, openThreadCount: 2 }]);
    peer.doc.transact(() => {
      setAnnotationResolved(peer.doc, first.id, true);
      setAnnotationResolved(peer.doc, second.id, true);
    });
    await waitUntil("the MCP directory to reflect resolution of the last peer thread", async () =>
      (await rows(observer))[0]?.openThreadCount === 0,
    );
    expect(await rows(observer, { has_open_threads: true })).toEqual([]);
    setAnnotationResolved(peer.doc, first.id, false);
    await waitUntil("the MCP directory to reflect the reopened peer thread", async () =>
      (await rows(observer, { has_open_threads: true }))[0]?.openThreadCount === 1,
    );
  });
});
