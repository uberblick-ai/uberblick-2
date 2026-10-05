/**
 * What the hub adds, and what it is not allowed to take away.
 *
 * Every test here runs a real hub on an ephemeral port and a real second client
 * (a plain `HocuspocusProvider`, standing in for the web UI), because the
 * interesting claims are about the wire: an offline-created document reaching
 * the hub once it comes up, a fresh replica learning a whole corpus, and remote
 * updates landing in the log like any other.
 */

import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  appendBlock,
  getBlocks,
  getMeta,
  initDoc,
  listDirectory,
  roomForDoc,
  setTldr,
  upsertDirectoryEntry,
} from "@uberblick/schema";
import type { Hub, HubLogRecord } from "@uberblick/hub";
import { SYNC_PROTOCOL_VERSION } from "@uberblick/hub/protocol";
import * as Y from "yjs";
import { MirrorStore } from "../src/store.js";
import {
  hubUrl,
  LIVE_HUB_SETTLE,
  peerClient,
  removeTempDirs,
  sleep,
  startHub,
  startServer,
  tempDatabasePath,
  testConfig,
  TEST_SECRET,
  waitForCorpus,
  waitUntil,
  WORKSPACE,
} from "./helpers.js";
import type { HubOptions, PeerClient, Rig, TestConfigOptions } from "./helpers.js";

const hubs: Hub[] = [];
const rigs: Rig[] = [];
const peers: PeerClient[] = [];

class FirstHydrationFailureStore extends MirrorStore {
  private failRoom: string | null = null;

  failNextRead(room: string): void {
    this.failRoom = room;
  }

  override readSince(room: string, afterSeq: number) {
    if (this.failRoom === room) {
      this.failRoom = null;
      throw Object.assign(new Error("simulated busy first hydration"), {
        errcode: 5,
      });
    }
    return super.readSince(room, afterSeq);
  }
}

function encodedDoc(uuid: string, title: string): Uint8Array {
  const doc = new Y.Doc();
  initDoc(doc, { uuid, title, description: "A test document." });
  const update = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return update;
}

afterEach(async () => {
  for (const peer of peers.splice(0)) {
    peer.destroy();
  }
  for (const rig of rigs.splice(0)) {
    await rig.close();
  }
  for (const hub of hubs.splice(0)) {
    await hub.stop().catch(() => {});
  }
  removeTempDirs();
});

async function hub(options: HubOptions = {}) {
  const started = await startHub(options);
  hubs.push(started);
  return started;
}

async function serverOn(
  port: number,
  options: Omit<TestConfigOptions, "hubUrl"> = {},
): Promise<Rig> {
  const rig = await startServer(
    testConfig({
      ...options,
      authSecret: options.authSecret ?? TEST_SECRET,
      hubUrl: hubUrl(port),
    }),
  );
  rigs.push(rig);
  return rig;
}

async function peer(port: number, room: string): Promise<PeerClient> {
  const client = await peerClient(port, room);
  peers.push(client);
  return client;
}

/** Wait until the server reports everything it holds has reached the hub. */
async function waitForQuiet(rig: Rig): Promise<void> {
  await waitUntil("the server to report itself in sync", async () => {
    const status = await rig.ok("sync_status", {});
    return (
      status.hub.status === "connected" &&
      status.unsyncedChanges === 0 &&
      status.pendingRooms.length === 0
    );
  });
}

describe("hub sync", () => {
  it("retries a room whose first log hydration failed", async () => {
    const running = await hub();
    const databasePath = tempDatabasePath();
    const store = new FirstHydrationFailureStore(databasePath, WORKSPACE);
    const rig = await startServer(
      testConfig({
        databasePath,
        authSecret: TEST_SECRET,
        hubUrl: hubUrl(running.port),
        ...LIVE_HUB_SETTLE,
      }),
      store,
    );
    rigs.push(rig);

    const directUuid = randomUUID();
    const directRoom = roomForDoc(WORKSPACE, directUuid);
    store.appendUpdate(directRoom, encodedDoc(directUuid, "Direct retry"), "remote");
    store.failNextRead(directRoom);

    expect(() => rig.instance.replicas.replica(directUuid)).toThrow(
      "simulated busy first hydration",
    );
    expect(rig.instance.replicas.known(directUuid)).toBe(false);
    expect(
      rig.instance.replicas
        .attachedReplicas()
        .some((replica) => replica.room === directRoom),
    ).toBe(false);

    const recovered = rig.instance.replicas.replica(directUuid);
    expect(getMeta(recovered.doc).title).toBe("Direct retry");
    upsertDirectoryEntry(rig.instance.replicas.directory().doc, {
      uuid: directUuid,
      title: "Direct retry",
    });
    const written = await rig.ok("set_title", {
      uuid: directUuid,
      title: "Acknowledged after retry",
    });
    expect(written.applied).toBe(true);
    await waitUntil("the retried room's write to be acknowledged", async () => {
      const status = await rig.ok("sync_status", {});
      return status.rooms.some(
        (entry: { room: string; synced: boolean }) =>
          entry.room === directRoom && entry.synced,
      );
    });
    const observer = await peer(running.port, directRoom);
    await waitUntil("a second client to receive the retried room's write", () =>
      getMeta(observer.doc).title === "Acknowledged after retry",
    );

    const discoveredUuid = randomUUID();
    const discoveredRoom = roomForDoc(WORKSPACE, discoveredUuid);
    store.appendUpdate(
      discoveredRoom,
      encodedDoc(discoveredUuid, "Directory retry"),
      "remote",
    );
    upsertDirectoryEntry(rig.instance.replicas.directory().doc, {
      uuid: discoveredUuid,
      title: "Directory retry",
    });
    store.failNextRead(discoveredRoom);

    const failedSettle = await rig.call("list_docs", {});
    expect(failedSettle.isError).toBe(true);
    expect(failedSettle.payload.error).toBe("internal_error");
    expect(rig.instance.replicas.known(discoveredUuid)).toBe(false);

    await rig.ok("list_docs", {});
    expect(rig.instance.replicas.hydrated(discoveredUuid)).toBe(true);
    expect(
      rig.instance.replicas
        .attachedReplicas()
        .filter((replica) => replica.room === `${WORKSPACE}/_directory`),
    ).toHaveLength(1);
  });

  it("drains a pending legacy feedback room, then leaves its residue inert", async () => {
    const running = await hub();
    const databasePath = tempDatabasePath();
    const legacyRoom = `${WORKSPACE}/_feedback`;
    const legacy = new Y.Doc();
    legacy.getArray("events").push([{ legacy: true }]);
    const seeded = new MirrorStore(databasePath, WORKSPACE);
    seeded.appendUpdate(legacyRoom, Y.encodeStateAsUpdate(legacy), "local");
    seeded.close();
    legacy.destroy();

    const draining = await serverOn(running.port, { databasePath });
    await waitForQuiet(draining);
    expect(
      (await draining.ok("sync_status", {})).rooms.map(
        (entry: { room: string }) => entry.room,
      ),
    ).toEqual([
      `${WORKSPACE}/_directory`,
      `${WORKSPACE}/_sidebar`,
      `${WORKSPACE}/_settings`,
      legacyRoom,
    ]);

    await draining.close();
    rigs.splice(rigs.indexOf(draining), 1);

    const restarted = await serverOn(running.port, { databasePath });
    const hubCopy = await peer(running.port, legacyRoom);
    await waitUntil("the hub to retain the legacy feedback update", () =>
      hubCopy.doc.getArray("events").length === 1,
    );
    const status = await restarted.ok("sync_status", {});
    expect(restarted.instance.store.hasRoom(legacyRoom)).toBe(true);
    expect(status.pendingRooms).toEqual([]);
    expect(
      status.rooms.map((entry: { room: string }) => entry.room),
    ).toEqual([
      `${WORKSPACE}/_directory`,
      `${WORKSPACE}/_sidebar`,
      `${WORKSPACE}/_settings`,
    ]);
  });

  it("delivers a document created while the hub was down", async () => {
    // Take a port, then give it back: the server dials an address that will
    // only start answering later.
    const hubDatabase = tempDatabasePath();
    const first = await startHub({ databasePath: hubDatabase });
    const port = first.port;
    await first.stop();

    const rig = await serverOn(port);
    const created = await rig.ok("create_doc", {
      title: "Created offline",
      description: "A test document.",
      blocks: [{ type: "paragraph", text: "no hub was involved" }],
    });
    expect(created.synced).toBe(false);

    const offline = await rig.ok("sync_status", {});
    expect(offline.hub.status).toBe("hub-down");
    expect(
      (offline.pendingRooms as { room: string }[]).map((entry) => entry.room),
    ).toContain(`${WORKSPACE}/${created.uuid}`);

    // The hub comes up on the same address.
    const started = await hub({ port, databasePath: hubDatabase });
    expect(started.port).toBe(port);

    const docPeer = await peer(port, `${WORKSPACE}/${created.uuid}`);
    await waitUntil("the offline-created document to reach a second client", () => {
      return getMeta(docPeer.doc).title === "Created offline";
    });
    expect(getBlocks(docPeer.doc).map((block) => block.text)).toEqual([
      "no hub was involved",
    ]);

    // Discovery travels the same way, so the doc is findable, not just present.
    const directoryPeer = await peer(port, `${WORKSPACE}/_directory`);
    await waitUntil("the directory stub to reach a second client", () =>
      listDirectory(directoryPeer.doc).some(
        (entry) => entry.uuid === created.uuid,
      ),
    );

    await waitForQuiet(rig);
    const synced = await rig.ok("sync_status", {});
    expect(synced.hub.status).toBe("connected");
    expect(synced.pendingRooms).toEqual([]);
  });

  it("lets a fresh replica enumerate and search a corpus it has never seen", async () => {
    const running = await hub();
    const author = await serverOn(running.port);

    const first = await author.ok("create_doc", {
      title: "Alpha",
      description: "A test document.",
      tags: ["auth"],
      blocks: [{ type: "paragraph", text: "the quick brown capybara" }],
    });
    const second = await author.ok("create_doc", {
      title: "Beta",
      description: "A test document.",
      blocks: [{ type: "paragraph", text: "an entirely different marmot" }],
    });
    await waitForQuiet(author);

    // Empty local state, same hub. Everything it knows, it learns by syncing —
    // and everything it learns, it logs.
    //
    // Both halves are needed, and they cover different things. LIVE_HUB_SETTLE
    // gives the settle room to finish, which is what fills the FTS index the
    // search assertions below read; waiting for the directory is what makes an
    // empty listing mean a real bug rather than a settle that gave up. Neither
    // is the other's belt and braces — starve the sync grace and the searches
    // go red with the directory in hand.
    const fresh = await serverOn(running.port, {
      databasePath: tempDatabasePath(),
      ...LIVE_HUB_SETTLE,
    });
    await waitForCorpus(fresh, [first.uuid, second.uuid]);

    const listed = await fresh.ok("list_docs", {});
    expect(
      listed.docs.map((doc: { uuid: string }) => doc.uuid).sort(),
    ).toEqual([first.uuid, second.uuid].sort());

    expect(
      (await fresh.ok("search", { query: "capybara" })).hits.map(
        (hit: { uuid: string }) => hit.uuid,
      ),
    ).toEqual([first.uuid]);
    expect(
      (await fresh.ok("search", { query: "marmot" })).hits.map(
        (hit: { uuid: string }) => hit.uuid,
      ),
    ).toEqual([second.uuid]);

    // Hydration went through the log, so a restart with the hub gone still has
    // the corpus.
    const room = `${WORKSPACE}/${first.uuid}`;
    expect(
      fresh.instance.store.updatesAfter(room, 0).length,
    ).toBeGreaterThan(0);
  });

  // An archive changes which documents are findable without changing any
  // document, so the observing replica gets no content update to react to. If
  // only the acting replica reconciled its index, every other one would answer
  // search from rows the directory stopped agreeing with — and a restore would
  // never come back, because nothing else re-indexes a document already
  // attached.
  it("follows an archive and a restore on a second replica, with no content edit", async () => {
    const running = await hub();
    const author = await serverOn(running.port);
    const doc = await author.ok("create_doc", {
      title: "Concepts",
      description: "A test document.",
      blocks: [{ type: "paragraph", text: "a glossary of pangolin terms" }],
    });
    await waitForQuiet(author);

    const observer = await serverOn(running.port, {
      databasePath: tempDatabasePath(),
    });
    await waitUntil("the second replica to index the document", async () => {
      const hits = await observer.ok("search", { query: "pangolin" });
      return hits.hits.length === 1;
    });

    await author.ok("archive_doc", { uuid: doc.uuid });
    await waitUntil("the archive to reach the second replica", async () => {
      const hits = await observer.ok("search", { query: "pangolin" });
      return hits.hits.length === 0;
    });
    expect((await observer.ok("list_docs", {})).docs).toEqual([]);

    await author.ok("restore_doc", { uuid: doc.uuid });
    await waitUntil("the restore to reach the second replica", async () => {
      const hits = await observer.ok("search", { query: "pangolin" });
      return hits.hits.length === 1;
    });
    expect(
      (await observer.ok("list_docs", {})).docs.map(
        (entry: { uuid: string }) => entry.uuid,
      ),
    ).toEqual([doc.uuid]);
  });

  it("makes concurrent first calls wait for the same hydration", async () => {
    const running = await hub();
    const author = await serverOn(running.port);
    const first = await author.ok("create_doc", {
      title: "Gamma",
      description: "A test document.",
      blocks: [{ type: "paragraph", text: "a wandering wombat" }],
    });
    const second = await author.ok("create_doc", { title: "Delta", description: "A test document." });
    await waitForQuiet(author);

    // Every one of these is a *first* call on an empty replica set: they all
    // trigger the boot settle at once. Each must answer from the hydrated
    // corpus — a caller that sails past the in-flight settle would return an
    // empty directory or an empty index.
    //
    // The one rig here that cannot wait for hydration first: waiting would make
    // these calls something other than first calls, which is the whole claim.
    // So the settle gets room instead — see LIVE_HUB_SETTLE.
    const fresh = await serverOn(running.port, {
      databasePath: tempDatabasePath(),
      ...LIVE_HUB_SETTLE,
    });
    const [docsA, docsB, hits, status] = await Promise.all([
      fresh.ok("list_docs", {}),
      fresh.ok("list_docs", {}),
      fresh.ok("search", { query: "wombat" }),
      fresh.ok("sync_status", {}),
    ]);

    for (const listed of [docsA, docsB]) {
      expect(
        listed.docs.map((doc: { uuid: string }) => doc.uuid).sort(),
      ).toEqual([first.uuid, second.uuid].sort());
    }
    expect(hits.hits.map((hit: { uuid: string }) => hit.uuid)).toEqual([
      first.uuid,
    ]);
    expect(status.hub.status).toBe("connected");
  });

  it("logs remote updates too, and serves them", async () => {
    const running = await hub();
    const databasePath = tempDatabasePath();
    const rig = await serverOn(running.port, { databasePath });

    const created = await rig.ok("create_doc", {
      title: "Shared",
      description: "A test document.",
      blocks: [{ type: "paragraph", text: "written by the agent" }],
    });
    await waitForQuiet(rig);

    // The web UI's side of the story: a second client appends a block.
    const room = `${WORKSPACE}/${created.uuid}`;
    const other = await peer(running.port, room);
    await other.synced;
    await waitUntil("the second client to see the agent's block", () =>
      getBlocks(other.doc).length === 1,
    );
    appendBlock(other.doc, { type: "paragraph", text: "written by a human" });

    await waitUntil("the agent's replica to see the human's block", async () => {
      const read = await rig.ok("get_doc", { uuid: created.uuid });
      return read.blocks.length === 2;
    });

    const read = await rig.ok("get_doc", { uuid: created.uuid });
    expect(read.blocks.map((block: { text: string }) => block.text)).toEqual([
      "written by the agent",
      "written by a human",
    ]);

    // The invariant: the log records every update, remote origin included.
    const db = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const origins = db
        .prepare("SELECT origin, COUNT(*) AS n FROM updates WHERE room = ? GROUP BY origin")
        .all(room) as { origin: string; n: number }[];
      const byOrigin = new Map(origins.map((row) => [row.origin, row.n]));
      expect(byOrigin.get("local") ?? 0).toBeGreaterThan(0);
      expect(byOrigin.get("remote") ?? 0).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });

  it("converges a TL;DR between the MCP tool and another connected client", async () => {
    const running = await hub();
    const rig = await serverOn(running.port);
    const created = await rig.ok("create_doc", {
      title: "Shared summary",
      description: "A document used to prove metadata convergence.",
    });
    await waitForQuiet(rig);

    const other = await peer(running.port, `${WORKSPACE}/${created.uuid}`);
    await other.synced;

    await rig.ok("set_tldr", {
      uuid: created.uuid,
      tldr: "Written through MCP.",
    });
    await waitUntil("the connected client to see the MCP TL;DR", () =>
      getMeta(other.doc).tldr === "Written through MCP.",
    );

    setTldr(other.doc, "Written by the connected client.");
    await waitUntil("the MCP replica to see the client's TL;DR", async () =>
      (await rig.ok("get_doc", { uuid: created.uuid })).tldr ===
      "Written by the connected client.",
    );
  });

  it("does not stamp a document for an edit that merely arrived", async () => {
    const running = await hub();
    // Every stored stamp reads as stale on this server, so authorship is the
    // only thing left that can decide whether it stamps. `updatedAt` says when
    // someone changed the document, not when a replica watched it change: the
    // human's own client stamps for the human's edit, and this one must not
    // stamp for having received it (#544). The coarseness window itself is the
    // timestamps suite's business, which is why it is out of the way here.
    const rig = await serverOn(running.port, { updatedAtCoarsenessMs: 0 });
    const created = await rig.ok("create_doc", {
      title: "Shared",
      description: "A test document.",
      blocks: [{ type: "paragraph", text: "written by the agent" }],
    });
    const stamped = (await rig.ok("list_docs", {})).docs[0].updatedAt;
    expect(stamped).toEqual(expect.any(Number));
    await waitForQuiet(rig);

    const other = await peer(running.port, `${WORKSPACE}/${created.uuid}`);
    await other.synced;
    await waitUntil("the second client to see the agent's block", () =>
      getBlocks(other.doc).length === 1,
    );
    appendBlock(other.doc, { type: "paragraph", text: "written by a human" });
    await waitUntil("the agent's replica to see the human's block", async () => {
      const read = await rig.ok("get_doc", { uuid: created.uuid });
      return read.blocks.length === 2;
    });

    expect((await rig.ok("list_docs", {})).docs[0].updatedAt).toBe(stamped);
  });

  it.each([-1, 1])("reports a protocol skew (%s) as update-required, and keeps serving", async (offset) => {
    // A hub from another release. The version is compared for exact equality
    // and refused before the token, so this is not a credential problem and no
    // retry reaches past it — which is the whole reason it is its own status.
    const running = await hub({ protocolVersion: SYNC_PROTOCOL_VERSION + offset });
    const rig = await serverOn(running.port);

    await waitUntil("the hub to refuse the protocol version", async () => {
      const status = await rig.ok("sync_status", {});
      return status.hub.status === "update-required";
    });

    const status = await rig.ok("sync_status", {});
    // Both integers and, in words, which side is old: a person who can only see
    // one of the two numbers cannot tell what to update.
    expect(status.hub.protocolVersion).toBe(SYNC_PROTOCOL_VERSION);
    expect(status.hub.hubProtocolVersion).toBe(SYNC_PROTOCOL_VERSION + offset);
    expect(status.hub.reason).toContain(offset > 0 ? "update this client" : "update the hub");
    expect(status.rooms.every((room: { synced: boolean }) => !room.synced)).toBe(true);

    // Refused on the wire, and still a working replica: this is the property
    // that makes the refusal safe to be strict about.
    const created = await rig.ok("create_doc", {
      title: "Written against a hub that refuses us",
      description: "A test document.",
    });
    const read = await rig.ok("get_doc", { uuid: created.uuid });
    expect(read.title).toBe("Written against a hub that refuses us");
  });

  it("mints nothing more, even for a hub that restarts willing to accept it", async () => {
    // The strong form of terminal. A skew is not a connection fault, so neither
    // losing the transport nor the hub coming back as a build that *would*
    // accept us may put another token on the wire: a client told it is the
    // wrong version does not become the right one by reconnecting, and only a
    // restart of this process re-reads that.
    const records: HubLogRecord[] = [];
    const databasePath = tempDatabasePath();
    const log = (record: HubLogRecord) => {
      records.push(record);
    };
    const first = await hub({
      databasePath,
      log,
      protocolVersion: SYNC_PROTOCOL_VERSION + 1,
    });
    const port = first.port;
    const rig = await serverOn(port);

    await waitUntil("the hub to refuse the protocol version", async () => {
      const seen = await rig.ok("sync_status", {});
      return seen.hub.status === "update-required";
    });
    const session = (await rig.ok("sync_status", {})).session;
    // Minting is the thing being claimed about, so it is what is counted. The
    // hub's log alone cannot carry this claim: a hub that logged nothing cannot
    // tell a client that stopped from one whose reconnect has not come round
    // yet, which is exactly the delayed re-offer this test has to catch.
    const sync = rig.instance.replicas.sync;
    const mintedByThen = sync.mintCount;
    expect(mintedByThen).toBeGreaterThan(0);

    // The transport goes, and the hub comes back on the same address speaking
    // *our* version — the most inviting thing that can happen to a client that
    // is still trying.
    await hubs.pop()?.stop();
    records.length = 0;
    const second = await hub({ port, databasePath, log });
    expect(second.port).toBe(port);

    // A fresh client authenticating proves the new hub is up and serving, so
    // the silence below is the client's and not the hub's.
    const peer = await peerClient(port, `${WORKSPACE}/_directory`);
    peers.push(peer);
    await peer.synced;

    // And then past a full retry window, because the failure this guards is a
    // *delayed* re-offer: the socket's backoff is capped at
    // `reconnectMaxDelayMs`, so a client still trying has had its chance by
    // twice that. Derived from the configuration rather than picked.
    await sleep(rig.config.reconnectMaxDelayMs * 2);

    // And a brand-new room, which is the one thing that would still put a token
    // on this reconnected socket: `create_doc` attaches its rooms, so without
    // the terminal guard the attach mints and the hub logs the refusal. This is
    // what gives the assertion below teeth — the reconnect alone does not, since
    // a Hocuspocus provider that has been refused does not re-authenticate on
    // its own.
    await rig.ok("create_doc", {
      title: "A room that would attach",
      description: "A test document.",
    });
    await sleep(rig.config.reconnectMaxDelayMs * 2);

    expect(sync.mintCount).toBe(mintedByThen);
    // And nothing of ours reached the hub either — the same claim from the far
    // side, where a mint we somehow missed would still show up.
    expect(
      records.filter(
        (record) =>
          record.event === "hub.auth.accepted" && record.sub === session,
      ),
    ).toEqual([]);
    expect(records.filter((r) => r.cause === "protocol-mismatch")).toEqual([]);

    const status = await rig.ok("sync_status", {});
    expect(status.hub.status).toBe("update-required");
  });

  it("settles at once under a mismatch instead of waiting out the budget", async () => {
    // `waitForQuiet` used to wait the full sync budget here: the socket stayed
    // connected and no room ever synced, so every tool call — and every fresh
    // `inspectRemote` probe — paid the whole timeout to learn what the first
    // refusal already knew.
    const running = await hub({ protocolVersion: SYNC_PROTOCOL_VERSION + 1 });
    const rig = await serverOn(running.port, { syncTimeoutMs: 30_000 });

    await waitUntil("the hub to refuse the protocol version", async () => {
      const seen = await rig.ok("sync_status", {});
      return seen.hub.status === "update-required";
    });

    const started = Date.now();
    await rig.ok("sync_status", {});
    // A wide margin against a 30s budget: this asserts "did not wait", not a
    // particular speed, so a loaded machine cannot turn it red.
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("reports the client's own protocol version even with the hub down", async () => {
    // Nothing to compare against, and the number is still the one a person has
    // to quote when they ask why two machines disagree.
    const rig = await serverOn(1, {});
    await waitUntil("the hub to be given up on", async () => {
      const seen = await rig.ok("sync_status", {});
      return seen.hub.status === "hub-down";
    });

    const status = await rig.ok("sync_status", {});

    expect(status.hub.protocolVersion).toBe(SYNC_PROTOCOL_VERSION);
    // Absent, not zero: a hub that has not refused us has not said what it
    // speaks, and inventing a number here would be a guess on a status line.
    expect(status.hub.hubProtocolVersion).toBeUndefined();
  });

  it("reports a rejected token as auth-failed, and keeps serving", async () => {
    const running = await hub();
    const wrongSecret = "a-different-secret-the-hub-will-not-accept";
    const rig = await serverOn(running.port, { authSecret: wrongSecret });

    await waitUntil("the hub to reject the token", async () => {
      const status = await rig.ok("sync_status", {});
      return status.hub.status === "auth-failed";
    });

    const status = await rig.ok("sync_status", {});
    expect(status.hub.status).toBe("auth-failed");
    // Composed locally, never the endpoint's own words: the thing it is
    // rejecting is a token we just sent it, and this reason is rendered by every
    // consumer — tool result, `ub status`, stderr log. A hostile or careless hub
    // must not get to put text there, let alone echo the credential back.
    expect(status.hub.reason).toBe(
      "the hub rejected this client's token: the secret is wrong, or this hub is " +
        "older than this client — update the hub",
    );
    expect(status.hub.reason).not.toContain(wrongSecret);

    // A rejected token is a sync problem, never a local one.
    const created = await rig.ok("create_doc", { title: "Still writable", description: "A test document." });
    expect(created.applied).toBe(true);
    expect(created.synced).toBe(false);
    expect(created.hub.status).toBe("auth-failed");
    expect((await rig.ok("get_doc", { uuid: created.uuid })).title).toBe(
      "Still writable",
    );

    // Past the rebuilds a refusal schedules: still a refusal, never a hub that
    // merely looks slow.
    await sleep(rig.config.reconnectMaxDelayMs * 3);
    expect((await rig.ok("sync_status", {})).hub.status).toBe("auth-failed");
  });
});
