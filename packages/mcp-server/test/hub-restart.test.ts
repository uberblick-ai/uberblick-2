/**
 * Connected, hub gone, same hub back.
 *
 * The offline-first suites cover a hub that was never up and then comes up.
 * This one covers the other order, which is the one a deploy produces: two
 * servers already syncing when the hub they are on stops, and a hub on the same
 * port, database and secret a moment later. A hub closes each room it is
 * unloading without closing the socket underneath, and it can refuse a room it
 * is in the middle of dropping — so a client that treats either as final keeps
 * a socket to a process that is gone, reports itself connected or `auth-failed`
 * and never syncs again.
 *
 * What the tests defend, then, is that the restart is invisible except in
 * timing — and that the retry which makes that true does not turn a wrong
 * secret into a hub that is merely slow.
 */

import { afterEach, describe, expect, it } from "vitest";
import type { Hub } from "@uberblick/hub";
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
} from "./helpers.js";
import type { Rig, TestConfigOptions } from "./helpers.js";

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

async function hub(options: { port?: number; databasePath?: string } = {}) {
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
    expect(status.hub.reason).toBe("authentication rejected by hub");
  });
});
