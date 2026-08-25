/**
 * Two workspaces, one hub, two corpora that never meet (#151).
 *
 * The separation is not a feature this package implements — it falls out of the
 * room key carrying the workspace (`<workspaceId>/<docUuid>`) and of the
 * database being named after it. That is exactly why it is worth a test: a
 * mechanism nobody wrote is a mechanism nobody notices breaking. A default
 * workspace slipping back in, a room key built from something other than the
 * config, a shared database file — each would silently *union* two corpora,
 * because the directory is a Y.Map keyed by document uuid and disjoint keys
 * merge without conflict, without error and without a way back.
 *
 * So this runs two real servers against one real hub and asks the four
 * questions an agent would ask: what is in the workspace, can I read that other
 * document, does search see it, does it link here. Both servers are synced and
 * quiet before anything is asserted, and a plain second client confirms the
 * *hub* holds both corpora — otherwise "disjoint" could just be a delivery that
 * never happened, which would pass this test while proving nothing.
 */

import { existsSync } from "node:fs";
import { basename, dirname } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { directoryRoom, listDirectory, parseWorkspaceId } from "@uberblick/schema";
import type { Hub } from "@uberblick/hub";
import { defaultDatabasePath } from "../src/config.js";
import {
  hubUrl,
  peerClient,
  removeTempDirs,
  startHub,
  startServer,
  tempDir,
  testConfig,
  TEST_SECRET,
  waitUntil,
} from "./helpers.js";
import type { PeerClient, Rig } from "./helpers.js";

/** Two workspaces, spelled the way a person would configure each of them. */
const UBERBLICK_UUID = "1a5e7c30-9d64-4b12-8f7a-2c0b6e9d4a11";
const ABLAUF_UUID = "b2d9e4c7-5a13-4f80-8e6b-71c0a9d35f2e";
const UBERBLICK = `uberblick-${UBERBLICK_UUID}`;
const ABLAUF = `ablauf-${ABLAUF_UUID}`;

const hubs: Hub[] = [];
const rigs: Rig[] = [];
const peers: PeerClient[] = [];

afterEach(async () => {
  for (const peer of peers.splice(0)) peer.destroy();
  for (const rig of rigs.splice(0)) await rig.close();
  for (const hub of hubs.splice(0)) await hub.stop().catch(() => {});
  removeTempDirs();
});

/**
 * A server for one workspace, configured from the decorated spelling a person
 * would write.
 *
 * The two derivations are the ones `resolveMcpConfig` makes from `WORKSPACE_ID`
 * — the slug parsed off for the identity, and the database resolved to the real
 * `<data home>/uberblick/<uuid>.sqlite` (config.test.ts pins that it does).
 * Both workspaces share one data home on purpose: giving each a temp file of
 * its own would assume the separation this test exists to check.
 */
async function serverFor(
  workspaceId: string,
  port: number,
  dataHome: string,
): Promise<Rig> {
  const rig = await startServer(
    testConfig({
      workspaceId: parseWorkspaceId(workspaceId).uuid,
      authSecret: TEST_SECRET,
      hubUrl: hubUrl(port),
      databasePath: defaultDatabasePath(workspaceId, { XDG_DATA_HOME: dataHome }),
    }),
  );
  rigs.push(rig);
  return rig;
}

/** Wait until the server reports everything it holds has reached the hub. */
async function waitForQuiet(rig: Rig): Promise<void> {
  await waitUntil(`${rig.config.workspaceId} to report itself in sync`, async () => {
    const status = await rig.ok("sync_status", {});
    return (
      status.hub.status === "connected" &&
      status.unsyncedChanges === 0 &&
      status.pendingRooms.length === 0
    );
  });
}

describe("two workspaces on one hub", () => {
  it("keeps the corpora apart: directory, documents, search, backlinks and database", async () => {
    const running = await startHub();
    hubs.push(running);
    const dataHome = tempDir();
    const uberblick = await serverFor(UBERBLICK, running.port, dataHome);
    const ablauf = await serverFor(ABLAUF, running.port, dataHome);

    const roadmap = await uberblick.ok("create_doc", {
      title: "Uberblick roadmap",
      blocks: [{ type: "paragraph", text: "a shared word: corpus" }],
    });
    const kickoff = await ablauf.ok("create_doc", {
      title: "Ablauf kickoff",
      blocks: [{ type: "paragraph", text: "a shared word: corpus" }],
    });
    const backlog = await ablauf.ok("create_doc", {
      title: "Ablauf backlog",
      blocks: [{ type: "paragraph", text: "everything after the kickoff" }],
    });
    await ablauf.ok("set_links", { uuid: backlog.uuid, links: [kickoff.uuid] });

    await waitForQuiet(uberblick);
    await waitForQuiet(ablauf);

    // The hub holds both corpora — read by a client that is neither server. So
    // what follows is a corpus this hub could have delivered and did not,
    // rather than a write that never arrived.
    const onTheHub = await peerClient(running.port, directoryRoom(ABLAUF_UUID));
    peers.push(onTheHub);
    await waitUntil("ablauf's directory to reach a second client", () =>
      listDirectory(onTheHub.doc).some((entry) => entry.uuid === kickoff.uuid),
    );

    // ---- the directory ----
    const here = await uberblick.ok("list_docs", {});
    expect(here.workspace).toBe(UBERBLICK_UUID);
    expect(here.docs.map((doc: { uuid: string }) => doc.uuid)).toEqual([
      roadmap.uuid,
    ]);

    const there = await ablauf.ok("list_docs", {});
    expect(there.workspace).toBe(ABLAUF_UUID);
    expect(
      there.docs.map((doc: { uuid: string }) => doc.uuid).sort(),
    ).toEqual([kickoff.uuid, backlog.uuid].sort());

    // ---- the documents themselves ----
    // Not "empty" and not "waiting": the other workspace's uuid is not a
    // document here at all, and the failure says which workspace it looked in.
    const across = await uberblick.call("get_doc", { uuid: kickoff.uuid });
    expect(across.isError).toBe(true);
    expect(JSON.stringify(across.payload)).toContain(UBERBLICK_UUID);
    await uberblick.ok("get_doc", { uuid: roadmap.uuid });

    // ---- search ----
    // The same words in both corpora, so a hit could only come from the index
    // having seen the other workspace's blocks.
    const found = await ablauf.ok("search", { query: "corpus" });
    expect(found.hits.map((hit: { uuid: string }) => hit.uuid)).toEqual([
      kickoff.uuid,
    ]);
    const mine = await uberblick.ok("search", { query: "corpus" });
    expect(mine.hits.map((hit: { uuid: string }) => hit.uuid)).toEqual([
      roadmap.uuid,
    ]);

    // ---- backlinks ----
    expect(
      (await ablauf.ok("backlinks", { uuid: kickoff.uuid })).backlinks.map(
        (link: { uuid: string }) => link.uuid,
      ),
    ).toEqual([backlog.uuid]);
    expect(
      (await uberblick.ok("backlinks", { uuid: kickoff.uuid })).backlinks,
    ).toEqual([]);

    // ---- the rooms, and the databases ----
    const status = await uberblick.ok("sync_status", {});
    const rooms = status.rooms.map((room: { room: string }) => room.room);
    // Including `_directory`: discovery is a synced doc like any other, so it
    // is per-workspace by construction rather than by a rule anybody enforces.
    expect(rooms).toContain(`${UBERBLICK_UUID}/_directory`);
    expect(
      rooms.every((room: string) => room.startsWith(`${UBERBLICK_UUID}/`)),
    ).toBe(true);

    const databases = [uberblick.config.databasePath, ablauf.config.databasePath];
    expect(databases[0]).not.toBe(databases[1]);
    expect(databases.map((path) => basename(path))).toEqual([
      `${UBERBLICK_UUID}.sqlite`,
      `${ABLAUF_UUID}.sqlite`,
    ]);
    // One data home, two files: the workspace is the whole difference.
    expect(dirname(databases[0] as string)).toBe(dirname(databases[1] as string));
    for (const path of databases) expect(existsSync(path)).toBe(true);
  }, 30_000);
});
