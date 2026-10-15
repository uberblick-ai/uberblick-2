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
import { afterEach, describe, expect, it } from "vitest";
import { getMeta } from "@uberblick/schema";
import type { Hub } from "@uberblick/hub";
import { cleanupTestResources, hubUrl, startHub, startServer, tempDatabasePath, testConfig, waitUntil, TEST_SECRET } from "./helpers.js";
import type { Rig } from "./helpers.js";

const rigs: Rig[] = [];
const hubs: Hub[] = [];

/** The stub `list_docs` and the sidebar read, without opening the document. */

async function listedTitle(rig: Rig, uuid: string): Promise<string | undefined> {
  const listed = await rig.ok("list_docs");
  return listed.docs.find((row: { uuid: string }) => row.uuid === uuid)?.title;
}

afterEach(async () => {
  await cleanupTestResources({
    clients: rigs.splice(0).map((client) => () => client.close()),
    hubs: hubs.splice(0).map((hub) => () => hub.stop()),
  });
});

describe("set_metadata", () => {

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
