/**
 * Renaming a document.
 *
 * `meta.title` in the document is authoritative and the directory stub is a
 * cache of it — so what `set_metadata` owes a caller is that both are right when
 * the call returns, that discovery answers from the stub rather than by opening
 * a room, and that two replicas renaming at once end up holding one title
 * rather than two.
 *
 * `create_doc` holds the same rule, so the MCP surface cannot create the state
 * `set_metadata` refuses to leave a document in.
 */

import { afterAll, afterEach, describe, expect, it } from "vitest";
import { getDirectoryEntry, getMeta } from "@uberblick/schema";
import type { Hub } from "@uberblick/hub";
import {
  hubUrl,
  removeTempDirs,
  startHub,
  startServer,
  tempDatabasePath,
  testConfig,
  waitUntil,
  TEST_SECRET,
} from "./helpers.js";
import type { Rig } from "./helpers.js";

const rigs: Rig[] = [];
const hubs: Hub[] = [];

async function localRig(): Promise<Rig> {
  const rig = await startServer(testConfig());
  rigs.push(rig);
  return rig;
}

/** The stub `list_docs` and the sidebar read, without opening the document. */
function stubTitle(rig: Rig, uuid: string): string | undefined {
  return getDirectoryEntry(rig.instance.replicas.directory().doc, uuid)?.title;
}

async function listedTitle(rig: Rig, uuid: string): Promise<string | undefined> {
  const listed = await rig.ok("list_docs");
  return listed.docs.find((row: { uuid: string }) => row.uuid === uuid)?.title;
}

afterEach(async () => {
  for (const rig of rigs.splice(0)) {
    await rig.close();
  }
  for (const hub of hubs.splice(0)) await hub.stop().catch(() => {});
});

afterAll(() => {
  removeTempDirs();
});

describe("set_metadata", () => {
  it("renames the document and the stub in one call, and reports durability", async () => {
    const rig = await localRig();
    const doc = await rig.ok("create_doc", {
      title: "Bring your docs in",
      description: "The starter document nobody got round to naming.",
    });

    const renamed = await rig.ok("set_metadata", {
      uuid: doc.uuid,
      title: "How to use it",
    });
    expect(renamed).toMatchObject({
      uuid: doc.uuid,
      title: "How to use it",
      applied: true,
      // Local-only rig: applied is the durable half, and synced is honest about
      // the hub this write never reached.
      synced: false,
    });

    // The document owns the title; the stub is the cache that follows in the
    // same call, so discovery answers without opening the room.
    expect(getMeta(rig.instance.replicas.replica(doc.uuid).doc).title).toBe(
      "How to use it",
    );
    expect(await listedTitle(rig, doc.uuid)).toBe("How to use it");

    // A rename replaces: the old title is gone from the derived index too.
    const hits = await rig.ok("search", { query: "How to use it" });
    expect(hits.hits.map((hit: { uuid: string }) => hit.uuid)).toContain(
      doc.uuid,
    );
    expect((await rig.ok("search", { query: "Bring" })).hits).toEqual([]);
  });

  it("refuses the empty title and whitespace, and changes nothing", async () => {
    const rig = await localRig();
    const doc = await rig.ok("create_doc", {
      title: "Named",
      description: "A document with a title worth keeping.",
    });

    for (const title of ["", "   "]) {
      const refused = await rig.call("set_metadata", { uuid: doc.uuid, title });
      expect(refused.isError).toBe(true);
    }

    expect(getMeta(rig.instance.replicas.replica(doc.uuid).doc).title).toBe(
      "Named",
    );
    expect(stubTitle(rig, doc.uuid)).toBe("Named");
  });

  it("converges when two replicas rename the same document at once", async () => {
    const hub = await startHub();
    hubs.push(hub);
    const withHub = (databasePath: string) =>
      startServer(
        testConfig({
          databasePath,
          authSecret: TEST_SECRET,
          hubUrl: hubUrl(hub.port),
        }),
      );

    const first = await withHub(tempDatabasePath());
    rigs.push(first);
    const doc = await first.ok("create_doc", {
      title: "Original",
      description: "The document two machines argue about.",
    });
    // A second machine, its own database, which learns the corpus through the
    // hub rather than through a shared log.
    const second = await withHub(tempDatabasePath());
    rigs.push(second);
    await waitUntil(
      "the second replica to see the document",
      async () => (await second.call("get_doc", { uuid: doc.uuid })).isError === false,
    );

    // Neither has seen the other's rename when it makes its own.
    await Promise.all([
      first.ok("set_metadata", { uuid: doc.uuid, title: "Named by the first" }),
      second.ok("set_metadata", { uuid: doc.uuid, title: "Named by the second" }),
    ]);

    const titleOf = (rig: Rig): string =>
      getMeta(rig.instance.replicas.replica(doc.uuid).doc).title;
    await waitUntil(
      "both replicas to hold one title",
      () => titleOf(first) === titleOf(second),
    );
    // One of the two, not a merge of them: a title is a whole value, so the
    // documents agree on whichever update Yjs ordered last.
    const settled = titleOf(first);
    expect(["Named by the first", "Named by the second"]).toContain(settled);

    // And the stubs follow, with no further rename to heal them.
    //
    // This is the whole point of the test: each replica wrote its own stub
    // before it had seen the other's rename, so the directory briefly holds a
    // title one of the documents has already lost. Applying the remote document
    // update is what repairs it — `repairStub` runs on that update, compares the
    // converged `meta.title` against the local stub, and its write is causally
    // after that replica's own stale one, so it wins the directory's
    // last-write-wins. A replica that writes nothing here is one whose stub
    // already agreed.
    for (const rig of [first, second]) {
      await waitUntil(
        `${rig.config.sessionId} to list the settled title`,
        async () => (await listedTitle(rig, doc.uuid)) === settled,
      );
    }
  });
});

describe("create_doc requires a title", () => {
  it("refuses the empty title and whitespace, and creates nothing", async () => {
    const rig = await localRig();
    const before = (await rig.ok("list_docs")).docs.length;

    for (const title of ["", "   "]) {
      const refused = await rig.call("create_doc", {
        title,
        description: "A document that should never come into existence.",
      });
      expect(refused.isError).toBe(true);
      expect(refused.payload.message).toContain(
        "a title cannot be empty or whitespace",
      );
    }

    // The schema rejects before the handler runs, so there is no half-made
    // document and no stub for one — the listing is exactly as it was.
    expect((await rig.ok("list_docs")).docs).toHaveLength(before);
  });
});
