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
import { pinDoc, readSidebar, upsertDirectoryEntry } from "@uberblick/schema";
import {
  removeTempDirs,
  startServer,
  tempDatabasePath,
  testConfig,
} from "./helpers.js";
import type { Rig } from "./helpers.js";

let rig: Rig | null = null;

async function server(databasePath = tempDatabasePath()): Promise<Rig> {
  rig = await startServer(testConfig({ databasePath }));
  return rig;
}

afterEach(async () => {
  await rig?.close();
  rig = null;
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
  /** The corpus as the legacy tags described it, in no helpful order. */
  async function seedCorpus(rig: Rig): Promise<void> {
    await createDoc(rig, "Architecture", ["reference"]);
    await createDoc(rig, "Install and run", ["start-here"]);
    await createDoc(rig, "Editing and blocks", ["feature"]);
    await createDoc(rig, "Overview", ["start-here"]);
    await createDoc(rig, "Test protocols", ["verify"]);
    await createDoc(rig, "Annotations", ["feature"]);
    await createDoc(rig, "Scratch", []);
  }

  it("reproduces the tag groups once, in the owner's order", async () => {
    const rig = await server();
    await seedCorpus(rig);

    const seeded = await rig.ok("get_sidebar");
    expect(shape(seeded)).toEqual([
      ["Start here", ["Overview", "Install and run"]],
      ["Features", ["Annotations", "Editing and blocks"]],
      ["Verify", ["Test protocols"]],
      ["Reference", ["Architecture"]],
    ]);

    // Idempotent: reading again neither re-seeds nor duplicates a group.
    const again = await rig.ok("get_sidebar");
    expect(again.groups).toEqual(seeded.groups);

    // An untagged document is not curation, and stays out of the sidebar.
    const listed = await rig.ok("list_docs");
    expect(
      listed.docs
        .filter((doc: any) => !doc.pinned)
        .map((doc: any) => doc.title),
    ).toEqual(["Scratch"]);
  });

  it("never writes over a sidebar that already holds curation", async () => {
    const databasePath = tempDatabasePath();
    const first = await server(databasePath);
    await seedCorpus(first);
    const listed = await first.ok("get_sidebar");
    const overview = listed.groups[0].docs[0].uuid as string;
    await first.ok("unpin_doc", { uuid: overview });
    await first.ok("sidebar_group", { action: "delete", group: "Verify" });
    const curated = shape(await first.ok("get_sidebar"));
    expect(curated).toEqual([
      ["Start here", ["Install and run"]],
      ["Features", ["Annotations", "Editing and blocks"]],
      ["Reference", ["Architecture"]],
    ]);
    await first.close();
    rig = null;

    // A restart replays the log: the sidebar is what the agent left, and the
    // seed does not run a second time over it.
    const second = await server(databasePath);
    expect(shape(await second.ok("get_sidebar"))).toEqual(curated);
  });
});
