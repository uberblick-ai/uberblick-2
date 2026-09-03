/**
 * Connected, hub gone, same hub back.
 *
 * The offline-first suites cover a hub that was never up and then comes up.
 * This one covers the other order, which is the one a deploy produces: two
 * servers already syncing when the hub they are on stops, and a hub on the same
 * port, database and secret a moment later. The stop closes the shared socket,
 * while other server paths can close or refuse one room without closing it — so
 * a client that treats either event as final can keep a socket to a process that
 * is gone, report itself connected or `auth-failed` and never sync again.
 *
 * What the tests defend, then, is that the restart is invisible except in
 * timing — and that the retry which makes that true does not turn a wrong
 * secret into a hub that is merely slow.
 */

import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { Hub, HubLogRecord } from "@uberblick/hub";
import {
  hubUrl,
  LIVE_HUB_SETTLE,
  removeTempDirs,
  sleep,
  startHub,
  startServer,
  tempDatabasePath,
  testConfig,
  TEST_SECRET,
  waitUntil,
  WORKSPACE,
} from "./helpers.js";
import type { HubOptions, Rig, TestConfigOptions } from "./helpers.js";

const hubs: Hub[] = [];
const rigs: Rig[] = [];

afterEach(async () => {
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
      ...LIVE_HUB_SETTLE,
      ...options,
      authSecret: options.authSecret ?? TEST_SECRET,
      hubUrl: hubUrl(port),
    }),
  );
  rigs.push(rig);
  return rig;
}

/**
 * Wait until a server can read `text` in the document — which is also what
 * opens that document's room on that server, so a reader ends up holding the
 * same rooms as the writer.
 */
async function waitForBlock(
  rig: Rig,
  uuid: string,
  text: string,
  label: string,
): Promise<void> {
  await waitUntil(`${label} to hold the block "${text}"`, async () => {
    const read = await rig.call("get_doc", { uuid });
    if (read.isError) {
      return false;
    }
    return (read.payload.blocks as { text: string }[]).some(
      (block) => block.text === text,
    );
  });
}

/**
 * Replace a room's stored update with bytes Yjs cannot decode, in a hub
 * database nothing is holding open.
 *
 * What it buys is a room the hub refuses *after* accepting the token for it:
 * `onLoadDocument` throws, and Hocuspocus answers a failed document load with
 * the same `permission-denied` it answers a bad token with. That is the shape
 * a hub on its way out produces for a room it is unloading — here it is made
 * permanent, and confined to one room, so the rooms beside it stay healthy.
 */
function poisonRoom(databasePath: string, room: string): void {
  const db = new DatabaseSync(databasePath);
  try {
    const changed = db
      .prepare(`UPDATE "documents" SET data = $data WHERE name = $name`)
      .run({ data: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]), name: room });
    // The row has to exist, or the test would be proving nothing at all.
    if (changed.changes !== 1) {
      throw new Error(`no stored document for room ${room}`);
    }
  } finally {
    db.close();
  }
}

/** Wait until a server reports everything it holds has reached the hub. */
async function waitForSynced(rig: Rig, label: string): Promise<void> {
  await waitUntil(`${label} to report itself in sync with the hub`, async () => {
    const status = await rig.ok("sync_status", {});
    return (
      status.hub.status === "connected" &&
      status.pendingRooms.length === 0 &&
      status.unsyncedChanges === 0
    );
  });
}

describe("a hub that restarts under connected servers", () => {
  it("brings both of them back and converges on a write made afterwards", async () => {
    const database = tempDatabasePath();
    const first = await hub({ databasePath: database });
    const port = first.port;

    const here = await serverOn(port);
    const there = await serverOn(port);

    const doc = await here.ok("create_doc", {
      title: "Open across the restart",
      description: "A test document.",
      blocks: [{ type: "paragraph", text: "written before the restart" }],
    });
    // Both replicas hold the document — and, because they do, both have its
    // room open on the hub that is about to go away.
    await waitForBlock(
      there,
      doc.uuid,
      "written before the restart",
      "the reader",
    );
    await waitForSynced(here, "the writer");
    await waitForSynced(there, "the reader");

    await first.stop();
    hubs.splice(hubs.indexOf(first), 1);
    const second = await hub({ port, databasePath: database });
    expect(second.port).toBe(port);

    // The write comes from the server that was only reading, so a hub that
    // never took it back would be visible from either side.
    const inserted = await there.ok("insert_block", {
      uuid: doc.uuid,
      type: "paragraph",
      text: "written after the restart",
    });
    expect(inserted.applied).toBe(true);

    await waitForBlock(
      here,
      doc.uuid,
      "written after the restart",
      "the writer, through the restarted hub,",
    );

    // Only now is this worth asserting: a socket to the hub that stopped also
    // reports `connected` with nothing pending, and says so for as long as it
    // takes the provider's own dead-connection timeout to notice.
    for (const [rig, label] of [
      [here, "the writer"],
      [there, "the reader"],
    ] as const) {
      const status = await rig.ok("sync_status", {});
      expect([label, status.hub.status]).toEqual([label, "connected"]);
      expect([label, status.pendingRooms]).toEqual([label, []]);
    }
  });

  it("spends its rebuilds and stops when one room is refused for good", async () => {
    const database = tempDatabasePath();
    const first = await hub({ databasePath: database });
    const port = first.port;

    const here = await serverOn(port);
    const doomed = await here.ok("create_doc", {
      title: "The document the hub will not load",
      description: "A test document.",
      blocks: [{ type: "paragraph", text: "stored before it was poisoned" }],
    });
    await waitForSynced(here, "the writer");

    // Stop, poison one room, start again on the same port and database. From
    // here on the hub accepts this server's token and refuses that one room —
    // the case where rebuilding forever is worse than stopping, because the
    // rooms beside it are working and every rebuild tears them down too.
    await first.stop();
    hubs.splice(hubs.indexOf(first), 1);
    poisonRoom(database, `${WORKSPACE}/${doomed.uuid}`);

    const records: HubLogRecord[] = [];
    await hub({
      port,
      databasePath: database,
      log: (record) => records.push(record),
    });

    // One record per connection this server completes with the restarted hub:
    // a rebuild re-authenticates every room, the healthy directory room
    // included, so counting that room counts connections.
    const connections = (): number =>
      records.filter(
        (record) =>
          record.event === "hub.auth.accepted" &&
          record.sub === here.config.sessionId &&
          record.room === `${WORKSPACE}/_directory`,
      ).length;

    // MAX_REBUILDS in ../src/sync.ts. Written out rather than imported: the
    // bound is what this test is about, so a change to it should read here. It
    // counts rebuilds after the restarted hub's first refused connection.
    const bound = 1 + 3;
    await waitUntil(
      "the refused room to spend every rebuild its connection had",
      () => connections() >= bound,
    );
    const spent = connections();
    // Six rebuild windows at this rig's 250ms cap — where a rebuild budget
    // that resets on every accepted token would show itself as a re-dial storm.
    await sleep(1_500);
    expect(connections()).toBe(spent);
    expect(spent).toBe(bound);

    // The rooms beside the refused one never stopped working: a write made
    // after the bound bound reaches a replica that has never seen this hub.
    const kept = await here.ok("create_doc", {
      title: "Written while the other room was refused",
      description: "A test document.",
      blocks: [{ type: "paragraph", text: "the healthy rooms still carry writes" }],
    });
    const there = await serverOn(port);
    await waitForBlock(
      there,
      kept.uuid,
      "the healthy rooms still carry writes",
      "a replica that has only ever seen the restarted hub",
    );

    const roomsOf = (status: {
      rooms: { room: string; synced: boolean }[];
    }): Map<string, boolean> =>
      new Map(status.rooms.map((entry) => [entry.room, entry.synced]));

    await waitUntil("the healthy room to report itself synced", async () => {
      const status = await here.ok("sync_status", {});
      return roomsOf(status).get(`${WORKSPACE}/${kept.uuid}`) === true;
    });

    // And the answer stays honest room by room: the refused one is not synced,
    // the healthy one is, and the document is still readable, because the local
    // replica rather than the hub is the authoritative copy. `hub.status` is
    // deliberately not asserted — it answers for the whole socket, which really
    // is up and carrying every other room, and whether a later room's handshake
    // has cleared the refusal flag by now is a race with no right answer to
    // pin. Where a refused room shows is `rooms`.
    const status = await here.ok("sync_status", {});
    expect(roomsOf(status).get(`${WORKSPACE}/${kept.uuid}`)).toBe(true);
    expect(roomsOf(status).get(`${WORKSPACE}/${doomed.uuid}`)).toBe(false);
    const read = await here.ok("get_doc", { uuid: doomed.uuid });
    expect((read.blocks as { text: string }[]).map((block) => block.text)).toEqual([
      "stored before it was poisoned",
    ]);
  });

  it("still reports a wrong secret as auth-failed, retries and all", async () => {
    const running = await hub();
    const rig = await serverOn(running.port, {
      authSecret: "a-different-secret-the-hub-will-not-accept",
    });

    await waitUntil("the hub to refuse the token", async () => {
      const status = await rig.ok("sync_status", {});
      return status.hub.status === "auth-failed";
    });

    // Long enough for every rebuild a refusal schedules to have been made and
    // refused again (three, each capped at this rig's 250ms reconnect delay).
    // A refusal is retried; it is never retried into silence.
    await sleep(1_500);

    const status = await rig.ok("sync_status", {});
    expect(status.hub.status).toBe("auth-failed");
    expect(status.hub.reason).toBe(
      "the hub rejected this client's token: the secret is wrong, or this hub is " +
        "older than this client — update the hub",
    );
  });
});
